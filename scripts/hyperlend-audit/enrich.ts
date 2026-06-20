/**
 * PASO 2 — USD enrichment and profit estimation.
 *
 * For each unenriched liquidation:
 *   1. Resolves asset symbol/decimals (from DB cache or on-chain)
 *   2. Gets asset price in USD from HyperLend oracle
 *      - Tries historical price at exact block (requires archive RPC)
 *      - Falls back to daily cached price
 *   3. Computes gross profit (= liquidated collateral USD - debt covered USD)
 *   4. Estimates gas cost in USD (HYPE is the gas token)
 *   5. Computes net profit = gross - gas
 *
 * All estimated values are clearly labeled in price_source field.
 * READ-ONLY. Idempotent.
 */

import { ethers } from 'ethers';
import { loadDiscoveredConfig } from './discover';
import {
  initDb,
  getUnenrichedLiquidations,
  updateEnrichment,
  getAsset,
  upsertAsset,
} from './db';
import { MultiProvider, withRetry, sleep } from './rpc';
import { ORACLE_ABI, ERC20_ABI, DATA_PROVIDER_ABI } from './config';
import type { AssetInfo, EnrichedFields } from './types';

// DB returns snake_case column names; define that shape explicitly.
interface DbRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number;
  liquidator: string;
  borrower: string;
  collateral_asset: string;
  debt_asset: string;
  debt_to_cover: string;
  liquidated_collateral_amount: string;
  receive_atoken: number;
  gas_used: number | null;
  effective_gas_price: string | null;
  enriched: number;
}

// ---- Oracle price fetcher ----

async function fetchOraclePriceAtBlock(
  mp: MultiProvider,
  oracleAddr: string,
  assetAddr: string,
  blockNumber: number,
  baseCurrencyUnit: bigint,
  useHistorical: boolean,
): Promise<{ priceUsd: number; source: EnrichedFields['priceSource'] }> {
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, mp.provider);

  if (useHistorical) {
    try {
      const raw = await withRetry(
        () => oracle.getAssetPrice(assetAddr, { blockTag: blockNumber }) as Promise<bigint>,
        `oracle.getAssetPrice(${assetAddr.slice(0, 8)}, block=${blockNumber})`,
        2,
        1_000,
      );
      return { priceUsd: Number(raw) / Number(baseCurrencyUnit), source: 'oracle_block' };
    } catch {
      // Archive call failed — fall back to current price
    }
  }

  // Daily approximation: fetch current price and cache it
  try {
    const raw = await withRetry(
      () => oracle.getAssetPrice(assetAddr) as Promise<bigint>,
      `oracle.getAssetPrice(${assetAddr.slice(0, 8)})`,
      3,
      1_000,
    );
    return { priceUsd: Number(raw) / Number(baseCurrencyUnit), source: 'oracle_daily' };
  } catch {
    return { priceUsd: 0, source: 'estimated' };
  }
}

// ---- Asset info resolver (DB cache → chain fallback) ----

const assetCache = new Map<string, AssetInfo>();

