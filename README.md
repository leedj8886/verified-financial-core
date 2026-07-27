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
- token-free Eastmoney, Tencent, and Baidu public-data Providers;
- exact cross-source comparison across different source scales;
- capability-aware Provider routing and request-level FactSet caching;
- offline FactSet replay and stale fallback on upstream failure;
- Gateway SDK orchestration and A/H instrument syntax resolution;
- offline-safe `ah-context` JSON CLI;
- provider-neutral fixture and Golden tests.

The local Gateway registers the three public Providers by default. Eastmoney
supplies A/H quotes and A-share statements; Tencent and Baidu independently
cross-check market and valuation fields. Tushare remains optional and the
default runtime and test suite require no token or interface ledger. Official
disclosure parsing remains the next source-layer stage and will arbitrate
conflicts rather than creating a separate data model.

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

## Packages

- `@verified-financial/schema`
- `@verified-financial/core`
- `@verified-financial/provider-contract`
- `@verified-financial/provider-eastmoney`
- `@verified-financial/provider-tencent`
- `@verified-financial/provider-baidu`
- `@verified-financial/storage`
- `@verified-financial/sdk`
- `@verified-financial/ah-gateway-cli`

See [the approved architecture](docs/superpowers/specs/2026-07-26-verified-financial-core-design.md)
and the implementation plans for
[storage/Gateway](docs/plans/2026-07-27-storage-gateway.md),
[routing/cache](docs/plans/2026-07-27-gateway-cache-routing.md), and
[public A/H Providers](docs/plans/2026-07-27-market-providers.md).
