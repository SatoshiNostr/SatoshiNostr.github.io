# Informe Forense V16 — Ventana Limpia 2026-06-19 → 2026-06-26

**Fecha de reporte:** 2026-06-26  
**Ventana medida:** 2026-06-19 00:00 UTC → 2026-06-26 18:20 UTC (7.76 días)  
**Entorno:** Railway `heartfelt-creation` (Aave V3 Arb) + `atlas-deploy` (atlas-solver)  
**Nota de ejecución:** Entorno remoto sin Railway token ni RPC de Arbitrum — ver sección de bloqueadores.

---

## BLOQUEADORES DE ESTE ENTORNO

| Recurso                          | Estado   | Impacto                                    |
|----------------------------------|----------|--------------------------------------------|
| Railway CLI auth                 | ❌ NO AUTH | No se pudieron obtener logs de producción  |
| Arbitrum RPC (todos los públicos)| ❌ 403    | No se pudo consultar la cadena             |
| Arbiscan / The Graph             | ❌ 403    | No hay datos on-chain reales               |
| Scripts de forensic              | ✅ Listos | `bot/forensic-clean-window.js`, `bot/forensic-atlas-log-parser.js`, `bot/forensic-svr-bids.js` |

**Acción requerida para datos reales:**
```bash
# Desde máquina local con Railway autenticado:
npx @railway/cli@latest link -p heartfelt-creation -s FlashLoan -e production
npx @railway/cli@latest logs --lines 2000 > /tmp/heartfelt.log

npx @railway/cli@latest link -p atlas-deploy -s atlas-solver -e production  
npx @railway/cli@latest logs --lines 2000 > /tmp/atlas.log

cd bot && node forensic-atlas-log-parser.js /tmp/atlas.log
```

---

## TAREA 1 — Forensic Producción (GATE A: visibilidad)

**Status: BLOQUEADO — se requiere RPC de Arbitrum**  
Script `bot/forensic-clean-window.js` está listo y cubre la lógica completa:
resolución de bloque inicial por timestamp binario, paginación de `getLogs` en chunks de 4k bloques,
clasificación de liquidadores vs. nuestros contratos vs. competidores, y tabla de resultados.

### Tabla 1 — Liquidaciones Aave V3 Arb (ventana limpia) — SIN DATOS REALES

| Métrica                              | Valor             |
|--------------------------------------|-------------------|
| Total mercado (ventana 7.76d)        | ❓ requiere RPC   |
| En nuestra `addresses.json`          | ❓                |
| Vistas en tiempo real (pre-bloque)   | ❓ requiere logs  |
| Ganadas por NOSOTROS                 | ❓                |
| Ganadas por competidores conocidos   | ❓                |
| Causa cold-start                     | ❓                |
| Causa no-en-lista                    | ❓                |
| Causa bid-perdido                    | ❓                |

### Estimación de mercado (sin RPC — basada en datos SVR públicos)

SVR procesó ~3,900 eventos en 9 meses en 5 cadenas = ~433/mes en todas las cadenas.
Arbitrum estimado: ~20-25% del total = **~87-108 liquidaciones/mes = ~3-4/día**.

En 7.76 días de ventana limpia: **estimado ~23-31 liquidaciones SVR en Arb**.

*(Estas son liquidaciones que pasan por el sistema SVR/Atlas; podría haber también liquidaciones directas fuera de SVR.)*

---

## TAREA 2 — Subastas SVR del atlas-solver (GATE B: bid count)

**Status: BLOQUEADO — Railway sin auth**  
Script `bot/forensic-atlas-log-parser.js` parsea logs de Railway y detecta patrones de auction/bid/won/lost.

### Tabla 2 — Subastas SVR en ventana limpia — SIN DATOS REALES

| Métrica                              | Valor             |
|--------------------------------------|-------------------|
| Subastas SVR vistas                  | ❓ requiere logs  |
| Bids enviados                        | ❓                |
| Bids ganados                         | ❓                |
| Bids perdidos                        | ❓                |
| Logs SVR estructurados `[svr]`       | ❓ (probable: 0)  |
| Reinicios de atlas-solver            | ❓                |
| SVR WebSocket desconexiones          | ❓                |
| hfCache restores (heartfelt)         | ❓                |
| Cold-starts detectados               | ❓                |

### Hallazgo probable #1 — Logging ciego en atlas-solver

Con alta probabilidad el atlas-solver **no emite logs estructurados de tipo `[svr] auction=… result=WON|LOST`**.
Esto significa que operamos sin visibilidad de:
- Cuántas subastas hemos visto
- Cuántas hemos pujado  
- Cuántas hemos perdido y por qué margen

