import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { LiquidationRaw, EnrichedFields, AssetInfo, BackfillProgress } from './types';

export const DB_PATH = path.resolve(__dirname, '../../bot/data/hyperlend-audit.db');

export function initDb(dbPath = DB_PATH): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS liquidations (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash                     TEXT    NOT NULL,
      log_index                   INTEGER NOT NULL,
      block_number                INTEGER NOT NULL,
      block_timestamp             INTEGER NOT NULL,
      liquidator                  TEXT    NOT NULL,
      borrower                    TEXT    NOT NULL,
      collateral_asset            TEXT    NOT NULL,
      debt_asset                  TEXT    NOT NULL,
      debt_to_cover               TEXT    NOT NULL,
      liquidated_collateral_amount TEXT   NOT NULL,
      receive_atoken              INTEGER NOT NULL,
      gas_used                    INTEGER,
      effective_gas_price         TEXT,
      -- enriched fields (NULL until enrich step)
      collateral_symbol           TEXT,
      debt_symbol                 TEXT,
      collateral_decimals         INTEGER,
      debt_decimals               INTEGER,
      debt_to_cover_usd           REAL,
      liquidated_collateral_usd   REAL,
      liquidation_bonus_bps       INTEGER,
      gross_profit_usd            REAL,
      gas_cost_usd                REAL,
      net_profit_usd              REAL,
      price_source                TEXT,
      enriched                    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS idx_liq_block   ON liquidations(block_number);
    CREATE INDEX IF NOT EXISTS idx_liq_liqaddr ON liquidations(liquidator);
    CREATE INDEX IF NOT EXISTS idx_liq_enriched ON liquidations(enriched);

    CREATE TABLE IF NOT EXISTS assets (
      address                     TEXT    PRIMARY KEY,
      symbol                      TEXT,
      name                        TEXT,
      decimals                    INTEGER,
      liquidation_bonus_bps       INTEGER,
      liquidation_threshold_bps   INTEGER,
      ltv_bps                     INTEGER,
      last_price_usd              REAL,
      last_price_timestamp        INTEGER
    );

    CREATE TABLE IF NOT EXISTS backfill_progress (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      from_block    INTEGER NOT NULL,
      to_block      INTEGER NOT NULL,
      current_block INTEGER NOT NULL,
      completed     INTEGER NOT NULL DEFAULT 0,
      last_updated  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calldata_samples (
      tx_hash          TEXT    PRIMARY KEY,
      liquidator       TEXT    NOT NULL,
      calldata_bytes   INTEGER NOT NULL,
      fetched_at       INTEGER NOT NULL
    );
  `);

  return db;
}

// ---- Liquidation upserts ----

export function upsertLiquidation(db: Database.Database, liq: LiquidationRaw): void {
  db.prepare(`
    INSERT OR IGNORE INTO liquidations
      (tx_hash, log_index, block_number, block_timestamp, liquidator, borrower,
       collateral_asset, debt_asset, debt_to_cover, liquidated_collateral_amount,
       receive_atoken, gas_used, effective_gas_price)
    VALUES
      (@txHash, @logIndex, @blockNumber, @blockTimestamp, @liquidator, @borrower,
       @collateralAsset, @debtAsset, @debtToCover, @liquidatedCollateralAmount,
       @receiveAToken, @gasUsed, @effectiveGasPrice)
  `).run({
    txHash: liq.txHash,
    logIndex: liq.logIndex,
    blockNumber: liq.blockNumber,
    blockTimestamp: liq.blockTimestamp,
    liquidator: liq.liquidator.toLowerCase(),
    borrower: liq.borrower.toLowerCase(),
    collateralAsset: liq.collateralAsset.toLowerCase(),
    debtAsset: liq.debtAsset.toLowerCase(),
    debtToCover: liq.debtToCover,
    liquidatedCollateralAmount: liq.liquidatedCollateralAmount,
    receiveAToken: liq.receiveAToken ? 1 : 0,
    gasUsed: liq.gasUsed ?? null,
    effectiveGasPrice: liq.effectiveGasPrice ?? null,
  });
}

export function batchUpsertLiquidations(db: Database.Database, liqs: LiquidationRaw[]): void {
  const insert = db.transaction((rows: LiquidationRaw[]) => {
    for (const r of rows) upsertLiquidation(db, r);
  });
  insert(liqs);
}

// ---- Enrichment update ----

export function updateEnrichment(
  db: Database.Database,
  txHash: string,
  logIndex: number,
  e: EnrichedFields,
): void {
  db.prepare(`
    UPDATE liquidations SET
      collateral_symbol         = @collateralSymbol,
      debt_symbol               = @debtSymbol,
      collateral_decimals       = @collateralDecimals,
      debt_decimals             = @debtDecimals,
      debt_to_cover_usd         = @debtToCoverUsd,
      liquidated_collateral_usd = @liquidatedCollateralUsd,
      liquidation_bonus_bps     = @liquidationBonusBps,
      gross_profit_usd          = @grossProfitUsd,
      gas_cost_usd              = @gasCostUsd,
      net_profit_usd            = @netProfitUsd,
      price_source              = @priceSource,
      enriched                  = 1
    WHERE tx_hash = @txHash AND log_index = @logIndex
  `).run({ ...e, txHash, logIndex });
}

// ---- Asset cache ----

export function upsertAsset(db: Database.Database, a: AssetInfo, priceUsd?: number): void {
  db.prepare(`
    INSERT INTO assets (address, symbol, name, decimals, liquidation_bonus_bps,
                        liquidation_threshold_bps, ltv_bps, last_price_usd, last_price_timestamp)
    VALUES (@address, @symbol, @name, @decimals, @liquidationBonusBps,
            @liquidationThresholdBps, @ltvBps, @lastPriceUsd, @lastPriceTimestamp)
    ON CONFLICT(address) DO UPDATE SET
      symbol                  = excluded.symbol,
      name                    = excluded.name,
      decimals                = excluded.decimals,
      liquidation_bonus_bps   = excluded.liquidation_bonus_bps,
      liquidation_threshold_bps = excluded.liquidation_threshold_bps,
      ltv_bps                 = excluded.ltv_bps,
      last_price_usd          = COALESCE(excluded.last_price_usd, assets.last_price_usd),
      last_price_timestamp    = COALESCE(excluded.last_price_timestamp, assets.last_price_timestamp)
  `).run({
    address: a.address.toLowerCase(),
    symbol: a.symbol,
    name: a.name,
    decimals: a.decimals,
    liquidationBonusBps: a.liquidationBonusBps,
    liquidationThresholdBps: a.liquidationThresholdBps,
    ltvBps: a.ltvBps,
    lastPriceUsd: priceUsd ?? null,
    lastPriceTimestamp: priceUsd != null ? Math.floor(Date.now() / 1000) : null,
  });
}

interface AssetDbRow {
  address: string; symbol: string; name: string; decimals: number;
  liquidation_bonus_bps: number; liquidation_threshold_bps: number; ltv_bps: number;
  last_price_usd: number | null; last_price_timestamp: number | null;
}

function mapAssetRow(row: AssetDbRow): AssetInfo {
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals ?? 18,
    liquidationBonusBps: row.liquidation_bonus_bps ?? 0,
    liquidationThresholdBps: row.liquidation_threshold_bps ?? 0,
    ltvBps: row.ltv_bps ?? 0,
  };
}

export function getAsset(db: Database.Database, address: string): AssetInfo | undefined {
  const row = db.prepare('SELECT * FROM assets WHERE address = ?')
    .get(address.toLowerCase()) as AssetDbRow | undefined;
  return row ? mapAssetRow(row) : undefined;
}

// ---- Progress ----

export function getBackfillProgress(db: Database.Database): BackfillProgress | undefined {
  const row = db.prepare('SELECT * FROM backfill_progress WHERE id = 1').get() as
    | { from_block: number; to_block: number; current_block: number; completed: number; last_updated: number }
    | undefined;
  if (!row) return undefined;
  return {
    fromBlock: row.from_block,
    toBlock: row.to_block,
    currentBlock: row.current_block,
    completed: row.completed === 1,
    lastUpdated: row.last_updated,
  };
}

export function setBackfillProgress(db: Database.Database, p: BackfillProgress): void {
  db.prepare(`
    INSERT INTO backfill_progress (id, from_block, to_block, current_block, completed, last_updated)
    VALUES (1, @fromBlock, @toBlock, @currentBlock, @completed, @lastUpdated)
    ON CONFLICT(id) DO UPDATE SET
      from_block    = excluded.from_block,
      to_block      = excluded.to_block,
      current_block = excluded.current_block,
      completed     = excluded.completed,
      last_updated  = excluded.last_updated
  `).run({ ...p, completed: p.completed ? 1 : 0, lastUpdated: p.lastUpdated });
}

// ---- Query helpers ----

export function countLiquidations(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as n FROM liquidations').get() as { n: number }).n;
}

export function resetEnrichment(db: Database.Database): number {
  return db.prepare('UPDATE liquidations SET enriched = 0').run().changes;
}

export function getUnenrichedLiquidations(db: Database.Database): LiquidationRaw[] {
  return db.prepare('SELECT * FROM liquidations WHERE enriched = 0 ORDER BY block_number').all() as LiquidationRaw[];
}

export function getAllLiquidations(db: Database.Database): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM liquidations ORDER BY block_number').all() as Record<string, unknown>[];
}

export function getEnrichedLiquidations(db: Database.Database): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM liquidations WHERE enriched = 1 ORDER BY block_number').all() as Record<string, unknown>[];
}

export function upsertCalldataSample(db: Database.Database, txHash: string, liquidator: string, bytes: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO calldata_samples (tx_hash, liquidator, calldata_bytes, fetched_at)
    VALUES (?, ?, ?, ?)
  `).run(txHash, liquidator.toLowerCase(), bytes, Math.floor(Date.now() / 1000));
}

export function getCalldataAvgByLiquidator(db: Database.Database): Record<string, number> {
  const rows = db.prepare(`
    SELECT liquidator, AVG(calldata_bytes) as avg_bytes
    FROM calldata_samples GROUP BY liquidator
  `).all() as { liquidator: string; avg_bytes: number }[];
  return Object.fromEntries(rows.map(r => [r.liquidator, Math.round(r.avg_bytes)]));
}
