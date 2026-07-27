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
- Gateway SDK orchestration and A/H instrument syntax resolution;
- offline-safe `ah-context` JSON CLI;
- provider-neutral fixture and Golden tests.

Market and official providers are the next stage. Until they are registered,
`facts` correctly returns a failed empty FactSet rather than inventing data.
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

All default tests are offline.

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
only to stderr.

The facts command accepts `--offline` and
`--require-status verified|warning|failed`. Its exit codes are:

- `0`: completed and met the required status;
- `2`: produced a FactSet below the required status;
- `3`: invalid input or configuration;
- `4`: storage or unrecoverable system failure.

## Packages

- `@verified-financial/schema`
- `@verified-financial/core`
- `@verified-financial/provider-contract`
- `@verified-financial/storage`
- `@verified-financial/sdk`
- `@verified-financial/ah-gateway-cli`

See [the approved architecture](docs/superpowers/specs/2026-07-26-verified-financial-core-design.md)
and [the storage/Gateway implementation plan](docs/plans/2026-07-27-storage-gateway.md).
