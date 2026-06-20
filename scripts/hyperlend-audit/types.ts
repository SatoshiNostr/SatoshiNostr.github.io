// All data types for the HyperLend audit — READ-ONLY, no transaction types.

export interface LiquidationRaw {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number;
  liquidator: string;
  borrower: string;
  collateralAsset: string;
  debtAsset: string;
  debtToCover: string;           // raw uint256 as decimal string
  liquidatedCollateralAmount: string;
  receiveAToken: boolean;
  gasUsed: number | null;
  effectiveGasPrice: string | null; // wei as decimal string
}

export interface EnrichedFields {
  collateralSymbol: string;
  debtSymbol: string;
  collateralDecimals: number;
  debtDecimals: number;
  debtToCoverUsd: number;
  liquidatedCollateralUsd: number;
  liquidationBonusBps: number;   // e.g. 10500 = 5% bonus
  grossProfitUsd: number;        // liquidatedCollateralUsd - debtToCoverUsd
  gasCostUsd: number;            // MEASURED if gasUsed known, else 0
  netProfitUsd: number;          // grossProfitUsd - gasCostUsd
  priceSource: 'oracle_block' | 'oracle_daily' | 'estimated';
}

export type LiquidationRow = LiquidationRaw & Partial<EnrichedFields> & { enriched: boolean };

export interface AssetInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  liquidationBonusBps: number;
  liquidationThresholdBps: number;
  ltvBps: number;
}

export interface DiscoveredConfig {
  generatedAt: string;           // ISO timestamp
  chainId: number;
  pool: string;
  poolAddressesProvider: string;
  oracle: string;
  poolDataProvider: string;
  poolImplementation: string;
  liquidationCallTopic0: string;
  reserves: string[];
  blockAtDiscovery: number;
  baseCurrencyUnit: string;      // e.g. "100000000" for 8-decimal USD pricing
  warnings: string[];
}

export interface BackfillProgress {
  fromBlock: number;
  toBlock: number;
  currentBlock: number;
  completed: boolean;
  lastUpdated: number;
}

export interface LiquidatorStats {
  address: string;
  count: number;
  sharePercent: number;
  totalVolumeUsd: number;
  totalProfitUsd: number;
  avgCalldataBytes: number | null; // null = not yet fetched
}

export interface DailyStats {
  date: string;        // YYYY-MM-DD
  count: number;
  volumeUsd: number;
  profitUsd: number;
}

export interface PairStats {
  collateralSymbol: string;
  debtSymbol: string;
  count: number;
  totalVolumeUsd: number;
}

export interface AuditMetrics {
  // Period
  fromBlock: number;
  toBlock: number;
  fromDate: string;
  toDate: string;
  daysObserved: number;

  // Volume
  totalLiquidations: number;
  totalVolumeUsd: number;
  medianVolumeUsd: number;
  p90VolumeUsd: number;
  maxVolumeUsd: number;

  // Profitability
  minNetProfitUsd: number;
  medianNetProfitUsd: number;
  meanNetProfitUsd: number;
  p90NetProfitUsd: number;
  maxNetProfitUsd: number;
  pctAboveMinProfit: number;      // % liquidations above MIN_PROFIT_USDC

  // Competition
  uniqueLiquidators: number;
  top1Share: number;
  top3Share: number;
  top5Share: number;
  hhi: number;                    // 0-10000 scale
  topLiquidators: LiquidatorStats[];

  // Daily breakdown
  dailyBreakdown: DailyStats[];

  // Asset pairs
  topPairs: PairStats[];

  // Enrichment coverage
  enrichedCount: number;
  priceSourceBreakdown: Record<string, number>;

  // Params used
  minProfitThreshold: number;
  daysRequested: number;
}
