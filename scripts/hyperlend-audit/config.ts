// Known HyperLend contract addresses on HyperEVM mainnet (chain ID 999).
// SOURCE: https://docs.hyperlend.finance/developer-documentation/contract-addresses
//         + HyperEVMScan verification (hyperevmscan.io)
// These are the STARTING POINT for discover.ts — the script will verify
// each address on-chain and save the confirmed config to discovered-config.json.
// If addresses have changed since this was written, discover.ts will surface that.

export const CHAIN_ID = 999;

export const KNOWN_ADDRESSES = {
  // Aave V3-style Pool (proxy). Verified on hyperevmscan.io.
  pool: '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b',

  // PoolAddressesProvider — canonical registry for all HyperLend contract addresses.
  poolAddressesProvider: '0x72c98246a98bFe64022a3190e7710E157497170C',

  // AaveOracle — returns asset prices in USD base currency (8 decimals).
  oracle: '0xC9Fb4fbE842d57EAc1dF3e641a281827493A630e',

  // PoolConfigurator — for reading liquidation params (not needed for audit).
  poolConfigurator: '0x8CB4310dD38F6fD59388C9DE225f328092bdC379',

  // Pool logic implementation (behind the proxy).
  // ⚠️ UPGRADABLE PROXY — verificado en hyperevmscan.io el 2026-06-20:
  // implementación actual = 0xBEBb62C7...A92d49B06 (distinta de la original en docs).
  // El evento LiquidationCall sigue siendo compatible Aave V3, pero confirmar
  // el topic0 en una tx real antes de confiar en el scan.
  poolImplementation: '0xc19d68383Ed7AB130c15cEad839e67A7Ed9d7041', // original; puede estar obsoleto
} as const;

// HyperEVM dual-block architecture (HyperBFT consensus):
// - Fast blocks: ~2s, 2M gas limit
// - Slow blocks: ~60s, 30M gas limit
// Combined average: ~31 blocks/minute → ~44,640 blocks/day
// These are ESTIMATES. discover.ts computes actual block time from chain.
export const FAST_BLOCK_SECONDS = 2;
export const SLOW_BLOCK_SECONDS = 60;
export const EST_BLOCKS_PER_DAY = 44_640;

// LiquidationCall(address,address,address,uint256,uint256,address,bool)
// This is the standard Aave V3 event. discover.ts verifies this topic0 is
// present in recent chain data. If HyperLend changed the signature, that step
// will flag it.
export const LIQUIDATION_CALL_SIGNATURE =
  'LiquidationCall(address,address,address,uint256,uint256,address,bool)';

// Minimal ABIs — only events and view functions needed for the audit.
// Full ABIs are not needed and risk confusion with unverified interfaces.

export const POOL_ABI = [
  // READ: enumerate all supported reserve asset addresses
  'function getReservesList() external view returns (address[])',
  // READ: per-user health factor (useful for debugging, not core audit)
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  // EVENT: the primary event we scan for
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
] as const;

export const POOL_ADDRESSES_PROVIDER_ABI = [
  'function getPool() external view returns (address)',
  'function getPriceOracle() external view returns (address)',
  'function getPoolDataProvider() external view returns (address)',
  // Fallback generic getter (some forks use this instead of named getters)
  'function getAddress(bytes32 id) external view returns (address)',
] as const;

export const ORACLE_ABI = [
  // Returns price in base currency units (typically 1e8 for USD)
  'function getAssetPrice(address asset) external view returns (uint256)',
  // The unit of account for prices (e.g. 1e8 → 8 decimal USD)
  'function BASE_CURRENCY_UNIT() external view returns (uint256)',
  // Convenience: get prices for multiple assets in one call
  'function getAssetsPrices(address[] calldata assets) external view returns (uint256[])',
] as const;

export const DATA_PROVIDER_ABI = [
  // Returns all reserves with their symbols and aToken addresses
  'function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[])',
  // Per-reserve risk parameters including liquidationBonus (e.g. 10500 = 5% bonus)
  'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
] as const;

export const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function name() external view returns (string)',
  'function decimals() external view returns (uint8)',
] as const;
