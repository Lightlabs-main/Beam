// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A viewer's EIP-3009 authorization. The USDC `nonce` is not passed in: each Beam
/// entrypoint recomputes it from the gift parameters and `salt`, so the viewer's single
/// signature also commits to the recipient(s), message and every other field. A relayer that
/// alters any of them produces a different nonce and USDC rejects the signature.
struct Authorization {
    address from;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 salt;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

/// @notice What the overlay renders. `actionCode` selects a creator-defined effect (off-chain config).
struct GiftMeta {
    string displayName;
    string message;
    uint16 actionCode;
}

library BeamLimits {
    uint256 internal constant MAX_NAME_BYTES = 32;
    uint256 internal constant MAX_MESSAGE_BYTES = 200;

    error DisplayNameTooLong();
    error MessageTooLong();

    function check(GiftMeta calldata meta) internal pure {
        if (bytes(meta.displayName).length > MAX_NAME_BYTES) revert DisplayNameTooLong();
        if (bytes(meta.message).length > MAX_MESSAGE_BYTES) revert MessageTooLong();
    }
}
