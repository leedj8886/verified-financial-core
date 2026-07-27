# Storage and Gateway Implementation Plan

## Goal

Build the provider-independent TypeScript infrastructure between the verified
financial core and future market providers:

- immutable content-addressed raw snapshots;
- SQLite metadata and FactSet audit storage;
- a runtime-validated provider contract;
- deterministic Gateway orchestration;
- an offline-safe JSON CLI.

Real Eastmoney, Tencent, Baidu, CNINFO, HKEX, and optional Tushare adapters are
outside this plan. Tests use local fixture providers only.

## Dependency direction

```text
schema -> core
schema -> provider-contract
schema -> storage
core + provider-contract + storage -> sdk
sdk -> ah-gateway-cli
```

## Delivery steps

- [x] Add `@verified-financial/provider-contract` with capabilities, requests,
      batches, provider errors, snapshot-writer abstraction, and contract tests.
- [x] Add `@verified-financial/storage` with SHA-256 raw snapshot storage,
      SQLite metadata, FactSet persistence, observation lineage, and tests.
- [x] Extend FactSet assembly so top-level provider or cache issues affect
      `overallStatus` without changing otherwise valid facts.
- [x] Add `@verified-financial/sdk` with instrument parsing, provider
      orchestration, historical availability filtering, verification, FactSet
      persistence, retrieval, and fact explanation.
- [x] Add `ah-context` JSON CLI with `resolve`, `facts`, `fact-set`, `explain`,
      and `doctor`; stdout remains JSON-only.
- [x] Verify all default tests are offline, Node 24 typecheck/build passes, and
      no Tushare token or interface ledger is required.

## Acceptance cases

- Duplicate raw bytes produce one immutable snapshot ID and one stored file.
- JSON and HTML snapshots are gzip-compressed; PDF bytes remain unchanged.
- FactSets survive process restart and can be retrieved by ID.
- `explainFact` returns the chosen fact, verification, observations, and raw
  snapshot references.
- Two compatible independent fixture sources can produce `verified`.
- A single source, partial provider failure, future publication, or offline
  miss cannot silently produce a fully verified result.
- Two wrappers over the same upstream source still count as one source.
- Empty provider output produces a structured failed FactSet.
- CLI status requirements use documented exit codes without corrupting JSON.
