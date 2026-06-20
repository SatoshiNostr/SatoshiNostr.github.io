/**
 * PASO 3 & 4 — Metrics computation and GO/NO-GO report.
 *
 * Reads all enriched liquidations from SQLite, computes decision metrics,
 * writes a markdown report, and prints a 10-line console summary.
 *
 * READ-ONLY (from DB perspective). No chain calls.
 */

import fs from 'fs';
import path from 'path';
import { initDb, getEnrichedLiquidations, getAllLiquidations, getCalldataAvgByLiquidator } from './db';
import type { AuditMetrics, DailyStats, LiquidatorStats, PairStats } from './types';

const REPORTS_DIR = path.resolve(__dirname, '../../reports');

// ---- Statistical helpers ----

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function computeHHI(shares: number[]): number {
  const total = shares.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return shares.reduce((hhi, s) => {
    const pct = (s / total) * 100;
    return hhi + pct * pct;
  }, 0);
}

function hhiLabel(hhi: number): string {
  if (hhi < 1500) return 'Competitivo';
  if (hhi < 2500) return 'Moderadamente concentrado';
  return 'OLIGOPOLIO (alta concentración)';
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ---- Metrics computation ----

type Row = Record<string, unknown>;

export function computeMetrics(db: ReturnType<typeof initDb>): AuditMetrics {
  const all = getAllLiquidations(db) as Row[];
  const enriched = getEnrichedLiquidations(db) as Row[];
  const calldataAvg = getCalldataAvgByLiquidator(db);

  const minProfitThreshold = parseFloat(process.env['MIN_PROFIT_USDC'] ?? '50');
  const daysRequested = parseInt(process.env['DAYS_BACK'] ?? '60', 10);

  if (all.length === 0) {
    const now = Math.floor(Date.now() / 1000);
    return {
      fromBlock: 0, toBlock: 0, fromDate: 'N/A', toDate: 'N/A', daysObserved: 0,
      totalLiquidations: 0, totalVolumeUsd: 0, medianVolumeUsd: 0, p90VolumeUsd: 0, maxVolumeUsd: 0,
      minNetProfitUsd: 0, medianNetProfitUsd: 0, meanNetProfitUsd: 0, p90NetProfitUsd: 0, maxNetProfitUsd: 0,
      pctAboveMinProfit: 0,
      uniqueLiquidators: 0, top1Share: 0, top3Share: 0, top5Share: 0, hhi: 0,
      topLiquidators: [], dailyBreakdown: [], topPairs: [],
      enrichedCount: 0, priceSourceBreakdown: {},
      minProfitThreshold, daysRequested,
    };
  }

  const fromBlock = Math.min(...all.map(r => r['block_number'] as number));
  const toBlock = Math.max(...all.map(r => r['block_number'] as number));
  const fromTs = Math.min(...all.map(r => r['block_timestamp'] as number));
  const toTs = Math.max(...all.map(r => r['block_timestamp'] as number));
  const daysObserved = Math.ceil((toTs - fromTs) / 86_400);

  // Volume metrics (USD, from enriched only — fall back to count for unenriched)
  const volumes = enriched.map(r => r['liquidated_collateral_usd'] as number).filter(v => v > 0).sort((a, b) => a - b);
  const totalVolumeUsd = volumes.reduce((a, b) => a + b, 0);

  // Profit metrics
  const profits = enriched.map(r => r['net_profit_usd'] as number).sort((a, b) => a - b);
  const aboveThreshold = profits.filter(p => p >= minProfitThreshold).length;

  // Liquidator concentration
  const liquidatorCounts = new Map<string, { count: number; volumeUsd: number; profitUsd: number }>();
  for (const r of all) {
    const addr = (r['liquidator'] as string).toLowerCase();
    const existing = liquidatorCounts.get(addr) ?? { count: 0, volumeUsd: 0, profitUsd: 0 };
    existing.count += 1;
    existing.volumeUsd += (r['liquidated_collateral_usd'] as number) ?? 0;
    existing.profitUsd += (r['net_profit_usd'] as number) ?? 0;
    liquidatorCounts.set(addr, existing);
  }
  const sortedLiquidators = [...liquidatorCounts.entries()].sort((a, b) => b[1].count - a[1].count);
  const totalLiqCount = all.length;
  const hhi = computeHHI(sortedLiquidators.map(([, v]) => v.count));
  const top1Share = sortedLiquidators.slice(0, 1).reduce((s, [, v]) => s + v.count, 0) / totalLiqCount * 100;
  const top3Share = sortedLiquidators.slice(0, 3).reduce((s, [, v]) => s + v.count, 0) / totalLiqCount * 100;
  const top5Share = sortedLiquidators.slice(0, 5).reduce((s, [, v]) => s + v.count, 0) / totalLiqCount * 100;

  const topLiquidators: LiquidatorStats[] = sortedLiquidators.slice(0, 10).map(([addr, v]) => ({
    address: addr,
    count: v.count,
    sharePercent: (v.count / totalLiqCount) * 100,
    totalVolumeUsd: v.volumeUsd,
    totalProfitUsd: v.profitUsd,
    avgCalldataBytes: calldataAvg[addr] ?? null,
  }));

  // Daily breakdown
  const dailyMap = new Map<string, { count: number; volumeUsd: number; profitUsd: number }>();
  for (const r of all) {
    const date = fmtDate(r['block_timestamp'] as number);
    const existing = dailyMap.get(date) ?? { count: 0, volumeUsd: 0, profitUsd: 0 };
    existing.count += 1;
    existing.volumeUsd += (r['liquidated_collateral_usd'] as number) ?? 0;
    existing.profitUsd += (r['net_profit_usd'] as number) ?? 0;
    dailyMap.set(date, existing);
  }
  const dailyBreakdown: DailyStats[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, count: v.count, volumeUsd: v.volumeUsd, profitUsd: v.profitUsd }));

  // Top asset pairs
  const pairMap = new Map<string, { count: number; volumeUsd: number }>();
  for (const r of enriched) {
    const key = `${r['collateral_symbol']}→${r['debt_symbol']}`;
    const existing = pairMap.get(key) ?? { count: 0, volumeUsd: 0 };
    existing.count += 1;
    existing.volumeUsd += (r['liquidated_collateral_usd'] as number) ?? 0;
    pairMap.set(key, existing);
  }
  const topPairs: PairStats[] = [...pairMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([key, v]) => {
      const [c, d] = key.split('→');
      return { collateralSymbol: c ?? '', debtSymbol: d ?? '', count: v.count, totalVolumeUsd: v.volumeUsd };
    });

  // Price source breakdown
  const priceSourceBreakdown: Record<string, number> = {};
  for (const r of enriched) {
    const src = (r['price_source'] as string) ?? 'unknown';
    priceSourceBreakdown[src] = (priceSourceBreakdown[src] ?? 0) + 1;
  }

  return {
    fromBlock, toBlock, fromDate: fmtDate(fromTs), toDate: fmtDate(toTs), daysObserved,
    totalLiquidations: all.length,
    totalVolumeUsd,
    medianVolumeUsd: percentile(volumes, 50),
    p90VolumeUsd: percentile(volumes, 90),
    maxVolumeUsd: volumes[volumes.length - 1] ?? 0,
    minNetProfitUsd: profits[0] ?? 0,
    medianNetProfitUsd: percentile(profits, 50),
    meanNetProfitUsd: mean(profits),
    p90NetProfitUsd: percentile(profits, 90),
    maxNetProfitUsd: profits[profits.length - 1] ?? 0,
    pctAboveMinProfit: profits.length ? (aboveThreshold / profits.length) * 100 : 0,
    uniqueLiquidators: liquidatorCounts.size,
    top1Share, top3Share, top5Share, hhi,
    topLiquidators, dailyBreakdown, topPairs,
    enrichedCount: enriched.length,
    priceSourceBreakdown,
    minProfitThreshold, daysRequested,
  };
}

