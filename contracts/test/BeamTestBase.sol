// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";
import {Authorization, GiftMeta} from "../src/lib/BeamTypes.sol";

/// @notice Tests run against a fork of live Monad and Circle's real USDC deployment (addresses
/// from developers.circle.com/stablecoins/usdc-contract-addresses; EIP-3009 support recorded in
/// docs/verification.md). BEAM_NETWORK=mainnet (default) or testnet picks the chain. Balances
/// are seeded with forge's `deal` cheatcode on the real token; no token is re-implemented.
abstract contract BeamTestBase is Test {
    address internal constant MONAD_MAINNET_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant MONAD_TESTNET_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;

    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // Circle FiatToken v2 revert strings, so tamper tests assert the exact failure rather than any revert.
    bytes internal constant USDC_INVALID_SIGNATURE = "FiatTokenV2: invalid signature";
    bytes internal constant USDC_AUTH_USED = "FiatTokenV2: authorization is used or canceled";
    bytes internal constant USDC_AUTH_EXPIRED = "FiatTokenV2: authorization is expired";
    bytes internal constant USDC_NOT_PAYEE = "FiatTokenV2: caller must be the payee";
    bytes internal constant USDC_INSUFFICIENT = "ERC20: transfer amount exceeds balance";

    IUSDC internal usdc;
    address internal relayer;

    function _fork() internal {
        string memory network = vm.envOr("BEAM_NETWORK", string("mainnet"));
        if (keccak256(bytes(network)) == keccak256("testnet")) {
            vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
            assertEq(block.chainid, MONAD_TESTNET_CHAIN_ID, "not Monad testnet");
            usdc = IUSDC(MONAD_TESTNET_USDC);
        } else if (keccak256(bytes(network)) == keccak256("mainnet")) {
            vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
            assertEq(block.chainid, MONAD_MAINNET_CHAIN_ID, "not Monad mainnet");
            usdc = IUSDC(MONAD_MAINNET_USDC);
        } else {
            revert("BEAM_NETWORK must be mainnet or testnet");
        }
        relayer = makeAddr("relayer");
        vm.deal(relayer, 10 ether);
    }

    /// @dev A viewer: an EOA with USDC and zero MON, like a fresh Mera passkey account.
    function _viewer(string memory name, uint256 usdcAmount) internal returns (address addr, uint256 pk) {
        (addr, pk) = makeAddrAndKey(name);
        deal(address(usdc), addr, usdcAmount);
        vm.deal(addr, 0);
    }

    function _sign3009(bytes32 typehash, uint256 pk, address to, uint256 value, bytes32 nonce, bytes32 salt)
        internal
        view
        returns (Authorization memory a)
    {
        a.from = vm.addr(pk);
        a.value = value;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 hours;
        a.salt = salt;
        bytes32 structHash = keccak256(abi.encode(typehash, a.from, to, value, a.validAfter, a.validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (a.v, a.r, a.s) = vm.sign(pk, digest);
    }

    function _meta(string memory name, string memory message, uint16 code) internal pure returns (GiftMeta memory m) {
        m = GiftMeta({displayName: name, message: message, actionCode: code});
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
