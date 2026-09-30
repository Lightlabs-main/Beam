// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IUSDC} from "./interfaces/IUSDC.sol";
import {Authorization, GiftMeta, BeamLimits} from "./lib/BeamTypes.sol";

/// @title BeamGifts
/// @notice Non-custodial live gifts in USDC, settled gaslessly via EIP-3009.
///
/// - `giftCreator`: the viewer's USDC moves straight to the creator inside USDC's own
///   `transferWithAuthorization`. This contract never holds creator funds.
/// - `giftWithSplit`: USDC is received with `receiveWithAuthorization` (callable only by this
///   contract, so front-run safe) and paid out to every recipient in the same transaction. The
///   contract's USDC balance is identical before and after every call.
///
/// There is no owner, no admin, no upgrade path and no function that can move a balance
/// other than the one being gifted in the current call.
contract BeamGifts {
    using BeamLimits for GiftMeta;

    IUSDC public immutable usdc;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SPLIT_RECIPIENTS = 10;

    bytes32 internal constant GIFT_TAG = keccak256("Beam.Gift.v1");
    bytes32 internal constant SPLIT_TAG = keccak256("Beam.SplitGift.v1");

    event GiftSent(
        address indexed from,
        address indexed to,
        uint256 amount,
        string displayName,
        string message,
        uint16 actionCode,
        uint64 ts
    );
    event GiftSplit(address indexed from, address[] recipients, uint256[] amounts, uint64 ts);

    error ZeroAddress();
    error ZeroAmount();
    error BadSplitLength();
    error BadSplitBps();
    error DuplicateRecipient();
    error TransferFailed();
    error BalanceChanged();

    constructor(IUSDC usdc_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    // ------------------------------------------------------------------ nonces

    /// @notice The EIP-3009 nonce a viewer signs for a direct gift. Binds recipient and metadata.
    function giftNonce(address from, address to, GiftMeta calldata meta, bytes32 salt) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                GIFT_TAG, block.chainid, address(this), from, to, meta.displayName, meta.message, meta.actionCode, salt
            )
        );
    }

    /// @notice The EIP-3009 nonce a viewer signs for a split gift. Binds every recipient and share.
    function splitNonce(
        address from,
        address[] calldata recipients,
        uint16[] calldata bps,
        GiftMeta calldata meta,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                SPLIT_TAG,
                block.chainid,
                address(this),
                from,
                recipients,
                bps,
                meta.displayName,
                meta.message,
                meta.actionCode,
                salt
            )
        );
    }

    // ------------------------------------------------------------------ gifts

    /// @notice Direct gift: viewer → creator. Submitted by any relayer; the viewer needs no MON.
    function giftCreator(address to, GiftMeta calldata meta, Authorization calldata auth) external {
        meta.check();
        if (to == address(0)) revert ZeroAddress();
        if (auth.value == 0) revert ZeroAmount();

        usdc.transferWithAuthorization(
            auth.from,
            to,
            auth.value,
            auth.validAfter,
            auth.validBefore,
            giftNonce(auth.from, to, meta, auth.salt),
            auth.v,
            auth.r,
            auth.s
        );

        emit GiftSent(auth.from, to, auth.value, meta.displayName, meta.message, meta.actionCode, uint64(block.timestamp));
    }

    /// @notice Split gift: one authorization, every recipient paid their share in this transaction.
    /// @dev `recipients[0]` is the primary (the creator). Every other recipient receives exactly
    /// `floor(value * bps[i] / 10_000)`; the primary receives the rest, so rounding dust
    /// (< recipients.length base units) never gets stuck here.
    function giftWithSplit(
        address[] calldata recipients,
        uint16[] calldata bps,
        GiftMeta calldata meta,
        Authorization calldata auth
    ) external {
        meta.check();
        uint256 n = recipients.length;
        if (n < 2 || n > MAX_SPLIT_RECIPIENTS || bps.length != n) revert BadSplitLength();
        if (auth.value == 0) revert ZeroAmount();
        _checkSplit(recipients, bps);

        uint256 balanceBefore = usdc.balanceOf(address(this));

        usdc.receiveWithAuthorization(
            auth.from,
            address(this),
            auth.value,
            auth.validAfter,
            auth.validBefore,
            splitNonce(auth.from, recipients, bps, meta, auth.salt),
            auth.v,
            auth.r,
            auth.s
        );

        uint256[] memory amounts = splitAmounts(auth.value, bps);
        for (uint256 i = 0; i < n; ++i) {
            if (amounts[i] != 0 && !usdc.transfer(recipients[i], amounts[i])) revert TransferFailed();
        }
        if (usdc.balanceOf(address(this)) != balanceBefore) revert BalanceChanged();

        uint64 ts = uint64(block.timestamp);
        emit GiftSent(auth.from, recipients[0], auth.value, meta.displayName, meta.message, meta.actionCode, ts);
        emit GiftSplit(auth.from, recipients, amounts, ts);
    }

    /// @notice The exact amounts `giftWithSplit` pays. Sums to `value` for any input.
    function splitAmounts(uint256 value, uint16[] calldata bps) public pure returns (uint256[] memory amounts) {
        uint256 n = bps.length;
        amounts = new uint256[](n);
        uint256 paid;
        for (uint256 i = 1; i < n; ++i) {
            amounts[i] = value * bps[i] / BPS;
            paid += amounts[i];
        }
        if (n != 0) amounts[0] = value - paid;
    }

    function _checkSplit(address[] calldata recipients, uint16[] calldata bps) private pure {
        uint256 n = recipients.length;
        uint256 total;
        for (uint256 i = 0; i < n; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            if (bps[i] == 0) revert BadSplitBps();
            total += bps[i];
            for (uint256 j = 0; j < i; ++j) {
                if (recipients[j] == recipients[i]) revert DuplicateRecipient();
            }
        }
        if (total != BPS) revert BadSplitBps();
    }
}
