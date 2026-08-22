// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title MerkleWhitelist
/// @notice Sorted-pair Merkle verification for target/selector whitelists.
/// @dev Leaf convention (must match packages/core targetLeaf):
///      leaf = keccak256(abi.encode(target, selector)); pairs hash as keccak256(abi.encodePacked(a,b)).
library MerkleWhitelist {
    /// @notice Returns true iff `proof` recomputes `leaf` up to `root`.
    /// @dev Memory parameter: callers may pass calldata arrays directly (implicit copy).
    function verify(
        bytes32[] memory proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; ++i) {
            computed = _hashPair(computed, proof[i]);
        }
        return computed == root;
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
