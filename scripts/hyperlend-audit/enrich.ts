/**
 * PASO 2 — USD enrichment and profit estimation.
 *
 * For each unenriched liquidation:
 *   1. Resolves asset symbol/decimals (from DB cache or on-chain)
 *   2. Gets asset price in USD from HyperLend oracle
 *      - Tries historical price at exact block (requires archive RPC)
 *        ⚠ A return of 0n from a historical call is treated as invalid
 *          (oracle not yet initialised at that block) and falls through
 *          to the current-price fetch.
 *      - Falls back to daily cached price
 *   3. Computes gross profit (= liquidated collateral USD - debt covered USD)
 *   4. Estimates gas cost in USD (HYPE is the gas token)
 *   5. Computes net profit = gross - gas
 *
 * All estimated values are clearly labeled in price_source field.
 * READ-ONLY. Idempotent.
 *
 * Env knobs:
 *   RESET_ENRICHMENT=1   — mark all rows unenriched before running (re-enrich)
 *   USE_HISTORICAL_PRICES=1 — try oracle at exact block first (default: 1)
 *   HYPE_PRICE_USD=<n>   — override HYPE gas-token price
 */

import { ethers } from 'ethers';
import { loadDiscoveredConfig } from './discover';
import {
  initDb,
  getUnenrichedLiquidations,
  updateEnrichment,
  getAsset,
  upsertAsset,
  resetEnrichment,
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
      // 0n means the oracle had no price at this block (contract not deployed yet
      // or price feed not initialised). Treat as a miss and fall through.
      if (raw > 0n) {
        return { priceUsd: Number(raw) / Number(baseCurrencyUnit), source: 'oracle_block' };
      }
    } catch {
      // Archive call failed — fall back to current price
    }
  }

  // Daily approximation: fetch current price
  try {
    const raw = await withRetry(
      () => oracle.getAssetPrice(assetAddr) as Promise<bigint>,
      `oracle.getAssetPrice(${assetAddr.slice(0, 8)})`,
      3,
      1_000,
    );
    if (raw > 0n) {
      return { priceUsd: Number(raw) / Number(baseCurrencyUnit), source: 'oracle_daily' };
    }
    // Oracle returned 0 — asset not registered or oracle not functioning
    return { priceUsd: 0, source: 'estimated' };
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

  // Fetch from chain — 3 calls, kept sequential to stay under dRPC batch limit
  const erc20 = new ethers.Contract(address, ERC20_ABI, mp.provider);
  const symbol = await withRetry(() => erc20.symbol() as Promise<string>, `symbol(${laddr})`).catch(() => 'UNKNOWN');
  const name   = await withRetry(() => erc20.name()   as Promise<string>, `name(${laddr})`).catch(() => 'UNKNOWN');
  const decimals = await withRetry(() => erc20.decimals() as Promise<bigint>, `decimals(${laddr})`).catch(() => 18n);

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

// ---- Enrich single liquidation — all oracle calls sequential ----

async function enrichOne(
  db: ReturnType<typeof initDb>,
  mp: MultiProvider,
  liq: DbRow,
  cfg: ReturnType<typeof loadDiscoveredConfig>,
  baseCurrencyUnit: bigint,
  hypePriceUsd: number,
  useHistorical: boolean,
): Promise<void> {
  // Resolve asset metadata sequentially to avoid batching ERC20 calls
  const collateralInfo = await resolveAsset(db, mp, cfg.poolDataProvider, liq.collateral_asset);
  const debtInfo       = await resolveAsset(db, mp, cfg.poolDataProvider, liq.debt_asset);

  // Oracle calls sequential — each is one eth_call, dRPC limit is 3 per batch
  const collPrice = await fetchOraclePriceAtBlock(mp, cfg.oracle, collateralInfo.address, liq.block_number, baseCurrencyUnit, useHistorical);
  const debtPrice = await fetchOraclePriceAtBlock(mp, cfg.oracle, debtInfo.address, liq.block_number, baseCurrencyUnit, useHistorical);

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

  // Optional: reset all enrichment flags so this run overwrites previous results
  if ((process.env['RESET_ENRICHMENT'] ?? '0') === '1') {
    const n = resetEnrichment(db);
    console.log(`  [enrich] RESET_ENRICHMENT=1 — marked ${n} liquidation(s) for re-enrichment`);
  }

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
          if (raw > 0n) {
            hypePriceUsd = Number(raw) / Number(baseCurrencyUnit);
            console.log(`  [enrich] HYPE price from oracle: $${hypePriceUsd.toFixed(2)}`);
            break;
          }
        } catch { /* ignore */ }
      }
    }
    if (hypePriceUsd === 0) {
      console.warn('  [enrich] ⚠ HYPE price unknown — gas cost will be $0 (set HYPE_PRICE_USD in .env for accuracy)');
    }
  } else {
    console.log(`  [enrich] HYPE price from env: $${hypePriceUsd.toFixed(2)}`);
  }

  // Pre-flight oracle check — shows raw oracle response before main loop
  const sampleAddrs = (db.prepare('SELECT DISTINCT collateral_asset FROM liquidations LIMIT 3').all() as { collateral_asset: string }[]).map(r => r.collateral_asset);
  if (sampleAddrs.length > 0) {
    console.log('  [enrich] Oracle pre-flight check (current prices):');
    const oracle = new ethers.Contract(cfg.oracle, ORACLE_ABI, mp.provider);
    for (const addr of sampleAddrs) {
      try {
        const raw = await withRetry(() => oracle.getAssetPrice(addr) as Promise<bigint>, `preflight(${addr.slice(0, 10)})`, 2, 500);
        const usd = raw > 0n ? Number(raw) / Number(baseCurrencyUnit) : 0;
        console.log(`    ${addr.slice(0, 12)}… raw=${raw}  →  $${usd.toFixed(4)}${raw === 0n ? ' ⚠ ZERO — oracle may not support this asset' : ''}`);
      } catch (err) {
        console.log(`    ${addr.slice(0, 12)}… ERROR: ${String(err).slice(0, 100)}`);
      }
    }
  }

  const pending = getUnenrichedLiquidations(db) as unknown as DbRow[];
  console.log(`  [enrich] ${pending.length} liquidation(s) to enrich`);
  if (pending.length === 0) {
    console.log('  [enrich] Nothing to do. Run with RESET_ENRICHMENT=1 to re-enrich.');
    return;
  }

  let done = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i++) {
    const liq = pending[i]!;
    try {
      await enrichOne(db, mp, liq, cfg, baseCurrencyUnit, hypePriceUsd, useHistorical);
      done++;
    } catch (err) {
      errors++;
      console.warn(`\n  [enrich] Failed for ${liq.tx_hash}: ${String(err).slice(0, 80)}`);
    }
    if (i % 10 === 0 || i === pending.length - 1) {
      process.stdout.write(`\r  [enrich] ${done + errors}/${pending.length} processed (${errors} errors)   `);
    }
    // Small pause every 20 liquidations to stay well under dRPC rate limits
    if (i > 0 && i % 20 === 0) await sleep(200);
  }

  console.log(`\n  [enrich] ✓ Enriched: ${done}, Errors: ${errors}`);
}
