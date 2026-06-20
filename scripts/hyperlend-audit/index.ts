#!/usr/bin/env ts-node
/**
 * HyperLend Liquidation Audit — Main entry point.
 *
 * Usage:
 *   npm run audit              # Full pipeline: discover → backfill → enrich → report
 *   npm run discover           # PASO 0 only (verify contracts, save discovered-config.json)
 *   npm run backfill           # PASO 1 only (fetch historical events)
 *   npm run enrich             # PASO 2 only (USD enrichment)
 *   npm run report             # PASO 3/4 only (metrics + markdown)
 *
 * READ-ONLY. No transactions. No private key needed.
 * Set HYPEREVM_RPC_URL in .env before running.
 */

import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (../../) or local directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') }); // local override

import { MultiProvider } from './rpc';
import { discover } from './discover';
import { backfill } from './backfill';
import { enrich } from './enrich';
import { generateReport, printSummary } from './report';
import { initDb } from './db';

function buildProviderUrls(): string[] {
  const urls: string[] = [];
  if (process.env['HYPEREVM_RPC_URL']) urls.push(process.env['HYPEREVM_RPC_URL']);
  // Add numbered fallbacks
  for (let i = 1; i <= 5; i++) {
    const fb = process.env[`HYPEREVM_RPC_FALLBACK_${i}`];
    if (fb) urls.push(fb);
  }
  // Always ensure public RPC is last
  const publicRpc = 'https://rpc.hyperliquid.xyz/evm';
  if (!urls.includes(publicRpc)) urls.push(publicRpc);
  return urls;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stepArg = args.find(a => a.startsWith('--step='));
  const step = stepArg ? stepArg.split('=')[1] ?? 'all' : 'all';

  const urls = buildProviderUrls();
  console.log(`\nHyperLend Liquidation Audit`);
  console.log(`RPC providers: ${urls.length} (${urls[0]?.includes('rpc.hyperliquid') ? '⚠ Public only — no archive' : '✓ Archive configured'})`);
  console.log(`Step: ${step}`);
  console.log(`Days back: ${process.env['DAYS_BACK'] ?? '60'}`);

  if (!process.env['HYPEREVM_RPC_URL']) {
    console.warn('\n⚠ HYPEREVM_RPC_URL not set. Using public RPC only.');
    console.warn('  Historical getLogs may fail without an archive node.');
    console.warn('  Set HYPEREVM_RPC_URL in .env for full functionality.\n');
  }

  const mp = new MultiProvider(urls, 100 /* publicRateLimit req/min */);
  const db = initDb();

  if (step === 'discover' || step === 'all') {
    await discover(mp);
  }

  if (step === 'backfill' || step === 'all') {
    await backfill(mp);
  }

  if (step === 'enrich' || step === 'all') {
    await enrich(mp);
  }

  if (step === 'report' || step === 'all') {
    const metrics = await generateReport(db);
    printSummary(metrics);
  }
}

main().catch(err => {
  console.error('\n[fatal]', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