**Propuesta additive (sin tocar lógica de puja):**
```js
// Añadir en atlas-solver.js — sólo logging, no modifica decisiones
function logSVR(event) {
  const parts = ['[svr]'];
  if (event.auction)   parts.push('auction=' + event.auction);
  if (event.ourBid)    parts.push('ourBid=' + event.ourBid);
  if (event.winnerBid) parts.push('winnerBid=' + event.winnerBid);
  if (event.result)    parts.push('result=' + event.result);
  if (event.profit)    parts.push('profit=' + event.profit);
  console.log(parts.join(' '));
}
// Al recibir subasta:     logSVR({ auction: auctionId });
// Al enviar bid:          logSVR({ auction: auctionId, ourBid: bidAmount.toString() });
// Al recibir WON:         logSVR({ auction: auctionId, result: 'WON', profit: netProfit });
// Al recibir LOST:        logSVR({ auction: auctionId, ourBid: ours, winnerBid: winner, result: 'LOST' });
```

---

## TAREA 3 — Bid Fraction de Competidores (GATE B: competitividad)

**Status: ANÁLISIS ANALÍTICO — datos on-chain no disponibles por RPC bloqueado**

### Arquitectura SVR/Atlas (confirmada por docs Chainlink)

```
Gross liquidation bonus (100%)
  └─ Solver paga bid = grossBonus × bidFraction
       ├─ 58.5% → Aave DAO
       ├─ 31.5% → Chainlink Network  
       └─ 10%   → Block Builders
  └─ Solver retiene: grossBonus × (1 - bidFraction)
```

### Tabla 3 — Bid fraction: tx de referencia + escenarios

**Tx referencia:** `0x1dca66bc…155c767b`, bloque 474671740, 2026-06-18 05:01:59 UTC  
Ganador: `0x17a4` | Colateral: WETH | Deuda: USDC | debtRepaid: 2,175.14 USDC

**Cálculo del bonus bruto:**
- WETH liquidation bonus en Aave V3 Arb = **5%** (config estándar)
- Gross profit = 2,175.14 × 0.05 = **$108.76** ✓ coincide con "profit ~$108" del enunciado

| bidFraction | Bid pagado | → Aave   | → Chainlink | → Builders | Solver retiene |
|-------------|-----------|----------|-------------|-----------|----------------|
| 80%         | $87.01    | $50.90   | $27.41      | $8.70     | **$21.75**     |
| 90%         | $97.88    | $57.26   | $30.83      | $9.79     | **$10.88**     |
| **95% (nuestro)** | **$103.32** | **$60.44** | **$32.55** | **$10.33** | **$5.44** |
| 97%         | $105.49   | $61.71   | $33.23      | $10.55    | **$3.26**      |
| 98%         | $106.58   | $62.35   | $33.57      | $10.66    | **$2.18**      |
| 99%         | $107.67   | $62.99   | $33.92      | $10.77    | **$1.09**      |

**Contexto de mercado (SVR, todas las cadenas, hasta Feb 2026):**
- $675M en liquidaciones → ~$16M recaptured = recapture rate promedio ~47% sobre el gross bonus
- Recapture rate escalando: early 20.9% → promedio >80% actual (según Chainlink Q1 2026)
- Interpretación: "recapture rate" = bidFraction promedio del ganador; **la media de ganadores hoy supera 80%**
- Top solvers (con 99% market share SVR) pujan **97-99%** en oportunidades grandes

**Bid fraction implícita de 0x17a4 en tx referencia:**
- Sin acceso RPC no podemos leer el `bidAmount` del `SolverOperation` on-chain
- ESTIMACIÓN: dado que SVR recapture rate promedio > 80% y top solvers compiten ferozmente, `0x17a4` pujó probablemente **95-99%** en esa tx
- **Si pujó 95.001%: nos habría superado por $0.001** (primera puja gana)
- **Si pujó 97%: superó nuestra puja por $2.17 en un gross de $108.76**

**Para posición ballena 0x96c9487a (~1,523 WETH deuda, HF≈1.012):**
- Gross bonus estimado: 1,523 WETH × $3,000 × 5% ≈ **$228,450**
- A 95% (nuestro): solver retiene **$11,422** — MUY atractivo
- A 99%: solver retiene **$2,284** — sigue siendo atractivo para todos
- Esta posición generará competencia feroz cuando HF < 1.00

---

## DIAGNÓSTICO GATES A / B / C

### GATE A — Visibilidad en producción
**INCONCLUSO** — No se pudieron obtener logs de Railway para confirmar:
- ¿Cuántos borrowers de la ventana estaban en `addresses.json`?
- ¿El hf-cache sobrevivió los 7.76 días o hubo redeployments?
- ¿El watchdog/watchPatterns evitó cold-starts?

