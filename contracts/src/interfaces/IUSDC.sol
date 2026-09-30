// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of Circle's FiatToken v2.2 (USDC) that Beam uses.
/// EIP-3009 support on Monad's USDC deployments is recorded in docs/verification.md.
interface IUSDC {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    /// @dev Anyone may submit; moves `value` from `from` to `to`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @dev Only `to` may submit (msg.sender == to), which makes it front-run safe for escrow.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