// ---- Markdown generation ----

function mkTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function projectedMonthly(m: AuditMetrics, captureShare: number): { volume: number; profit: number; count: number } {
  const days = m.daysObserved || 1;
  return {
    count: Math.round((m.totalLiquidations / days * 30) * captureShare),
    volume: (m.totalVolumeUsd / days * 30) * captureShare,
    profit: (m.medianNetProfitUsd * (m.totalLiquidations / days * 30)) * captureShare,
  };
}

export function generateMarkdown(m: AuditMetrics): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# HyperLend Liquidation Audit — ${date}`);
  lines.push('');
  lines.push('> **READ-ONLY audit. No transactions. No keys. All estimates clearly labeled.**');
  lines.push(`> Period: ${m.fromDate} → ${m.toDate} (${m.daysObserved} days observed)`);
  lines.push(`> Blocks: #${m.fromBlock.toLocaleString()} → #${m.toBlock.toLocaleString()}`);
  lines.push(`> Enrichment coverage: ${m.enrichedCount}/${m.totalLiquidations} liquidations (${m.totalLiquidations ? ((m.enrichedCount / m.totalLiquidations) * 100).toFixed(0) : 0}%)`);
  lines.push(`> Price sources: ${Object.entries(m.priceSourceBreakdown).map(([k, v]) => `${k}=${v}`).join(', ') || 'N/A'}`);
  lines.push('');

  // ── Section 1: Volume ──
  lines.push('## 1. Volumen Direccionable');
  lines.push('');
  lines.push(mkTable(
    ['Métrica', 'Valor', 'Nota'],
    [
      ['Total liquidaciones', m.totalLiquidations.toString(), 'MEDIDO'],
      ['Volumen total liquidado (USD)', fmtUsd(m.totalVolumeUsd), m.enrichedCount ? 'MEDIDO*' : 'N/A (sin enriquecimiento)'],
      ['Volumen mediano por liquidación', fmtUsd(m.medianVolumeUsd), 'MEDIDO*'],
      ['Volumen P90 por liquidación', fmtUsd(m.p90VolumeUsd), 'MEDIDO*'],
      ['Volumen máximo', fmtUsd(m.maxVolumeUsd), 'MEDIDO*'],
    ],
  ));
  lines.push('');
  lines.push('`*` = precio del oracle HyperLend. Ver columna `price_source` en DB para precisión por evento.');
  lines.push('');

  if (m.dailyBreakdown.length > 0) {
    lines.push('### Distribución temporal diaria');
    lines.push('');
    const peakDay = m.dailyBreakdown.reduce((a, b) => a.count > b.count ? a : b);
    lines.push(mkTable(
      ['Fecha', 'Liquidaciones', 'Volumen (USD)', 'Profit neto (USD)'],
      m.dailyBreakdown.map(d => [
        d.date + (d.date === peakDay.date ? ' 🔺' : ''),
        d.count.toString(),
        fmtUsd(d.volumeUsd),
        fmtUsd(d.profitUsd),
      ]),
    ));
    lines.push('');
    lines.push(`> Pico: ${peakDay.date} con ${peakDay.count} liquidaciones. Correlacionar con movimientos de precio HYPE/ETH/BTC ese día.`);
    lines.push('');
  }

  // ── Section 2: Rentabilidad ──
  lines.push('## 2. Rentabilidad');
  lines.push('');
  if (m.enrichedCount === 0) {
    lines.push('> ⚠ Sin datos de enriquecimiento. Ejecutar `npm run enrich` con RPC funcional.');
  } else {
    lines.push(mkTable(
      ['Métrica', 'Valor', 'Nota'],
      [
        ['Profit neto mínimo', fmtUsd(m.minNetProfitUsd), 'ESTIMADO (gas≈$0 si HYPE price unknown)'],
        ['Profit neto mediano', fmtUsd(m.medianNetProfitUsd), 'ESTIMADO'],
        ['Profit neto medio', fmtUsd(m.meanNetProfitUsd), 'ESTIMADO'],
        ['Profit neto P90', fmtUsd(m.p90NetProfitUsd), 'ESTIMADO'],
        ['Profit neto máximo', fmtUsd(m.maxNetProfitUsd), 'ESTIMADO'],
        [`% liquidaciones > $${m.minProfitThreshold}`, fmtPct(m.pctAboveMinProfit), 'ESTIMADO'],
      ],
    ));
    lines.push('');
    lines.push('> Gas cost estimado con precio de HYPE del momento del enriquecimiento, no del bloque exacto.');
    lines.push('> Gross profit = collateral liquidado (USD) − deuda cubierta (USD). El bonus está implícito en el collateral.');
  }
  lines.push('');

  // ── Section 3: Competencia ──
  lines.push('## 3. Competencia (factor más crítico)');
  lines.push('');
  lines.push(mkTable(
    ['Métrica', 'Valor', 'Clasificación'],
    [
      ['Liquidadores únicos', m.uniqueLiquidators.toString(), ''],
      ['Cuota top-1', fmtPct(m.top1Share), m.top1Share > 50 ? 'MONOPOLIO DE FACTO' : m.top1Share > 30 ? 'DOMINANTE' : 'Distribuido'],
      ['Cuota top-3', fmtPct(m.top3Share), ''],
      ['Cuota top-5', fmtPct(m.top5Share), ''],
      ['HHI (0-10000)', m.hhi.toFixed(0), hhiLabel(m.hhi)],
    ],
  ));
  lines.push('');

  if (m.topLiquidators.length > 0) {
    lines.push('### Top liquidadores');
    lines.push('');
    lines.push(mkTable(
      ['#', 'Dirección', 'Count', 'Share%', 'Volumen (USD)', 'Profit (USD)', 'Calldata avg (bytes)'],
      m.topLiquidators.slice(0, 10).map((l, i) => [
        (i + 1).toString(),
        `\`${l.address.slice(0, 10)}…\``,
        l.count.toString(),
        fmtPct(l.sharePercent),
        fmtUsd(l.totalVolumeUsd),
        fmtUsd(l.totalProfitUsd),
        l.avgCalldataBytes != null ? `${l.avgCalldataBytes} bytes` : 'N/A (ejecutar --calldata)',
      ]),
    ));
    lines.push('');
    lines.push('> **Verificar manualmente en purrsec.com o hyperevmscan.io** las direcciones top para identificar si son contratos o EOAs, y si usan flash loans.');
  }
  lines.push('');

  // ── Section 4: Caracterización competidores ──
  lines.push('## 4. Caracterización de competidores');
  lines.push('');
  lines.push('| Aspecto | Observación |');
  lines.push('| --- | --- |');
  lines.push(`| Calldata footprint | ${m.topLiquidators.some(l => l.avgCalldataBytes != null) ? 'Ver tabla arriba' : 'NO DISPONIBLE — ejecutar backfill con --calldata flag'} |`);
  lines.push('| Flash loan on-chain | REQUIERE INSPECCIÓN MANUAL de llamadas internas en explorer |');
  lines.push('| Bridge a HyperCore CLOB | REQUIERE INSPECCIÓN MANUAL de contratos tocados |');
  lines.push('| Mi baseline calldata | ~30 bytes (V8 ABI parametrizado) |');
  lines.push('');
  lines.push('> ⚠ **Acción manual requerida**: Para cada dirección top, inspeccionar en [purrsec.com](https://purrsec.com) o [hyperevmscan.io](https://hyperevmscan.io):');
  lines.push('> 1. ¿Es contrato o EOA?');
  lines.push('> 2. ¿Llama a un DEX on-chain (HyperSwap/etc.) para swap del collateral?');
  lines.push('> 3. ¿Hace bridging a HyperCore orderbook?');
  lines.push('> 4. ¿Tamaño del calldata consistente con flash loan (>200 bytes) o liquidación simple (<100 bytes)?');
  lines.push('');

  // ── Section 5: Dinámica gas/ordering ──
  lines.push('## 5. Dinámica de gas y ordering');
  lines.push('');
  lines.push(mkTable(
    ['Factor', 'HyperEVM (HyperBFT)', 'Implicación para bot'],
    [
      ['Priority fee', 'QUEMADA (va a 0x0)', 'No remunera al validator — pero SÍ determina orden en mempool'],
      ['Gas ordering', 'gasPrice DESC dentro del mempool', 'Bidding de gas SÍ funciona para priority; coste = fee quemada'],
      ['Tipo de mempool', 'Público', 'Visible para todos — sin dark pool ni bundles privados conocidos'],
      ['Block builder', 'HyperBFT (no PBS)', 'Sin FlashBots/FastLane equivalente conocido en HyperEVM'],
      ['Fast blocks', '~2s, 2M gas', 'Baja latencia confirmación'],
      ['Slow blocks', '~60s, 30M gas', 'Para txs complejas (flash loan + swap)'],
      ['Edge latencia', 'Relevante (FCFS + gasPrice)', 'Mi edge de calldata compacto SÍ aplica aquí'],
    ],
  ));
  lines.push('');
  lines.push('> **Conclusión gas/ordering**: A diferencia de Arbitrum (FastLane Atlas bundles), en HyperEVM el ordering es por gasPrice puro en mempool público. El fee se quema pero el ORDEN sí depende del gas. Esto es SIMILAR a Ethereum pre-PBS. Mi edge de calldata pequeño + latencia es APLICABLE, aunque requiere nodo cercano al validador HyperBFT.');
  lines.push('> **NECESITA MÁS DATOS**: Confirmar si existe algún builder privado o mecanismo de bundle en HyperEVM (búsqueda activa 2026).');
  lines.push('');

  // ── Section 6: Liquidez de salida ──
  lines.push('## 6. Liquidez de salida (DEX on-chain)');
  lines.push('');
  if (m.topPairs.length === 0) {
    lines.push('> Sin datos de pares. Requiere enriquecimiento.');
  } else {
    lines.push(mkTable(
      ['Par (collateral→debt)', 'Count', 'Volumen (USD)', 'Liquidez DEX on-chain', 'Riesgo de salida'],
      m.topPairs.map(p => [
        `${p.collateralSymbol}→${p.debtSymbol}`,
        p.count.toString(),
        fmtUsd(p.totalVolumeUsd),
        'VERIFICAR MANUALMENTE',
        'VERIFICAR MANUALMENTE',
      ]),
    ));
    lines.push('');
    lines.push('> ⚠ **Acción manual requerida**: Para cada par top, verificar en HyperSwap (u otro DEX on-chain en HyperEVM):');
    lines.push('> - Profundidad de liquidez del par collateral/debt o collateral/USDC');
    lines.push('> - Si no hay DEX on-chain con liquidez, el colateral debe bridgearse a HyperCore para vender → +latencia +riesgo de precio');
    lines.push('> - Tokens exóticos sin par en ningún DEX = riesgo de no poder cerrar la posición atomicamente');
  }
  lines.push('');

  // ── Section 7: GO/NO-GO ──
  lines.push('## 7. Veredicto GO / NO-GO');
  lines.push('');
  const p5 = projectedMonthly(m, 0.05);
  const p15 = projectedMonthly(m, 0.15);
  const p30 = projectedMonthly(m, 0.30);

  lines.push('### Proyección mensual si capturo X% del flujo');
  lines.push('');
  lines.push(mkTable(
    ['Escenario', 'Captura', 'Liquidaciones/mes', 'Volumen mensual', 'Profit mensual (mediana)'],
    [
      ['Conservador', '5%', p5.count.toString(), fmtUsd(p5.volume), fmtUsd(p5.profit)],
      ['Medio', '15%', p15.count.toString(), fmtUsd(p15.volume), fmtUsd(p15.profit)],
      ['Optimista', '30%', p30.count.toString(), fmtUsd(p30.volume), fmtUsd(p30.profit)],
    ],
  ));
  lines.push('');
  lines.push('> ⚠ ESTIMADO. Basado en mediana de profit por liquidación × proyección mensual.');
  lines.push('');

  lines.push('### Comparación HyperLend vs baseline Arbitrum Aave V3');
  lines.push('');
  lines.push(mkTable(
    ['Factor', 'HyperLend (HyperEVM)', 'Arbitrum Aave V3 (baseline)', 'Ventaja'],
    [
      ['Liquidaciones/mes (total mercado)', `~${Math.round(m.totalLiquidations / (m.daysObserved || 1) * 30)}`, '~0 capturadas (184K borrowers)', m.totalLiquidations > 0 ? '✓ HyperLend' : '? Ambos vacíos'],
      ['Volumen mediano/liquidación', fmtUsd(m.medianVolumeUsd), 'N/A (0 capturadas)', 'NECESITA MÁS DATOS'],
      ['Profit mediano/liquidación', fmtUsd(m.medianNetProfitUsd), 'N/A', 'NECESITA MÁS DATOS'],
      ['Concentración (HHI)', `${m.hhi.toFixed(0)} — ${hhiLabel(m.hhi)}`, 'FastLane Atlas = oligopolio cerrado', m.hhi < 2500 ? '✓ HyperLend más abierto' : '✗ Ambos oligopólicos'],
      ['Gas/ordering edge aplica', 'SÍ (gasPrice ordena, mempool público)', 'NO (FastLane bundles privados)', '✓ HyperLend'],
      ['Esfuerzo integración', 'MEDIO (Aave V3 fork, reutilizo ABI)', 'BASE (ya integrado)', '✓ Arbitrum'],
      ['Liquidez de salida DEX', 'VERIFICAR MANUALMENTE', 'Alta (Uniswap, Balancer, etc.)', '? Por confirmar'],
      ['Riesgo bridge HyperCore', 'POSIBLE si no hay DEX on-chain', 'Sin bridge necesario', '? Por confirmar'],
    ],
  ));
  lines.push('');

  // Verdict logic
  let verdict: string;
  let reasoning: string;

  if (m.totalLiquidations === 0) {
    verdict = '🔴 NO-GO (por ahora)';
    reasoning = 'Cero liquidaciones encontradas en el período. O el mercado es demasiado pequeño, o el RPC no tiene acceso a datos históricos. **VERIFICAR con archive node antes de descartar.**';
  } else if (m.hhi > 5000 && m.top1Share > 70) {
    verdict = '🔴 NO-GO';
    reasoning = `Mercado ultra-concentrado (HHI=${m.hhi.toFixed(0)}, top-1=${fmtPct(m.top1Share)}). El liquidador dominante probablemente tiene ventaja estructural no replicable (nodo validador, acceso preferente). **Esfuerzo de integración no compensa la probabilidad de captura.**`;
  } else if (m.totalLiquidations > 20 && m.medianNetProfitUsd > 100 && m.hhi < 3500) {
    verdict = '🟢 GO — con verificación manual previa';
    reasoning = `Mercado activo (${m.totalLiquidations} liq en ${m.daysObserved}d), profit mediano ${fmtUsd(m.medianNetProfitUsd)}, HHI ${m.hhi.toFixed(0)} (contestable). Mi edge de calldata/latencia aplica en HyperEVM (mempool público + gasPrice ordering). Integración MEDIA: reutilizo Aave V3 ABI. **Verificar liquidez DEX on-chain antes de desplegar.**`;
  } else if (m.totalLiquidations > 5) {
    verdict = '🟡 NECESITA MÁS DATOS';
    reasoning = `Mercado con actividad (${m.totalLiquidations} liq), pero datos insuficientes para decidir. Verificar: (1) archive RPC para precios históricos precisos, (2) liquidez DEX on-chain para pares top, (3) comportamiento de competidores (flash loan on-chain vs bridge).`;
  } else {
    verdict = '🟡 NECESITA MÁS DATOS';
    reasoning = 'Muestra pequeña. Extender período o verificar que el RPC tiene acceso a datos históricos completos.';
  }

  lines.push(`### Veredicto: ${verdict}`);
  lines.push('');
  lines.push(`**Razonamiento**: ${reasoning}`);
  lines.push('');
  lines.push('### Jerarquía de decisión aplicada');
  lines.push('1. **Riesgo mínimo de pérdida**: Gas cost bajo en HyperEVM (base fee quemada). Sin MEV de bundle privado = sin riesgo de frontrunning "invisible". Riesgo principal: concentración del mercado.');
  lines.push('2. **Mínima inversión**: Reutilizo Aave V3 ABI parametrizado (V8). Sin nuevo contrato si el protocolo es Aave-compatible. Sólo integración de RPC + scanner.');
  lines.push('3. **Máxima rentabilidad**: Depende de profit/liq × cuota capturable. Ver tabla de proyección.');
  lines.push('');

  // ── Caveats & Manual Checks ──
  lines.push('## Acciones manuales requeridas ANTES de fiarme de este informe');
  lines.push('');
  lines.push('1. **Verificar direcciones de contrato** en [hyperevmscan.io](https://hyperevmscan.io) o [purrsec.com](https://purrsec.com):');
  lines.push(`   - Pool: \`${process.env['POOL_ADDRESS'] ?? 'ver discovered-config.json'}\``);
  lines.push('   - Confirmar que el nombre del contrato es "Pool" o similar de HyperLend, NO otro protocolo.');
  lines.push('2. **Validar topic0** del evento LiquidationCall: comparar `liquidationCallTopic0` en `discovered-config.json` con los topics reales de una tx de liquidación conocida.');
  lines.push('3. **Top liquidadores**: Para cada dirección del top-5, buscar en el explorer:');
  lines.push('   - ¿Contrato verificado? ¿Tiene lógica de flash loan?');
  lines.push('   - ¿Qué contratos llama internamente (DEX, bridge)?');
  lines.push('4. **Liquidez DEX**: Verificar pares de la Sección 6 en HyperSwap o equivalente.');
  lines.push('5. **Enriquecimiento con archive RPC**: Si `price_source` es mayoritariamente `oracle_daily`, los profits USD son APROXIMADOS. Usar archive node y `USE_HISTORICAL_PRICES=1` para precisión.');
  lines.push('6. **Mercados aislados**: HyperLend puede tener pares aislados adicionales no incluidos en este scan (solo se escaneó el Pool principal). Revisar docs para direcciones adicionales.');
  lines.push('');

  lines.push('---');
  lines.push(`*Generado por scripts/hyperlend-audit — ${new Date().toISOString()}*`);

  return lines.join('\n');
}

