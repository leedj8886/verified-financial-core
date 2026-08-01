# Client Financial Context 1.0.0

This legacy shape is superseded by Client Financial Context 1.1.0, which
preserves the FactSet knowledge cutoff and post-disclosure evidence.

`@verified-financial/client-context` is the shared boundary between a frozen
`VerifiedFactSet` and LLM-facing clients such as Dexter and AI Berkshire.
It formats data for consumption; it does not fetch, map, calculate, or verify
financial data.

## Input and output

`buildClientFinancialContext(input, options)` first validates the complete
input with `parseVerifiedFactSet`. Partial objects and unknown wire versions
are rejected.

The output contains:

- the FactSet ID, wire version, generation time, and historical `asOf`;
- company and instrument identity, including share class and trading currency;
- a status gate with the declared minimum status;
- accepted facts with value, period, currency, source IDs, and audit IDs;
- blocked facts without a numeric value;
- reason codes and immutable snapshot/version lineage.

The compact `formatClientFinancialContext` output is deterministic JSON.

## Fail-closed policy

The default minimum status is `verified`.

- `gate.passed` is based on the overall FactSet status.
- A fact appears in `acceptedFacts` only when it is usable and meets the
  declared minimum status.
- A fact below the threshold appears in `blockedFacts`; its numeric value is
  deliberately omitted.
- Setting `minimumStatus: "warning"` may admit warning facts, but never failed
  facts.
- A client may display partial accepted evidence while the overall gate is
  blocked, but it must not publish or make an investment claim as if the full
  request passed.

Consumers must not recover a blocked value from the original FactSet and
silently present it as accepted.

## Product boundary

Dexter may wrap this output in its existing LangChain Tool and progress-event
interfaces. AI Berkshire may obtain the same FactSet through `ah-context` and
build the same context. Neither client may add a separate Provider, TTM,
valuation, or cross-source validation implementation.

Research CI consumes the frozen FactSet directly for claim auditing. It may
also use this client context for LLM prompts, but its audit record must retain
the original FactSet ID and Fact IDs.

## Golden consumer contract

`tests/golden/consumers/client-context-1.0.0.json` is generated from
`tests/golden/contracts/verified-fact-set-1.0.0.json`. Tests lock the accepted
shape and verify that warning/failed values cannot cross the configured
threshold.
