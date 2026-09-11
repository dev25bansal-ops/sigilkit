// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {MerkleWhitelist} from "../src/MerkleWhitelist.sol";

/// @title GoldenVectors — Solidity consumer of the shared golden-vector corpus
///        (enhancement E7). The SAME JSON fixtures under /vectors are asserted by the
///        TS suite (packages/core/test/vectors.test.ts); together they pin the
///        cross-language digest/leaf/RLP conformance matrix to frozen, regenerable
///        artifacts instead of ad-hoc in-file expectations.
contract GoldenVectorsTest is Test {
    string internal actionVectors;
    string internal authVectors;
    string internal merkleVectors;

    function setUp() public {
        // fs_permissions grants read access to the repo root (foundry.toml).
        actionVectors = vm.readFile("vectors/actionrequest.json");
        authVectors = vm.readFile("vectors/eip7702.json");
        merkleVectors = vm.readFile("vectors/merkle-v2.json");
    }

    // ------------------------------------------------------------------
    // ActionRequest EIP-712 digests
    // ------------------------------------------------------------------
    function test_Golden_ActionRequestDigests() public view {
        uint256 n = vm.parseJsonUint(actionVectors, ".casesCount");
        require(n > 0, "vector file empty");
        for (uint256 i = 0; i < n; ++i) {
            _checkActionCase(i);
        }
    }

    struct ActionCase {
        bytes32 agentId;
        address target;
        bytes4 selector;
        uint256 value;
        uint256 nonce;
        uint48 expiry;
        bytes32 rationaleHash;
        bytes data;
        uint256 chainId;
        address verifying;
        bytes32 expected;
    }

    function _checkActionCase(uint256 i) internal view {
        ActionCase memory c = _parseActionCase(i);
        assertEq(_actionDigest(c), c.expected, string.concat("actionrequest case ", vm.toString(i)));
    }

    function _parseActionCase(uint256 i) internal view returns (ActionCase memory c) {
        string memory p = string.concat(".cases[", vm.toString(i), "]");
        c.agentId = vm.parseJsonBytes32(actionVectors, string.concat(p, ".request.agentId"));
        c.target = vm.parseJsonAddress(actionVectors, string.concat(p, ".request.target"));
        c.selector = bytes4(vm.parseBytes(vm.parseJsonString(actionVectors, string.concat(p, ".request.selector"))));
        c.value = vm.parseJsonUint(actionVectors, string.concat(p, ".request.value"));
        c.nonce = vm.parseJsonUint(actionVectors, string.concat(p, ".request.nonce"));
        c.expiry = uint48(vm.parseJsonUint(actionVectors, string.concat(p, ".request.expiry")));
        c.rationaleHash = vm.parseJsonBytes32(actionVectors, string.concat(p, ".request.rationaleHash"));
        c.data = vm.parseJsonBytes(actionVectors, string.concat(p, ".request.data"));
        c.chainId = vm.parseJsonUint(actionVectors, string.concat(p, ".chainId"));
        c.verifying = vm.parseJsonAddress(actionVectors, string.concat(p, ".verifyingContract"));
        c.expected = vm.parseJsonBytes32(actionVectors, string.concat(p, ".digest"));
    }

    function _actionDigest(ActionCase memory c) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("SigilKit"),
                keccak256("1"),
                c.chainId,
                c.verifying
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)"
                ),
                c.agentId,
                c.target,
                c.selector,
                c.value,
                c.nonce,
                c.expiry,
                c.rationaleHash,
                keccak256(c.data)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    // ------------------------------------------------------------------
    // EIP-7702 authorization digests (minimal RLP reimplementation)
    // ------------------------------------------------------------------
    function test_Golden_EIP7702Digests() public view {
        uint256 n = vm.parseJsonUint(authVectors, ".casesCount");
        require(n > 0, "vector file empty");
        for (uint256 i = 0; i < n; ++i) {
            string memory p = string.concat(".cases[", vm.toString(i), "]");
            uint256 chainId = vm.parseJsonUint(authVectors, string.concat(p, ".chainId"));
            address contractAddr = vm.parseJsonAddress(authVectors, string.concat(p, ".contractAddress"));
            uint256 nonce = vm.parseJsonUint(authVectors, string.concat(p, ".nonce"));
            bytes32 expected = vm.parseJsonBytes32(authVectors, string.concat(p, ".digest"));

            bytes memory preimage =
                abi.encodePacked(hex"05", _rlpList(_rlpScalar(chainId), _rlpAddress(contractAddr), _rlpScalar(nonce)));
            assertEq(keccak256(preimage), expected, string.concat("eip7702 case ", vm.toString(i)));
        }
    }

    /// @dev Minimal RLP: scalars (minimal big-endian), fixed 20-byte address, 3-item
    ///      list with a single-byte length prefix (all vector cases stay under 56 bytes).
    function _rlpScalar(uint256 v) internal pure returns (bytes memory) {
        if (v == 0) return hex"80";
        if (v < 0x80) return abi.encodePacked(uint8(v));
        uint256 len = _byteLen(v);
        return abi.encodePacked(uint8(uint8(0x80 + len)), _beBytes(v, len));
    }

    function _rlpAddress(address a) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x94), a); // 0x80 + 20
    }

    function _rlpList(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes memory) {
        uint256 payload = a.length + b.length + c.length;
        require(payload < 56, "vector payloads must stay in single-byte list prefix range");
        return abi.encodePacked(uint8(uint8(0xc0 + payload)), a, b, c);
    }

    function _byteLen(uint256 v) internal pure returns (uint256 len) {
        while (v != 0) {
            len++;
            v >>= 8;
        }
    }

    function _beBytes(uint256 v, uint256 len) internal pure returns (bytes memory) {
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[len - 1 - i] = bytes1(uint8(v >> (8 * i)));
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Merkle v2 leaves (pinned + wildcard) and tree proofs
    // ------------------------------------------------------------------
    function test_Golden_MerkleV2Leaves() public view {
        uint256 n = vm.parseJsonUint(merkleVectors, ".leafCasesCount");
        require(n > 0, "vector file empty");
        for (uint256 i = 0; i < n; ++i) {
            string memory p = string.concat(".leafCases[", vm.toString(i), "]");
            address target = vm.parseJsonAddress(merkleVectors, string.concat(p, ".target"));
            bytes4 selector = bytes4(vm.parseBytes(vm.parseJsonString(merkleVectors, string.concat(p, ".selector"))));
            bytes32 argsHash = vm.parseJsonBytes32(merkleVectors, string.concat(p, ".argsHash"));
            bytes32 expected = vm.parseJsonBytes32(merkleVectors, string.concat(p, ".leaf"));
            assertEq(
                keccak256(abi.encode(target, selector, argsHash)),
                expected,
                string.concat("merkle leaf case ", vm.toString(i))
            );
        }
    }

    function test_Golden_MerkleTree_ProofsVerify() public view {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(merkleVectors, ".trees[0].leaves");
        bytes32 root = vm.parseJsonBytes32(merkleVectors, ".trees[0].root");
        uint256 n = vm.parseJsonUint(merkleVectors, ".trees[0].proofsCount");
        require(n == leaves.length, "proof count must match leaves");
        for (uint256 i = 0; i < n; ++i) {
            bytes32 leaf = vm.parseJsonBytes32(
                merkleVectors, string.concat(".trees[0].proofs[", vm.toString(i), "].leaf")
            );
            bytes32[] memory proof = vm.parseJsonBytes32Array(
                merkleVectors, string.concat(".trees[0].proofs[", vm.toString(i), "].proof")
            );
            assertTrue(
                MerkleWhitelist.verify(proof, root, leaf),
                string.concat("proof for leaf ", vm.toString(i), " must verify against the root")
            );
        }
    }
}
