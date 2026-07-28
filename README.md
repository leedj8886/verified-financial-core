# Verified Financial Core

Provider-independent TypeScript contracts and infrastructure for traceable,
historically correct A/H-share financial facts.

The repository separates two concerns:

- the Gateway determines whether a financial data package is reliable;
- downstream Research CI determines whether a report used that package
  correctly.

Research CI must consume a frozen `VerifiedFactSet`; it does not own another
financial-data layer.

## Current status

Implemented:

- canonical schema and concept registry;
- compatibility, source-independence, verification, derivations, and
  deterministic FactSet assembly;
- immutable SHA-256 raw snapshot storage and SQLite audit metadata;
- runtime-validated Provider contract;
- token-free CNINFO/HKEX official-filing, Eastmoney, Tencent, and Baidu
  Providers;
- traceable, unadjusted Tencent/Eastmoney daily closes for historical `asOf`
  queries;
- exact cross-source comparison across different source scales;
- capability-aware Provider routing and request-level FactSet caching;
- automatic, traceable FCF, explicit-quarter TTM-flow, and market-cap
  derivation with direct-source facts taking precedence;
- offline FactSet replay and stale fallback on upstream failure;
- Gateway SDK orchestration and A/H instrument syntax resolution;
- offline-safe `ah-context` JSON CLI;
- provider-neutral fixture and Golden tests.

The local Gateway registers five token-free Providers by default. CNINFO
resolves A-share issuers and HKEX resolves H-share issuers; both discover
periodic filings, snapshot the official PDF, and extract a constrained set of
consolidated financial facts. Eastmoney supplies A/H quotes and A-share
statements; Tencent and Baidu independently cross-check market and valuation
fields. Official facts adjudicate compatible conflicts through the same
verification core. HKEX preserves the statement currency and reported scale
and uses the exchange's exact release minute for historical `asOf` filtering.
H-share statements remain `warning` when HKEX is the only independent source.
Tushare remains optional and the default runtime and test suite require no
token or interface ledger.

## Requirements

- Node.js 22 or newer (development baseline: 24.16.0)
- pnpm 8.15.6

The project-local `.npmrc` uses the official npm registry without changing
global npm configuration.

## Development

```bash
pnpm install
pnpm check
pnpm test:coverage
```

All default tests are offline. Public endpoint canaries are opt-in:

```bash
pnpm test:live
```

## CLI

Build and inspect the local Gateway:

```bash
pnpm build
pnpm --silent ah-context doctor
pnpm --silent ah-context resolve 600519.SH
```

Request facts:

```bash
pnpm --silent ah-context facts 600519.SH \
  --concept income.revenue \
  --period 2025FY \
  --as-of 2026-07-27 \
  --format json
```

Request the last unadjusted daily close available on a historical date:

```bash
pnpm --silent ah-context facts 600519.SH \
  --concept market.price.close \
  --as-of 2025-07-27 \
  --format json
```

Historical daily closes use the latest trading day at or before `asOf`, so a
weekend request may return the preceding Friday. Mainland daily closes are
conservatively available from 15:30 +08:00 and Hong Kong closes from 16:30
+08:00. Same-calendar-day requests continue to use the current quote path.

Period syntax includes `2025FY`, `2025Q3`, `2025Q3YTD`, `2025TTM`, and the
explicit-quarter TTM form `2026Q2TTM`. Automatic TTM derivation requires the
explicit-quarter form.

Use `VERIFIED_FINANCIAL_DATA_DIR` to select the local snapshot and SQLite
directory. JSON results are written only to stdout; diagnostics are written
only to stderr. Without `--offline`, `facts` may call the registered public
endpoints and stores every upstream response as an immutable raw snapshot.

The facts command accepts `--offline`, `--max-age-seconds N`, and
`--require-status verified|warning|failed`. Its exit codes are:

- `0`: completed and met the required status;
- `2`: produced a FactSet below the required status;
- `3`: invalid input or configuration;
- `4`: storage or unrecoverable system failure.

Default cache ages are 60 seconds for market/valuation requests and 24 hours
for financial/dividend requests. `--offline` never invokes Providers: it
replays a matching frozen FactSet when available and marks the result with
`OFFLINE_SNAPSHOT` and, when expired, `STALE_CACHE`. On live upstream failure,
stale fallback is used only when the current request cannot otherwise satisfy
its required facts.

The Gateway expands derivation dependencies internally without changing the
request or cache identity. It currently derives:

- free cash flow from operating cash flow minus capex;
- TTM additive income/cash-flow facts when the fiscal quarter is explicit;
- market cap from same-period close price and shares outstanding.

Every derived fact records its formula and input Fact/Observation lineage.
Direct usable facts always take precedence. Missing or incompatible inputs
fail closed with `DERIVATION_UNAVAILABLE:<concept>`; ROE, EPS-based P/E, and
other non-additive ratios are intentionally not inferred.

## Packages

- `@verified-financial/schema`
- `@verified-financial/core`
- `@verified-financial/provider-contract`
- `@verified-financial/provider-cninfo`
- `@verified-financial/provider-hkex`
- `@verified-financial/provider-eastmoney`
- `@verified-financial/provider-tencent`
- `@verified-financial/provider-baidu`
- `@verified-financial/storage`
- `@verified-financial/sdk`
- `@verified-financial/ah-gateway-cli`

See [the approved architecture](docs/superpowers/specs/2026-07-26-verified-financial-core-design.md)
and the implementation plans for
[storage/Gateway](docs/plans/2026-07-27-storage-gateway.md),
[routing/cache](docs/plans/2026-07-27-gateway-cache-routing.md),
[derivation orchestration](docs/plans/2026-07-28-gateway-derivations.md),
[CNINFO official filings](docs/plans/2026-07-28-cninfo-provider.md),
[HKEX official filings](docs/plans/2026-07-28-hkex-provider.md),
[historical daily close](docs/plans/2026-07-28-historical-close.md), and
[public A/H Providers](docs/plans/2026-07-27-market-providers.md).
