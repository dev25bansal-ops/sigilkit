// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @dev Minimal payable target for TS conformance tests (mirrors the Foundry-test Counter).
contract CounterTarget {
    uint256 public count;

    event Poked(address caller, uint256 by, uint256 value);

    function poke(uint256 by) external payable returns (uint256) {
        count += by;
        emit Poked(msg.sender, by, msg.value);
        return count;
    }
}
