// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BeamTestBase} from "./BeamTestBase.sol";
import {BeamGifts} from "../src/BeamGifts.sol";
import {Authorization, GiftMeta, BeamLimits} from "../src/lib/BeamTypes.sol";

contract BeamGiftsTest is BeamTestBase {
    BeamGifts internal gifts;
    address internal creator;
    address internal viewer;
    uint256 internal viewerPk;

    function setUp() public {
        _fork();
        gifts = new BeamGifts(usdc);
        creator = makeAddr("creator");
        (viewer, viewerPk) = _viewer("viewer", 100e6);
    }

    function _giftAuth(address to, GiftMeta memory m, uint256 value, bytes32 salt)
        internal
        view
        returns (Authorization memory)
    {
        bytes32 nonce = gifts.giftNonce(viewer, to, m, salt);
        return _sign3009(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, viewerPk, to, value, nonce, salt);
    }

    function _splitAuth(address[] memory rs, uint16[] memory bps, GiftMeta memory m, uint256 value, bytes32 salt)
        internal
        view
        returns (Authorization memory)
    {
        bytes32 nonce = gifts.splitNonce(viewer, rs, bps, m, salt);
        return _sign3009(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, viewerPk, address(gifts), value, nonce, salt);
    }

    // ---------------------------------------------------------------- giftCreator

    /// Invariant: creator gifts settle viewer → creator and never touch a Beam-controlled balance.
    function test_giftCreator_settlesDirectlyToCreator() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));

        vm.expectEmit(true, true, false, true, address(gifts));
        emit BeamGifts.GiftSent(viewer, creator, 1e6, "JUDGE", "gg", 1, uint64(block.timestamp));
        vm.prank(relayer);
        gifts.giftCreator(creator, m, a);

        assertEq(usdc.balanceOf(creator), 1e6);
        assertEq(usdc.balanceOf(viewer), 99e6);
        assertEq(usdc.balanceOf(address(gifts)), 0);
    }

    /// Rule: the viewer needs no MON. The viewer never sends a transaction.
    function test_giftCreator_viewerHoldsNoMON() public {
        assertEq(viewer.balance, 0);
        GiftMeta memory m = _meta("anon", "", 0);
        Authorization memory a = _giftAuth(creator, m, 5e5, bytes32("s"));
        vm.prank(relayer);
        gifts.giftCreator(creator, m, a);
        assertEq(viewer.balance, 0);
        assertEq(usdc.balanceOf(creator), 5e5);
    }

    /// Invariant: a gift is spent at most once.
    function test_giftCreator_cannotReplay() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));
        vm.prank(relayer);
        gifts.giftCreator(creator, m, a);
        vm.prank(relayer);
        vm.expectRevert(USDC_AUTH_USED);
        gifts.giftCreator(creator, m, a);
        assertEq(usdc.balanceOf(creator), 1e6);
    }

    /// A relayer cannot change the message the viewer signed.
    function test_giftCreator_rejectsTamperedMessage() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));
        vm.prank(relayer);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftCreator(creator, _meta("JUDGE", "rugged", 1), a);
        assertEq(usdc.balanceOf(creator), 0);
    }

    /// A relayer cannot change the action code (on-stream effect) the viewer signed.
    function test_giftCreator_rejectsTamperedActionCode() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));
        vm.prank(relayer);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftCreator(creator, _meta("JUDGE", "gg", 7), a);
    }

    /// A relayer cannot redirect the gift to another address.
    function test_giftCreator_rejectsTamperedRecipient() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));
        vm.prank(relayer);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftCreator(relayer, m, a);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    /// A relayer cannot inflate the amount.
    function test_giftCreator_rejectsTamperedAmount() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));
        a.value = 50e6;
        vm.prank(relayer);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftCreator(creator, m, a);
    }

    function test_giftCreator_rejectsExpiredAuthorization() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 1e6, bytes32("s1"));
        vm.warp(a.validBefore + 1);
        vm.prank(relayer);
        vm.expectRevert(USDC_AUTH_EXPIRED);
        gifts.giftCreator(creator, m, a);
    }

    function test_giftCreator_rejectsInsufficientBalance() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 101e6, bytes32("s1"));
        vm.prank(relayer);
        vm.expectRevert(USDC_INSUFFICIENT);
        gifts.giftCreator(creator, m, a);
    }

    function test_giftCreator_rejectsZeroAmountAndZeroRecipient() public {
        GiftMeta memory m = _meta("JUDGE", "gg", 1);
        Authorization memory a = _giftAuth(creator, m, 0, bytes32("s1"));
        vm.expectRevert(BeamGifts.ZeroAmount.selector);
        gifts.giftCreator(creator, m, a);
        Authorization memory b = _giftAuth(address(0), m, 1e6, bytes32("s2"));
        vm.expectRevert(BeamGifts.ZeroAddress.selector);
        gifts.giftCreator(address(0), m, b);
    }

    function test_giftCreator_enforcesMetaLimits() public {
        GiftMeta memory longName = _meta("0123456789012345678901234567890123", "", 0);
        Authorization memory a = _giftAuth(creator, longName, 1e6, bytes32("s1"));
        vm.expectRevert(BeamLimits.DisplayNameTooLong.selector);
        gifts.giftCreator(creator, longName, a);

        GiftMeta memory longMsg = _meta("x", string(new bytes(201)), 0);
        Authorization memory b = _giftAuth(creator, longMsg, 1e6, bytes32("s2"));
        vm.expectRevert(BeamLimits.MessageTooLong.selector);
        gifts.giftCreator(creator, longMsg, b);
    }

    // ---------------------------------------------------------------- splits

    function _two(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _bps2(uint16 a, uint16 b) internal pure returns (uint16[] memory r) {
        r = new uint16[](2);
        r[0] = a;
        r[1] = b;
    }

    function test_split_paysEachRecipientInSameTx() public {
        address mod = makeAddr("mod");
        address charity = makeAddr("charity");
        address[] memory rs = new address[](3);
        rs[0] = creator;
        rs[1] = mod;
        rs[2] = charity;
        uint16[] memory bps = new uint16[](3);
        bps[0] = 8000;
        bps[1] = 1500;
        bps[2] = 500;
        GiftMeta memory m = _meta("JUDGE", "split!", 2);
        Authorization memory a = _splitAuth(rs, bps, m, 10e6, bytes32("s"));

        uint256[] memory expected = new uint256[](3);
        expected[0] = 8e6;
        expected[1] = 15e5;
        expected[2] = 5e5;
        vm.expectEmit(true, false, false, true, address(gifts));
        emit BeamGifts.GiftSplit(viewer, rs, expected, uint64(block.timestamp));
        vm.prank(relayer);
        gifts.giftWithSplit(rs, bps, m, a);

        assertEq(usdc.balanceOf(creator), 8e6);
        assertEq(usdc.balanceOf(mod), 15e5);
        assertEq(usdc.balanceOf(charity), 5e5);
        assertEq(usdc.balanceOf(address(gifts)), 0);
        assertEq(usdc.balanceOf(viewer), 90e6);
    }

    /// Invariant: split amounts sum to exactly the gift; each non-primary gets exactly floor(value*bps/1e4);
    /// the contract's balance is unchanged.
    function testFuzz_split_exactShares(uint256 value, uint16 b1, uint16 b2) public {
        value = bound(value, 1, 100e6);
        b1 = uint16(bound(b1, 1, 9998));
        b2 = uint16(bound(b2, 1, 9999 - b1));
        uint16 b0 = uint16(10_000 - b1 - b2);

        address[] memory rs = new address[](3);
        rs[0] = creator;
        rs[1] = makeAddr("r1");
        rs[2] = makeAddr("r2");
        uint16[] memory bps = new uint16[](3);
        bps[0] = b0;
        bps[1] = b1;
        bps[2] = b2;

        GiftMeta memory m = _meta("f", "", 0);
        Authorization memory a = _splitAuth(rs, bps, m, value, keccak256(abi.encode(value, b1, b2)));
        vm.prank(relayer);
        gifts.giftWithSplit(rs, bps, m, a);

        uint256 s1 = value * b1 / 10_000;
        uint256 s2 = value * b2 / 10_000;
        assertEq(usdc.balanceOf(rs[1]), s1);
        assertEq(usdc.balanceOf(rs[2]), s2);
        assertEq(usdc.balanceOf(creator), value - s1 - s2);
        assertEq(usdc.balanceOf(creator) + s1 + s2, value);
        assertEq(usdc.balanceOf(address(gifts)), 0);
    }

    /// Stray USDC sent to BeamGifts does not break or leak through splits.
    function test_split_balanceUnchangedWithStrayFunds() public {
        deal(address(usdc), address(gifts), 3e6);
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory rs = _two(creator, makeAddr("mod"));
        uint16[] memory bps = _bps2(9000, 1000);
        Authorization memory a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.prank(relayer);
        gifts.giftWithSplit(rs, bps, m, a);
        assertEq(usdc.balanceOf(address(gifts)), 3e6);
        assertEq(usdc.balanceOf(creator), 9e5);
    }

    function test_split_rejectsBpsNotSummingTo10000() public {
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory rs = _two(creator, makeAddr("mod"));
        uint16[] memory bps = _bps2(9000, 999);
        Authorization memory a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.BadSplitBps.selector);
        gifts.giftWithSplit(rs, bps, m, a);

        bps = _bps2(9000, 1001);
        a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.BadSplitBps.selector);
        gifts.giftWithSplit(rs, bps, m, a);
    }

    function test_split_rejectsZeroBpsDuplicateAndZeroRecipient() public {
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory rs = _two(creator, makeAddr("mod"));
        uint16[] memory bps = _bps2(10_000, 0);
        Authorization memory a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.BadSplitBps.selector);
        gifts.giftWithSplit(rs, bps, m, a);

        rs = _two(creator, creator);
        bps = _bps2(5000, 5000);
        a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.DuplicateRecipient.selector);
        gifts.giftWithSplit(rs, bps, m, a);

        rs = _two(creator, address(0));
        a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.ZeroAddress.selector);
        gifts.giftWithSplit(rs, bps, m, a);
    }

    function test_split_rejectsBadLengths() public {
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory one = new address[](1);
        one[0] = creator;
        uint16[] memory bpsOne = new uint16[](1);
        bpsOne[0] = 10_000;
        Authorization memory a = _splitAuth(one, bpsOne, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.BadSplitLength.selector);
        gifts.giftWithSplit(one, bpsOne, m, a);

        address[] memory rs = _two(creator, makeAddr("mod"));
        a = _splitAuth(rs, bpsOne, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.BadSplitLength.selector);
        gifts.giftWithSplit(rs, bpsOne, m, a);

        address[] memory many = new address[](11);
        uint16[] memory bpsMany = new uint16[](11);
        for (uint256 i = 0; i < 11; ++i) {
            many[i] = address(uint160(0x1000 + i));
            bpsMany[i] = i == 0 ? 10_000 - 10 * 909 : 909;
        }
        a = _splitAuth(many, bpsMany, m, 1e6, bytes32("s"));
        vm.expectRevert(BeamGifts.BadSplitLength.selector);
        gifts.giftWithSplit(many, bpsMany, m, a);
    }

    /// A relayer cannot reorder or swap split recipients the viewer signed.
    function test_split_rejectsTamperedRecipients() public {
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory rs = _two(creator, makeAddr("mod"));
        uint16[] memory bps = _bps2(9000, 1000);
        Authorization memory a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        address[] memory swapped = _two(creator, relayer);
        vm.prank(relayer);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftWithSplit(swapped, bps, m, a);

        uint16[] memory skewed = _bps2(1000, 9000);
        vm.prank(relayer);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftWithSplit(rs, skewed, m, a);
    }

    /// A split authorization cannot be replayed, nor used as a direct gift authorization.
    function test_split_cannotReplayOrCrossUse() public {
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory rs = _two(creator, makeAddr("mod"));
        uint16[] memory bps = _bps2(9000, 1000);
        Authorization memory a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        vm.prank(relayer);
        gifts.giftWithSplit(rs, bps, m, a);
        vm.expectRevert(USDC_AUTH_USED);
        gifts.giftWithSplit(rs, bps, m, a);
        vm.expectRevert(USDC_INVALID_SIGNATURE);
        gifts.giftCreator(creator, m, a);
    }

    /// receiveWithAuthorization signed to BeamGifts cannot be pulled by anyone else directly.
    function test_split_authorizationUnusableOutsideBeam() public {
        GiftMeta memory m = _meta("x", "", 0);
        address[] memory rs = _two(creator, makeAddr("mod"));
        uint16[] memory bps = _bps2(9000, 1000);
        Authorization memory a = _splitAuth(rs, bps, m, 1e6, bytes32("s"));
        bytes32 nonce = gifts.splitNonce(viewer, rs, bps, m, a.salt);
        vm.prank(relayer);
        vm.expectRevert(USDC_NOT_PAYEE);
        usdc.receiveWithAuthorization(
            viewer, address(gifts), a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s
        );
    }
}
