# Gateway Routing and Cache Completion

## Goal

Finish the Gateway behavior that sits between public Providers and downstream
consumers:

- route only relevant requirements to each Provider;
- reuse frozen FactSets within a request-specific freshness window;
- make `--offline` a real replay mode;
- fail over to stale facts without hiding current provider failures.

## Delivered

- [x] Map canonical concepts to Provider capabilities and pass each Provider
      only its relevant requirements.
- [x] Add an indexed cache key based on normalized instrument, sorted
      requirements, and exact `asOf`; freshness policy is intentionally not
      part of the key.
- [x] Apply default TTLs of 60 seconds for market/valuation and 24 hours for
      financial/dividend requests.
- [x] Return fresh cached FactSets without contacting upstream Providers.
- [x] Replay cached facts in offline mode and persist the replayed FactSet for
      audit and later lookup.
- [x] Mark expired offline replay with both `OFFLINE_SNAPSHOT` and
      `STALE_CACHE`.
- [x] Use stale fallback only when live provider failures leave required facts
      unsatisfied; preserve the current provider error reason codes.
- [x] Keep failed/empty results out of the reusable cache index while still
      persisting them as audit records.

## Cache identity

```text
request cache key =
  schema version + validation rules version
  + normalized instrument
  + sorted FactRequirement[]
  + exact asOf
```

The cache points to immutable `VerifiedFactSet` records. A replay with a
different freshness policy or additional cache reason codes is assembled as a
new auditable FactSet; it never mutates the original.