// ---- Main export ----

export async function generateReport(db: ReturnType<typeof initDb>): Promise<AuditMetrics> {
  console.log('\n=== PASO 3 & 4: Métricas y reporte ===');

  const m = computeMetrics(db);
  const markdown = generateMarkdown(m);

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const reportPath = path.join(REPORTS_DIR, `HYPERLEND_AUDIT_${reportDate}.md`);
  fs.writeFileSync(reportPath, markdown, 'utf8');
  console.log(`  [report] ✓ Markdown report saved: ${reportPath}`);

  return m;
}

// ---- 10-line console summary ----

export function printSummary(m: AuditMetrics): void {
  console.log('\n' + '═'.repeat(60));
  console.log('HYPERLEND AUDIT — RESUMEN (10 líneas)');
  console.log('═'.repeat(60));
  console.log(`Período:        ${m.fromDate} → ${m.toDate} (${m.daysObserved}d observados, ${m.daysRequested}d solicitados)`);
  console.log(`Liquidaciones:  ${m.totalLiquidations} total | Enriquecidas: ${m.enrichedCount}`);
  console.log(`Volumen:        ${fmtUsd(m.totalVolumeUsd)} total | Mediana: ${fmtUsd(m.medianVolumeUsd)} | P90: ${fmtUsd(m.p90VolumeUsd)}`);
  console.log(`Profit neto:    Mediana ${fmtUsd(m.medianNetProfitUsd)} | P90 ${fmtUsd(m.p90NetProfitUsd)} | ${fmtPct(m.pctAboveMinProfit)} > $${m.minProfitThreshold}`);
  console.log(`Competencia:    ${m.uniqueLiquidators} liquidadores | Top-1: ${fmtPct(m.top1Share)} | Top-3: ${fmtPct(m.top3Share)} | HHI: ${m.hhi.toFixed(0)} (${hhiLabel(m.hhi)})`);
  console.log(`Proyec. 15%/mes: ${projectedMonthly(m, 0.15).count} liq | ${fmtUsd(projectedMonthly(m, 0.15).volume)} vol | ${fmtUsd(projectedMonthly(m, 0.15).profit)} profit`);
  console.log(`Gas edge:       gasPrice ordena en HyperEVM (mempool público) → edge calldata/latencia APLICA`);
  const p5 = projectedMonthly(m, 0.05);
  const isViable = m.totalLiquidations > 0 && m.medianNetProfitUsd > 50 && m.hhi < 5000;
  console.log(`Veredicto:      ${m.totalLiquidations === 0 ? '🔴 SIN DATOS SUFICIENTES — verificar archive RPC' : isViable ? '🟢 GO (pendiente verificación manual)' : '🟡 NECESITA MÁS DATOS'}`);
  console.log('─'.repeat(60));
  console.log(`VERIFICAR MANUALMENTE: (1) direcciones contratos en purrsec.com (2) topic0 en tx real`);
  console.log(`(3) comportamiento top liquidadores (4) liquidez DEX on-chain pares top`);
  console.log(`Reporte completo: reports/HYPERLEND_AUDIT_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`);
  console.log('═'.repeat(60));
}
