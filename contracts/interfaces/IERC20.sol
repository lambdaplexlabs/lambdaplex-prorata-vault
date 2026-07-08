// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amt) external returns (bool);
    function transferFrom(address from, address to, uint256 amt) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function decimals() external view returns (uint8);
}