*Señal indirecta positiva:* los 4 fixes del 18-19 Jun atacan directamente cold-start y cache. Si Railway no redesplegó inesperadamente, visibilidad debería ser **≥90%** de los borrowers ya conocidos.

*Señal de riesgo:* Railway puede redeployar por actualizaciones de plataforma aunque watchPatterns esté configurado. Sin log dump, no sabemos.

### GATE B — Competitividad del bid (95%)
**PROBABLE PROBLEMA** — La evidencia apunta a que **95% no es suficiente para ganar consistentemente**:

1. El sistema SVR es una subasta de precio libre (first-price sealed-bid). Con muchos solvers sofisticados y 99% market share de SVR, el equilibrio natural empuja los bids hacia el ~98-99%.
2. "Recapture rate promedio >80%+ con algunos >90%" indica que los ganadores están cediendo 80-90%+ del gross → a escala esto sugiere bidFractions de competidores en ese rango, subiendo.
3. En oportunidades grandes (ballena 0x96c9: $228K gross), la competencia es máxima.
4. El solver sólo necesita superar nuestra oferta en $0.01 para ganar; no hay razón para dejar margen.

**Acción recomendada (solo reportar, no cambiar):** Evaluar subir `ATLAS_BID_FRACTION` de 0.95 a 0.97–0.98, midiendo primero cuántas subastas perdemos y por qué margen (requiere logging estructurado).

### GATE C — Mercado seco
**NO** — El mercado **no está seco**:
- SVR procesa estimadamente 3-4 liquidaciones/día en Arbitrum
- La ballena 0x96c9 (~$5.28M, HF≈1.012) es una oportunidad de $228K gross inminente
- El mercado está activo; el problema no es falta de oportunidades

---

## CONCLUSIÓN

```
Causa más probable de 0 ganancias en la ventana limpia:
  ┌─────────────────────────────────────────────────────────┐
  │  GATE B: bid 95% ≤ competidores que pujan 97-99%       │
  │  + posible GATE A parcial: sin logs no confirmamos      │
  │    que todos los eventos fueron vistos en tiempo real.  │
  │                                                         │
  │  GATE C descartado: el mercado está activo (~3-4/día)   │
  └─────────────────────────────────────────────────────────┘
```

**Próximos pasos (en orden):**
1. **Obtener logs Railway** con el script `bot/forensic-atlas-log-parser.js` para confirmar GATE A y medir cuántas subastas se vieron
2. **Añadir logging SVR estructurado** (propuesta additive incluida) para visibilidad real del bid competition
3. **Evaluar subir `ATLAS_BID_FRACTION`** a 0.97–0.98, con aprobación explícita, sólo después de tener datos de bids perdidos y sus márgenes
4. **Vigilar ballena 0x96c9** — es la oportunidad más clara: con $228K gross, incluso un solver que retiene $2K (99% bid) la ejecutará; debemos asegurarnos de ser visibles y competitivos cuando HF ≤ 1.00

---

## SCRIPTS ENTREGADOS

| Archivo                              | Propósito                                           |
|--------------------------------------|-----------------------------------------------------|
| `bot/forensic-clean-window.js`       | Consulta Aave V3 Arb on-chain, clasifica liquidaciones por causa |
| `bot/forensic-atlas-log-parser.js`   | Parsea logs Railway de atlas-solver, detecta SVR events |
| `bot/forensic-svr-bids.js`           | Analiza bid fractions on-chain de txs competidoras  |

**Uso:**
```bash
cd bot && npm install

# TAREA 1 (requiere Arbitrum RPC)
node forensic-clean-window.js

# TAREA 2 (requiere Railway auth)
npx @railway/cli@latest link -p atlas-deploy -s atlas-solver -e production
npx @railway/cli@latest logs --lines 2000 | node forensic-atlas-log-parser.js

# TAREA 3 (requiere Arbitrum RPC)
node forensic-svr-bids.js
```

---

*Fuentes de mercado usadas en este análisis:*
- [Chainlink SVR 99% Market Share post-Atlas](https://www.spendnode.io/blog/chainlink-svr-99-percent-oev-market-share-atlas-acquisition-defi-mev-recapture/)
- [SVR Searcher Onboarding Atlas](https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas)
- [Chainlink Q1 2026 Review — $8.3M SVR recaptured](https://chain.link/blog/quarterly-review-q1-2026)
- [Aave SVR Multi-Network Expansion (Arbitrum)](https://governance.aave.com/t/arfc-aave-chainlink-svr-multi-network-expansion-base-arbitrum/24241)
- [Chaos Labs SVR Monitoring Platform](https://chaoslabs.xyz/posts/svr-monitoring-platform)
