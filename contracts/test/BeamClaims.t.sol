// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BeamTestBase} from "./BeamTestBase.sol";
import {BeamClaims} from "../src/BeamClaims.sol";
import {Authorization, GiftMeta} from "../src/lib/BeamTypes.sol";

contract BeamClaimsTest is BeamTestBase {
    BeamClaims internal claims;
    address internal sender;
    uint256 internal senderPk;

    uint256[] internal slotKeys;
    bytes32[] internal leaves;

    function setUp() public {
        _fork();
        claims = new BeamClaims(usdc);
        (sender, senderPk) = _viewer("sender", 100e6);
    }

    // ---------------------------------------------------------------- helpers

    function _params(uint32 slots, bytes32 root, string memory label)
        internal
        view
        returns (BeamClaims.DropParams memory p)
    {
        p = BeamClaims.DropParams({slots: slots, slotRoot: root, expiry: uint64(block.timestamp + 1 days), recipientLabel: label});
    }

    function _auth(BeamClaims.Kind kind, BeamClaims.DropParams memory p, GiftMeta memory m, uint256 value, bytes32 salt)
        internal
        view
        returns (Authorization memory)
    {
        bytes32 nonce = claims.dropNonce(sender, kind, p, m, salt);
        return _sign3009(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, senderPk, address(claims), value, nonce, salt);
    }

    /// @dev Generate `n` claim keys (as the sender's browser would) and their Merkle tree.
    function _makeSlots(uint32 n, string memory seed) internal returns (bytes32 root) {
        delete slotKeys;
        delete leaves;
        for (uint32 i = 0; i < n; ++i) {
            (, uint256 pk) = makeAddrAndKey(string.concat(seed, vm.toString(i)));
            slotKeys.push(pk);
            leaves.push(claims.slotLeaf(i, vm.addr(pk)));
        }
        root = _root(leaves);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// Sorted-pair tree; an odd node at the end of a level is promoted unchanged.
    function _root(bytes32[] memory level) internal pure returns (bytes32) {
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? _hashPair(level[i], level[i + 1]) : level[i];
            }
            level = next;
        }
        return level[0];
    }

    function _proof(uint256 index) internal view returns (bytes32[] memory proof) {
        bytes32[] memory level = leaves;
        bytes32[] memory tmp = new bytes32[](16);
        uint256 len;
        while (level.length > 1) {
            uint256 sib = index ^ 1;
            if (sib < level.length) tmp[len++] = level[sib];
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? _hashPair(level[i], level[i + 1]) : level[i];
            }
            level = next;
            index /= 2;
        }
        proof = new bytes32[](len);
        for (uint256 i = 0; i < len; ++i) {
            proof[i] = tmp[i];
        }
    }

    function _claimSig(bytes32 id, uint32 slot, address recipient) internal view returns (bytes memory) {
        return _sig(slotKeys[slot], claims.claimDigest(id, slot, recipient));
    }

    function _claim(bytes32 id, uint32 slot, address recipient) internal {
        bytes memory sig = _claimSig(id, slot, recipient);
        bytes32[] memory proof = _proof(slot);
        vm.prank(relayer);
        claims.claim(id, slot, recipient, proof, sig);
    }

    function _giftChatter(uint256 amount) internal returns (bytes32 id) {
        bytes32 root = _makeSlots(1, "chatter");
        BeamClaims.DropParams memory p = _params(1, root, "@Tunde");
        GiftMeta memory m = _meta("JUDGE", "for you", 3);
        Authorization memory a = _auth(BeamClaims.Kind.Chatter, p, m, amount, bytes32("c"));
        vm.prank(relayer);
        id = claims.giftChatter(p, m, a);
    }

    function _bomb(uint32 slots, uint256 pool) internal returns (bytes32 id) {
        bytes32 root = _makeSlots(slots, "bomb");
        BeamClaims.DropParams memory p = _params(slots, root, "");
        GiftMeta memory m = _meta("JUDGE", "BOOM", 9);
        Authorization memory a = _auth(BeamClaims.Kind.Bomb, p, m, pool, keccak256(abi.encode(slots, pool)));
        vm.prank(relayer);
        id = claims.bomb(p, m, a);
    }

    function _fresh(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.deal(a, 0);
    }

    // ---------------------------------------------------------------- gift a chatter

    /// Core originality path: a walletless recipient claims real USDC; neither side holds MON.
    function test_chatter_walletlessRecipientClaims() public {
        bytes32 root = _makeSlots(1, "chatter");
        BeamClaims.DropParams memory p = _params(1, root, "@Tunde");
        GiftMeta memory m = _meta("JUDGE", "for you", 3);
        Authorization memory a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("c"));
        bytes32 expectedId = claims.dropNonce(sender, BeamClaims.Kind.Chatter, p, m, bytes32("c"));

        vm.expectEmit(true, true, false, true, address(claims));
        emit BeamClaims.ChatterGiftSent(
            expectedId, sender, 5e6, "@Tunde", "JUDGE", "for you", 3, p.expiry, uint64(block.timestamp)
        );
        vm.prank(relayer);
        bytes32 id = claims.giftChatter(p, m, a);
        assertEq(id, expectedId);
        assertEq(usdc.balanceOf(address(claims)), 5e6);
        assertEq(usdc.balanceOf(sender), 95e6);

        address tunde = _fresh("tunde-passkey-account");
        vm.expectEmit(true, true, false, true, address(claims));
        emit BeamClaims.Claimed(id, 0, tunde, 5e6, uint64(block.timestamp));
        _claim(id, 0, tunde);

        assertEq(usdc.balanceOf(tunde), 5e6);
        assertEq(usdc.balanceOf(address(claims)), 0);
        assertEq(tunde.balance, 0);
        assertEq(sender.balance, 0);
        (,,,,, bool closed,,,,) = claims.drops(id);
        assertTrue(closed);
    }

    /// Invariant: a claim is spent at most once.
    function test_chatter_claimSpentOnce() public {
        bytes32 id = _giftChatter(5e6);
        address tunde = _fresh("tunde");
        _claim(id, 0, tunde);
        address other = _fresh("other");
        bytes memory sig = _claimSig(id, 0, other);
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.DropClosed.selector);
        claims.claim(id, 0, other, proof, sig);
        assertEq(usdc.balanceOf(other), 0);
    }

    /// Front-running defence: a claim observed in the mempool cannot be redirected.
    function test_chatter_frontRunCannotRedirect() public {
        bytes32 id = _giftChatter(5e6);
        address tunde = _fresh("tunde");
        bytes memory sig = _claimSig(id, 0, tunde);
        bytes32[] memory proof = _proof(0);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 0, attacker, proof, sig);

        vm.prank(relayer);
        claims.claim(id, 0, tunde, proof, sig);
        assertEq(usdc.balanceOf(tunde), 5e6);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_chatter_wrongKeyRejected() public {
        bytes32 id = _giftChatter(5e6);
        address tunde = _fresh("tunde");
        (, uint256 wrongPk) = makeAddrAndKey("not-the-link");
        bytes memory sig = _sig(wrongPk, claims.claimDigest(id, 0, tunde));
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 0, tunde, proof, sig);
    }

    function test_chatter_malformedSignatureRejected() public {
        bytes32 id = _giftChatter(5e6);
        address tunde = _fresh("tunde");
        bytes memory sig = _claimSig(id, 0, tunde);
        bytes32[] memory proof = _proof(0);

        // high-s (malleated) signature
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(slotKeys[0], claims.claimDigest(id, 0, tunde));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 0, tunde, proof, malleated);

        // truncated
        bytes memory shortSig = new bytes(64);
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 0, tunde, proof, shortSig);

        claims.claim(id, 0, tunde, proof, sig);
        assertEq(usdc.balanceOf(tunde), 5e6);
    }

    function test_chatter_claimAfterExpiryReverts_thenRefundsToSender() public {
        bytes32 id = _giftChatter(5e6);
        (, uint64 expiry,,,,,,,,) = claims.drops(id);
        vm.warp(expiry);
        address tunde = _fresh("tunde");
        bytes memory sig = _claimSig(id, 0, tunde);
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.DropExpired.selector);
        claims.claim(id, 0, tunde, proof, sig);

        // anyone can push the refund to the sender
        vm.expectEmit(true, true, false, true, address(claims));
        emit BeamClaims.Reclaimed(id, sender, 5e6, true, uint64(block.timestamp));
        vm.prank(makeAddr("anyone"));
        claims.refundExpired(id);
        assertEq(usdc.balanceOf(sender), 100e6);
        assertEq(usdc.balanceOf(address(claims)), 0);
    }

    function test_refundExpired_revertsBeforeExpiry() public {
        bytes32 id = _giftChatter(5e6);
        vm.expectRevert(BeamClaims.NotExpired.selector);
        claims.refundExpired(id);
    }

    /// Sender reclaim any time before claim — gaslessly, via signature and relayer.
    function test_chatter_senderReclaimBySigBeforeClaim() public {
        bytes32 id = _giftChatter(5e6);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sig(senderPk, claims.reclaimDigest(id, deadline));
        vm.prank(relayer);
        claims.reclaimBySig(id, deadline, sig);
        assertEq(usdc.balanceOf(sender), 100e6);
        assertEq(sender.balance, 0);

        // claim link is now dead
        address tunde = _fresh("tunde");
        bytes memory csig = _claimSig(id, 0, tunde);
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.DropClosed.selector);
        claims.claim(id, 0, tunde, proof, csig);

        // reclaim signature cannot be replayed
        vm.expectRevert(BeamClaims.DropClosed.selector);
        claims.reclaimBySig(id, deadline, sig);
    }

    function test_chatter_senderDirectReclaim() public {
        bytes32 id = _giftChatter(5e6);
        vm.prank(sender);
        claims.reclaim(id);
        assertEq(usdc.balanceOf(sender), 100e6);
    }

    /// Invariant: only the sender can reclaim.
    function test_reclaim_onlySender() public {
        bytes32 id = _giftChatter(5e6);
        vm.prank(relayer);
        vm.expectRevert(BeamClaims.NotSender.selector);
        claims.reclaim(id);

        (, uint256 otherPk) = makeAddrAndKey("other");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sig(otherPk, claims.reclaimDigest(id, deadline));
        vm.expectRevert(BeamClaims.NotSender.selector);
        claims.reclaimBySig(id, deadline, sig);
        assertEq(usdc.balanceOf(address(claims)), 5e6);
    }

    /// Invariant: only while unclaimed.
    function test_reclaim_afterClaimReverts() public {
        bytes32 id = _giftChatter(5e6);
        _claim(id, 0, _fresh("tunde"));
        vm.prank(sender);
        vm.expectRevert(BeamClaims.DropClosed.selector);
        claims.reclaim(id);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(BeamClaims.DropClosed.selector);
        claims.refundExpired(id);
    }

    function test_reclaimBySig_deadlineEnforced() public {
        bytes32 id = _giftChatter(5e6);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sig(senderPk, claims.reclaimDigest(id, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(BeamClaims.SignatureExpired.selector);
        claims.reclaimBySig(id, deadline, sig);
    }

    /// A relayer cannot swap in its own claim key: the slot root is bound by the sender's signature.
    function test_create_rejectsTamperedSlotRoot() public {
        bytes32 root = _makeSlots(1, "chatter");
        BeamClaims.DropParams memory p = _params(1, root, "@Tunde");
        GiftMeta memory m = _meta("JUDGE", "for you", 3);
        Authorization memory a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("c"));

        p.slotRoot = claims.slotLeaf(0, relayer);
        vm.prank(relayer);
        vm.expectRevert();
        claims.giftChatter(p, m, a);
        assertEq(usdc.balanceOf(sender), 100e6);
    }

    function test_create_rejectsTamperedLabelOrExpiry() public {
        bytes32 root = _makeSlots(1, "chatter");
        BeamClaims.DropParams memory p = _params(1, root, "@Tunde");
        GiftMeta memory m = _meta("JUDGE", "for you", 3);
        Authorization memory a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("c"));

        BeamClaims.DropParams memory q = _params(1, root, "@Mallory");
        vm.expectRevert();
        claims.giftChatter(q, m, a);

        q = _params(1, root, "@Tunde");
        q.expiry = uint64(block.timestamp + 20 days);
        vm.expectRevert();
        claims.giftChatter(q, m, a);
    }

    /// A chatter authorization cannot be replayed as a bomb, or twice.
    function test_create_cannotReplayOrCrossKind() public {
        bytes32 root = _makeSlots(1, "chatter");
        BeamClaims.DropParams memory p = _params(1, root, "@Tunde");
        GiftMeta memory m = _meta("JUDGE", "for you", 3);
        Authorization memory a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("c"));
        claims.giftChatter(p, m, a);
        vm.expectRevert(BeamClaims.DropExists.selector);
        claims.giftChatter(p, m, a);
        assertEq(usdc.balanceOf(address(claims)), 5e6);
    }

    function test_create_validatesParams() public {
        bytes32 root = _makeSlots(1, "chatter");
        GiftMeta memory m = _meta("JUDGE", "", 0);

        BeamClaims.DropParams memory p = _params(1, root, "@Tunde");
        p.expiry = uint64(block.timestamp + 5 minutes);
        Authorization memory a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("1"));
        vm.expectRevert(BeamClaims.BadExpiry.selector);
        claims.giftChatter(p, m, a);

        p = _params(1, root, "@Tunde");
        p.expiry = uint64(block.timestamp + 31 days);
        a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("2"));
        vm.expectRevert(BeamClaims.BadExpiry.selector);
        claims.giftChatter(p, m, a);

        p = _params(2, root, "@Tunde");
        a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("3"));
        vm.expectRevert(BeamClaims.BadSlots.selector);
        claims.giftChatter(p, m, a);

        p = _params(1, root, "@this-label-is-way-longer-than-32-bytes");
        a = _auth(BeamClaims.Kind.Chatter, p, m, 5e6, bytes32("4"));
        vm.expectRevert(BeamClaims.LabelTooLong.selector);
        claims.giftChatter(p, m, a);

        p = _params(1, root, "");
        a = _auth(BeamClaims.Kind.Bomb, p, m, 5e6, bytes32("5"));
        vm.expectRevert(BeamClaims.BadSlots.selector);
        claims.bomb(p, m, a);

        p = _params(101, root, "");
        a = _auth(BeamClaims.Kind.Bomb, p, m, 5e6, bytes32("6"));
        vm.expectRevert(BeamClaims.BadSlots.selector);
        claims.bomb(p, m, a);

        p = _params(3, root, "");
        a = _auth(BeamClaims.Kind.Bomb, p, m, 2, bytes32("7"));
        vm.expectRevert(BeamClaims.AmountTooSmall.selector);
        claims.bomb(p, m, a);
    }

    // ---------------------------------------------------------------- Beam Bomb

    /// Invariant: a bomb pays at most `slots` recipients, one per account, equal shares.
    function test_bomb_paysAtMostSlotsOnePerAccount() public {
        bytes32 id = _bomb(3, 3e6);
        assertEq(usdc.balanceOf(address(claims)), 3e6);

        address a = _fresh("a");
        address b = _fresh("b");
        address c = _fresh("c");
        _claim(id, 0, a);
        _claim(id, 1, b);
        _claim(id, 2, c);
        assertEq(usdc.balanceOf(a), 1e6);
        assertEq(usdc.balanceOf(b), 1e6);
        assertEq(usdc.balanceOf(c), 1e6);
        assertEq(usdc.balanceOf(address(claims)), 0);

        (,,, uint32 claimed,, bool closed,,,,) = claims.drops(id);
        assertEq(claimed, 3);
        assertTrue(closed);
    }

    /// One person cannot sweep a bomb: one account, one slot.
    function test_bomb_sameAccountCannotClaimTwoSlots() public {
        bytes32 id = _bomb(3, 3e6);
        address a = _fresh("a");
        _claim(id, 0, a);
        bytes memory sig = _claimSig(id, 1, a);
        bytes32[] memory proof = _proof(1);
        vm.expectRevert(BeamClaims.AlreadyClaimed.selector);
        claims.claim(id, 1, a, proof, sig);
        assertEq(usdc.balanceOf(a), 1e6);
    }

    /// A slot's link is spent once, whoever presents it.
    function test_bomb_slotCannotBeReused() public {
        bytes32 id = _bomb(3, 3e6);
        _claim(id, 0, _fresh("a"));
        address b = _fresh("b");
        bytes memory sig = _claimSig(id, 0, b);
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.SlotTaken.selector);
        claims.claim(id, 0, b, proof, sig);
    }

    /// A slot key cannot be used for a different slot index.
    function test_bomb_slotKeyBoundToIndex() public {
        bytes32 id = _bomb(3, 3e6);
        address a = _fresh("a");
        // key for slot 0 signs a claim for slot 2
        bytes memory sig = _sig(slotKeys[0], claims.claimDigest(id, 2, a));
        bytes32[] memory proof2 = _proof(2);
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 2, a, proof2, sig);
        bytes32[] memory proof0 = _proof(0);
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 2, a, proof0, sig);
    }

    function test_bomb_slotOutOfRange() public {
        bytes32 id = _bomb(3, 3e6);
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.SlotOutOfRange.selector);
        claims.claim(id, 3, _fresh("a"), proof, new bytes(65));
    }

    /// Invariant: unclaimed remainder (including rounding dust) refunds to the sender at expiry.
    function test_bomb_remainderRefundsAtExpiry() public {
        bytes32 id = _bomb(3, 10e6); // 3_333_333 per slot, 1 unit dust
        _claim(id, 0, _fresh("a"));
        (, uint64 expiry,,,,,,,,) = claims.drops(id);
        vm.warp(expiry);
        claims.refundExpired(id);
        assertEq(usdc.balanceOf(makeAddr("a")), 3_333_333);
        assertEq(usdc.balanceOf(sender), 90e6 + 10e6 - 3_333_333);
        assertEq(usdc.balanceOf(address(claims)), 0);
    }

    function test_bomb_fullyClaimedDustReturnsToSender() public {
        bytes32 id = _bomb(3, 10e6);
        _claim(id, 0, _fresh("a"));
        _claim(id, 1, _fresh("b"));
        _claim(id, 2, _fresh("c"));
        assertEq(usdc.balanceOf(sender), 90e6 + 1);
        assertEq(usdc.balanceOf(address(claims)), 0);
    }

    /// Sender can cancel a live bomb; claimed slots stay paid, the rest comes back.
    function test_bomb_senderReclaimsUnclaimed() public {
        bytes32 id = _bomb(4, 4e6);
        _claim(id, 1, _fresh("a"));
        uint256 deadline = block.timestamp + 1 minutes;
        claims.reclaimBySig(id, deadline, _sig(senderPk, claims.reclaimDigest(id, deadline)));
        assertEq(usdc.balanceOf(sender), 96e6 + 3e6);
        assertEq(usdc.balanceOf(address(claims)), 0);
        address b = _fresh("b");
        bytes memory sig = _claimSig(id, 2, b);
        bytes32[] memory proof = _proof(2);
        vm.expectRevert(BeamClaims.DropClosed.selector);
        claims.claim(id, 2, b, proof, sig);
    }

    /// Conservation: for any pool/slots/claim pattern, claimed + refunded == pool exactly,
    /// and the escrow holds only live drops' remaining balances.
    function testFuzz_bomb_conservation(uint32 slots, uint256 pool, uint256 claimMask) public {
        slots = uint32(bound(slots, 2, 12));
        pool = bound(pool, slots, 100e6);
        bytes32 id = _bomb(slots, pool);

        uint256 paid;
        for (uint32 i = 0; i < slots; ++i) {
            if (claimMask & (1 << i) != 0) {
                address r = _fresh(string.concat("r", vm.toString(i)));
                _claim(id, i, r);
                paid += usdc.balanceOf(r);
            }
        }
        (,,,,, bool closed,, uint128 remaining,,) = claims.drops(id);
        if (!closed) {
            assertEq(usdc.balanceOf(address(claims)), remaining);
            vm.warp(block.timestamp + 2 days);
            claims.refundExpired(id);
        }
        uint256 refunded = usdc.balanceOf(sender) - (100e6 - pool);
        assertEq(paid + refunded, pool);
        assertEq(usdc.balanceOf(address(claims)), 0);
    }

    // ---------------------------------------------------------------- no admin path

    /// Invariant: no party other than a valid claimant or the sender can move escrowed funds.
    /// Every mutating entrypoint is exercised by a stranger against a live drop.
    function test_noAdminPathMovesEscrow() public {
        bytes32 id = _bomb(3, 3e6);
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);

        vm.expectRevert(BeamClaims.NotSender.selector);
        claims.reclaim(id);
        vm.expectRevert(BeamClaims.NotSender.selector);
        claims.reclaimBySig(id, block.timestamp, new bytes(65));
        vm.expectRevert(BeamClaims.NotExpired.selector);
        claims.refundExpired(id);
        bytes32[] memory proof = _proof(0);
        vm.expectRevert(BeamClaims.InvalidClaim.selector);
        claims.claim(id, 0, stranger, proof, new bytes(65));
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(claims)), 3e6);
        assertEq(usdc.balanceOf(stranger), 0);

        // after expiry the only possible destination is the sender
        vm.warp(block.timestamp + 2 days);
        vm.prank(stranger);
        claims.refundExpired(id);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(sender), 100e6);
    }

    function test_unknownDropReverts() public {
        bytes32[] memory proof;
        vm.expectRevert(BeamClaims.UnknownDrop.selector);
        claims.claim(bytes32("nope"), 0, makeAddr("x"), proof, new bytes(65));
        vm.expectRevert(BeamClaims.UnknownDrop.selector);
        claims.refundExpired(bytes32("nope"));
    }
}