async function resolveAsset(
  db: ReturnType<typeof initDb>,
  mp: MultiProvider,
  dataProviderAddr: string,
  address: string,
): Promise<AssetInfo> {
  const laddr = address.toLowerCase();
  if (assetCache.has(laddr)) return assetCache.get(laddr)!;

  // Try DB first (getAsset already maps snake_case → camelCase)
  const cached = getAsset(db, laddr);
  if (cached && cached.symbol) {
    assetCache.set(laddr, cached);
    return cached;
  }

  // Precompile shortcut (e.g. HYPE at 0x5555...5555 returns 500 on ERC20 calls)
  const PRECOMPILES: Record<string, { symbol: string; name: string; decimals: number }> = {
    '0x5555555555555555555555555555555555555555': { symbol: 'HYPE', name: 'Hyperliquid', decimals: 18 },
  };
  if (PRECOMPILES[laddr]) {
    const p = PRECOMPILES[laddr]!;
    const info: AssetInfo = { address: laddr, symbol: p.symbol, name: p.name, decimals: p.decimals, liquidationBonusBps: 0, liquidationThresholdBps: 0, ltvBps: 0 };
    upsertAsset(db, info);
    assetCache.set(laddr, info);
    return info;
  }

  // Fetch from chain
  const erc20 = new ethers.Contract(address, ERC20_ABI, mp.provider);
  const [symbol, name, decimals] = await Promise.all([
    withRetry(() => erc20.symbol() as Promise<string>, `symbol(${laddr})`).catch(() => 'UNKNOWN'),
    withRetry(() => erc20.name() as Promise<string>, `name(${laddr})`).catch(() => 'UNKNOWN'),
    withRetry(() => erc20.decimals() as Promise<bigint>, `decimals(${laddr})`).catch(() => 18n),
  ]);

  let liquidationBonusBps = 0;
  let liquidationThresholdBps = 0;
  let ltvBps = 0;
  if (dataProviderAddr !== ethers.ZeroAddress) {
    try {
      const dp = new ethers.Contract(dataProviderAddr, DATA_PROVIDER_ABI, mp.provider);
      const cfg = await withRetry(
        () => dp.getReserveConfigurationData(address) as Promise<[bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]>,
        `getReserveConfig(${laddr})`,
      );
      ltvBps = Number(cfg[1]);
      liquidationThresholdBps = Number(cfg[2]);
      liquidationBonusBps = Number(cfg[3]);
    } catch { /* ignore */ }
  }

  const info: AssetInfo = {
    address: laddr,
    symbol: symbol as string,
    name: name as string,
    decimals: Number(decimals),
    liquidationBonusBps,
    liquidationThresholdBps,
    ltvBps,
  };
  upsertAsset(db, info);
  assetCache.set(laddr, info);
  return info;
}

// ---- Gas cost estimation ----

function estimateGasCostUsd(
  gasUsed: number | null,
  effectiveGasPrice: string | null,
  hypePriceUsd: number,
): number {
  if (!gasUsed || !effectiveGasPrice || hypePriceUsd === 0) return 0;
  const gasCostWei = BigInt(gasUsed) * BigInt(effectiveGasPrice);
  const gasCostHype = Number(gasCostWei) / 1e18;
  return gasCostHype * hypePriceUsd;
}

// ---- Enrich single liquidation ----

async function enrichOne(
  db: ReturnType<typeof initDb>,
  mp: MultiProvider,
  liq: DbRow,
  cfg: ReturnType<typeof loadDiscoveredConfig>,
  baseCurrencyUnit: bigint,
  hypePriceUsd: number,
  useHistorical: boolean,
): Promise<void> {
  const [collateralInfo, debtInfo] = await Promise.all([
    resolveAsset(db, mp, cfg.poolDataProvider, liq.collateral_asset),
    resolveAsset(db, mp, cfg.poolDataProvider, liq.debt_asset),
  ]);

  const [collPrice, debtPrice] = await Promise.all([
    fetchOraclePriceAtBlock(mp, cfg.oracle, collateralInfo.address, liq.block_number, baseCurrencyUnit, useHistorical),
    fetchOraclePriceAtBlock(mp, cfg.oracle, debtInfo.address, liq.block_number, baseCurrencyUnit, useHistorical),
  ]);

  const debtToCoverHuman = Number(BigInt(liq.debt_to_cover)) / 10 ** debtInfo.decimals;
  const collAmountHuman = Number(BigInt(liq.liquidated_collateral_amount)) / 10 ** collateralInfo.decimals;

  const debtToCoverUsd = debtToCoverHuman * debtPrice.priceUsd;
  const liquidatedCollateralUsd = collAmountHuman * collPrice.priceUsd;
  const grossProfitUsd = liquidatedCollateralUsd - debtToCoverUsd;

  const gasCostUsd = estimateGasCostUsd(liq.gas_used, liq.effective_gas_price, hypePriceUsd);
  const netProfitUsd = grossProfitUsd - gasCostUsd;

  // Price source: use the "worse" (less certain) source between the two assets
  const sourceOrder: EnrichedFields['priceSource'][] = ['oracle_block', 'oracle_daily', 'estimated'];
  const priceSource = sourceOrder[
    Math.max(sourceOrder.indexOf(collPrice.source), sourceOrder.indexOf(debtPrice.source))
  ] ?? 'estimated';

  updateEnrichment(db, liq.tx_hash, liq.log_index, {
    collateralSymbol: collateralInfo.symbol,
    debtSymbol: debtInfo.symbol,
    collateralDecimals: collateralInfo.decimals,
    debtDecimals: debtInfo.decimals,
    debtToCoverUsd,
    liquidatedCollateralUsd,
    liquidationBonusBps: collateralInfo.liquidationBonusBps,
    grossProfitUsd,
    gasCostUsd,
    netProfitUsd,
    priceSource,
  });
}

