# Gateway Derivation Orchestration

## Goal

Materialize a small, auditable set of derived facts without duplicating
Provider logic or weakening the request contract:

- direct usable facts remain authoritative;
- Providers receive the dependencies needed for safe fallback derivation;
- dependency facts remain internal unless the caller requested them;
- derived facts retain complete Fact and Observation lineage;
- incomplete or incompatible inputs fail closed.

## Delivered

- [x] Expand and deduplicate Provider requirements separately from the
      original `FactRequest`.
- [x] Derive free cash flow from compatible operating-cash-flow and capex
      facts.
- [x] Derive explicit-quarter TTM additive flows from current YTD, previous
      annual, and previous YTD facts.
- [x] Derive market cap from compatible same-period close price and shares
      outstanding facts.
- [x] Prefer a direct usable fact over every fallback derivation.
- [x] Persist dependency observations so `explainFact` can reconstruct derived
      lineage.
- [x] Reuse the ordinary request cache for derived FactSets and invalidate old
      cache identities by advancing the validation-rules version.
- [x] Emit `DERIVATION_UNAVAILABLE:<concept>` when an enabled derivation lacks
      valid inputs.

## Deliberate boundaries

Automatic TTM derivation is limited to additive income and cash-flow concepts.
It does not apply the flow formula to EPS, ROE, dividends, or other ratios.
ROE and P/E orchestration remain disabled until compatible attribution,
average-equity, and per-share inputs are available.

An FCF TTM request is evaluated as:

```text
current/prior source periods
  -> operating cash flow TTM + capex TTM
  -> free cash flow TTM
```

The public `FactRequest`, request cache key, and returned requirement set do
not change during dependency expansion.
