// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IUSDC} from "./interfaces/IUSDC.sol";
import {Authorization, GiftMeta, BeamLimits} from "./lib/BeamTypes.sol";
import {SigLib, MerkleLib} from "./lib/SigLib.sol";

/// @title BeamClaims
/// @notice Claimable gifts for recipients who have no wallet yet: gift-a-chatter and Beam Bomb.
///
/// A "drop" escrows a viewer's USDC across `slots` equal shares. Each slot is locked to a
/// one-time claim key generated in the sender's browser. The claim link carries that key's
/// secret; the chain stores only a Merkle root of `(slot, keyAddress)` leaves (an address is
/// itself a hash of the key). To claim, the key signs the *recipient address*, so a claim
/// seen in a mempool cannot be redirected: changing the recipient invalidates the signature.
/// Claims are relayer-submitted, so recipients need no MON either.
///
/// - Every drop names its `channel`: the creator on whose stream it happened, so the overlay
///   and chat can show it there. The sender signs it like every other parameter.
/// - Gift-a-chatter is a drop with one slot.
/// - A Beam Bomb is a drop with N slots, one claim per recipient account.
/// - The sender can reclaim the unclaimed balance at any time; after expiry anyone can push
///   the unclaimed balance back to the sender.
///
/// There is no owner and no admin path: funds leave only to a valid claimant or to the sender.
contract BeamClaims {
    using BeamLimits for GiftMeta;

    IUSDC public immutable usdc;

    uint32 public constant MAX_SLOTS = 100;
    uint64 public constant MIN_TTL = 10 minutes;
    uint64 public constant MAX_TTL = 30 days;
    uint256 public constant MAX_LABEL_BYTES = 32;

    bytes32 internal constant DROP_TAG = keccak256("Beam.Drop.v1");

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 dropId,uint32 slot,address recipient)");
    bytes32 public constant RECLAIM_TYPEHASH = keccak256("Reclaim(bytes32 dropId,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("BeamClaims");
    bytes32 private constant VERSION_HASH = keccak256("1");

    enum Kind {
        Chatter,
        Bomb
    }

    struct Drop {
        address sender;
        uint64 expiry;
        uint32 slots;
        uint32 claimed;
        Kind kind;
        bool closed;
        uint128 perSlot;
        uint128 remaining;
        bytes32 slotRoot;
        uint256 claimedSlots; // bitmap, MAX_SLOTS <= 256
    }

    /// @notice Parameters of a drop, all committed to by the sender's EIP-3009 nonce.
    struct DropParams {
        address channel; // the creator whose stream this drop happened on
        uint32 slots;
        bytes32 slotRoot;
        uint64 expiry;
        string recipientLabel; // e.g. "@Tunde" for a chatter gift; empty for a bomb
    }

    mapping(bytes32 dropId => Drop) public drops;
    mapping(bytes32 dropId => mapping(address recipient => bool)) public hasClaimed;

    event ChatterGiftSent(
        bytes32 indexed dropId,
        address indexed from,
        address indexed channel,
        uint256 amount,
        string recipientLabel,
        string displayName,
        string message,
        uint16 actionCode,
        uint64 expiry,
        uint64 ts
    );
    event BombSent(
        address indexed from,
        address indexed channel,
        uint256 pool,
        uint32 slots,
        bytes32 indexed bombId,
        string displayName,
        string message,
        uint16 actionCode,
        uint64 expiry,
        uint64 ts
    );
    event Claimed(bytes32 indexed dropId, uint32 slot, address indexed recipient, uint256 amount, uint64 ts);
    event Reclaimed(bytes32 indexed dropId, address indexed sender, uint256 amount, bool expired, uint64 ts);

    error ZeroAddress();
    error BadSlots();
    error BadExpiry();
    error LabelTooLong();
    error AmountTooSmall();
    error DropExists();
    error UnknownDrop();
    error DropClosed();
    error DropExpired();
    error NotExpired();
    error SlotOutOfRange();
    error SlotTaken();
    error AlreadyClaimed();
    error InvalidClaim();
    error NotSender();
    error SignatureExpired();
    error TransferFailed();

    constructor(IUSDC usdc_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    // ------------------------------------------------------------------ views

    /// @notice The EIP-3009 nonce the sender signs; also the drop's id.
    function dropNonce(address from, Kind kind, DropParams calldata p, GiftMeta calldata meta, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DROP_TAG,
                block.chainid,
                address(this),
                from,
                kind,
                p.channel,
                p.slots,
                p.slotRoot,
                p.expiry,
                p.recipientLabel,
                meta.displayName,
                meta.message,
                meta.actionCode,
                salt
            )
        );
    }

    /// @notice Leaf binding a slot index to its claim key address.
    function slotLeaf(uint32 slot, address claimKey) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(slot, claimKey))));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function claimDigest(bytes32 dropId, uint32 slot, address recipient) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator(), keccak256(abi.encode(CLAIM_TYPEHASH, dropId, slot, recipient))
            )
        );
    }

    function reclaimDigest(bytes32 dropId, uint256 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(RECLAIM_TYPEHASH, dropId, deadline)))
        );
    }

    function isSlotClaimed(bytes32 dropId, uint32 slot) external view returns (bool) {
        return drops[dropId].claimedSlots & (uint256(1) << slot) != 0;
    }

    // ------------------------------------------------------------------ create

    /// @notice Gift a chatter who has no wallet: one slot, claimable by whoever holds the link.
    function giftChatter(DropParams calldata p, GiftMeta calldata meta, Authorization calldata auth)
        external
        returns (bytes32 dropId)
    {
        if (p.slots != 1) revert BadSlots();
        dropId = _create(Kind.Chatter, p, meta, auth);
        emit ChatterGiftSent(
            dropId,
            auth.from,
            p.channel,
            auth.value,
            p.recipientLabel,
            meta.displayName,
            meta.message,
            meta.actionCode,
            p.expiry,
            uint64(block.timestamp)
        );
    }

    /// @notice Beam Bomb: a pool split equally across `slots` claim links, one claim per account.
    function bomb(DropParams calldata p, GiftMeta calldata meta, Authorization calldata auth)
        external
        returns (bytes32 bombId)
    {
        if (p.slots < 2) revert BadSlots();
        bombId = _create(Kind.Bomb, p, meta, auth);
        emit BombSent(
            auth.from,
            p.channel,
            auth.value,
            p.slots,
            bombId,
            meta.displayName,
            meta.message,
            meta.actionCode,
            p.expiry,
            uint64(block.timestamp)
        );
    }

    function _create(Kind kind, DropParams calldata p, GiftMeta calldata meta, Authorization calldata auth)
        private
        returns (bytes32 dropId)
    {
        meta.check();
        if (p.channel == address(0)) revert ZeroAddress();
        if (bytes(p.recipientLabel).length > MAX_LABEL_BYTES) revert LabelTooLong();
        if (p.slots > MAX_SLOTS) revert BadSlots();
        if (p.expiry < block.timestamp + MIN_TTL || p.expiry > block.timestamp + MAX_TTL) revert BadExpiry();
        if (auth.value > type(uint128).max) revert AmountTooSmall();
        uint256 perSlot = auth.value / p.slots;
        if (perSlot == 0) revert AmountTooSmall();

        dropId = dropNonce(auth.from, kind, p, meta, auth.salt);
        if (drops[dropId].sender != address(0)) revert DropExists();

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.receiveWithAuthorization(
            auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, dropId, auth.v, auth.r, auth.s
        );
        if (usdc.balanceOf(address(this)) != balanceBefore + auth.value) revert TransferFailed();

        drops[dropId] = Drop({
            sender: auth.from,
            expiry: p.expiry,
            slots: p.slots,
            claimed: 0,
            kind: kind,
            closed: false,
            perSlot: uint128(perSlot),
            remaining: uint128(auth.value),
            slotRoot: p.slotRoot,
            claimedSlots: 0
        });
    }

    // ------------------------------------------------------------------ claim

    /// @notice Pay one slot to `recipient`. `claimSig` is the slot's claim key signing
    /// `Claim(dropId, slot, recipient)`; `proof` places that key in the drop's slot root.
    /// Anyone may submit (Beam's relayer does), but only `recipient` can be paid.
    function claim(bytes32 dropId, uint32 slot, address recipient, bytes32[] calldata proof, bytes calldata claimSig)
        external
    {
        Drop storage d = drops[dropId];
        if (d.sender == address(0)) revert UnknownDrop();
        if (d.closed) revert DropClosed();
        if (block.timestamp >= d.expiry) revert DropExpired();
        if (slot >= d.slots) revert SlotOutOfRange();
        uint256 bit = uint256(1) << slot;
        if (d.claimedSlots & bit != 0) revert SlotTaken();
        if (recipient == address(0)) revert ZeroAddress();
        if (hasClaimed[dropId][recipient]) revert AlreadyClaimed();

        address claimKey = SigLib.recover(claimDigest(dropId, slot, recipient), claimSig);
        if (claimKey == address(0) || !MerkleLib.verify(proof, d.slotRoot, slotLeaf(slot, claimKey))) {
            revert InvalidClaim();
        }

        uint256 amount = d.perSlot;
        d.claimedSlots |= bit;
        d.claimed += 1;
        d.remaining -= uint128(amount);
        hasClaimed[dropId][recipient] = true;

        // Once every slot is paid, rounding dust (< slots base units) goes back to the sender.
        uint256 dust;
        if (d.claimed == d.slots) {
            d.closed = true;
            dust = d.remaining;
            d.remaining = 0;
        }

        _pay(recipient, amount);
        emit Claimed(dropId, slot, recipient, amount, uint64(block.timestamp));
        if (dust != 0) {
            _pay(d.sender, dust);
            emit Reclaimed(dropId, d.sender, dust, false, uint64(block.timestamp));
        }
    }

    // ------------------------------------------------------------------ reclaim

    /// @notice Sender takes back everything unclaimed, any time before the drop is closed.
    function reclaim(bytes32 dropId) external {
        Drop storage d = drops[dropId];
        if (msg.sender != d.sender) revert NotSender();
        _close(dropId, d, false);
    }

    /// @notice Gasless reclaim: the sender signs `Reclaim(dropId, deadline)`, a relayer submits.
    function reclaimBySig(bytes32 dropId, uint256 deadline, bytes calldata senderSig) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        Drop storage d = drops[dropId];
        address signer = SigLib.recover(reclaimDigest(dropId, deadline), senderSig);
        if (signer == address(0) || signer != d.sender) revert NotSender();
        _close(dropId, d, false);
    }

    /// @notice After expiry anyone may return the unclaimed balance to the sender.
    function refundExpired(bytes32 dropId) external {
        Drop storage d = drops[dropId];
        if (d.sender == address(0)) revert UnknownDrop();
        if (block.timestamp < d.expiry) revert NotExpired();
        _close(dropId, d, true);
    }

    function _close(bytes32 dropId, Drop storage d, bool expired) private {
        if (d.sender == address(0)) revert UnknownDrop();
        if (d.closed) revert DropClosed();
        uint256 amount = d.remaining;
        d.closed = true;
        d.remaining = 0;
        _pay(d.sender, amount);
        emit Reclaimed(dropId, d.sender, amount, expired, uint64(block.timestamp));
    }

    function _pay(address to, uint256 amount) private {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