// ---- Main export ----

export async function enrich(mp: MultiProvider): Promise<void> {
  console.log('\n=== PASO 2: USD enrichment ===');

  const cfg = loadDiscoveredConfig();
  const db = initDb();

  const baseCurrencyUnit = BigInt(cfg.baseCurrencyUnit);
  const useHistorical = (process.env['USE_HISTORICAL_PRICES'] ?? '1') === '1';

  // HYPE price for gas cost estimation (HYPE is the native gas token on HyperEVM)
  let hypePriceUsd = parseFloat(process.env['HYPE_PRICE_USD'] ?? '0');
  if (hypePriceUsd === 0) {
    // Try to get HYPE price from oracle if WHYPE is a listed reserve
    const oracle = new ethers.Contract(cfg.oracle, ORACLE_ABI, mp.provider);
    const reserves = cfg.reserves;
    for (const r of reserves) {
      const assetInfo = getAsset(db, r);
      if (assetInfo && assetInfo.symbol?.toUpperCase()?.includes('HYPE')) {
        try {
          const raw = await withRetry(() => oracle.getAssetPrice(r) as Promise<bigint>, 'getAssetPrice(HYPE)');
          hypePriceUsd = Number(raw) / Number(baseCurrencyUnit);
          console.log(`  [enrich] HYPE price from oracle: $${hypePriceUsd.toFixed(2)}`);
          break;
        } catch { /* ignore */ }
      }
    }
    if (hypePriceUsd === 0) {
      console.warn('  [enrich] ⚠ HYPE price unknown — gas cost will be $0 (set HYPE_PRICE_USD in .env for accuracy)');
    }
  } else {
    console.log(`  [enrich] HYPE price from env: $${hypePriceUsd.toFixed(2)}`);
  }

  const pending = getUnenrichedLiquidations(db) as unknown as DbRow[];
  console.log(`  [enrich] ${pending.length} liquidation(s) to enrich`);
  if (pending.length === 0) {
    console.log('  [enrich] Nothing to do.');
    return;
  }

  let done = 0;
  let errors = 0;
  const CONCURRENCY = 3; // Limit concurrent oracle calls

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(liq =>
        enrichOne(db, mp, liq, cfg, baseCurrencyUnit, hypePriceUsd, useHistorical)
          .then(() => done++)
          .catch(err => {
            errors++;
            console.warn(`\n  [enrich] Failed for ${liq.tx_hash}: ${String(err).slice(0, 80)}`);
          }),
      ),
    );
    process.stdout.write(`\r  [enrich] ${done + errors}/${pending.length} processed (${errors} errors)   `);
    if (i + CONCURRENCY < pending.length) await sleep(200);
  }

  console.log(`\n  [enrich] ✓ Enriched: ${done}, Errors: ${errors}`);
}
