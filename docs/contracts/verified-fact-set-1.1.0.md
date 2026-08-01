# VerifiedFactSet 1.1.0 Contract

`VerifiedFactSet` 1.1.0 makes the information cutoff independent from the
effective observation or valuation time. It is the frozen handoff between the
Gateway and Dexter, AI Berkshire, MCP clients, and Research CI.

## Temporal semantics

Every newly generated request contains:

- `asOf`: the effective observation or valuation time;
- `knowledgeAsOf`: the latest publication time that may contribute evidence.

When the two timestamps are equal, the request is strict point-in-time. When
`knowledgeAsOf` is later, the FactSet is a post-disclosure reconstruction. A
later cutoff must be explicit and cannot be described as information known at
the effective date.

Financial requirements continue to declare their reporting period separately.
For example, `2024Q2TTM` describes the economic period while the two timestamps
state when it is valued and which publications may be used.

`temporalContext` records:

- `effectiveAsOf` and `knowledgeAsOf`;
- `mode`: `point-in-time` or `post-disclosure`;
- for every returned Fact, `evidenceAvailableAt`,
  `knownAtEffectiveAsOf`, and any `postEffectiveDateObservationIds`.

For a derived Fact, evidence includes every persisted input Observation, so a
TTM value cannot hide a component first published after the effective date.

Historical shares are selected with two independent constraints:

```text
effectiveDate <= asOf
disclosureDate <= knowledgeAsOf
```

Historical prices remain anchored to `asOf`. Consequently, a historical price
combined with earnings first disclosed later is explicitly a retrospective
valuation, not an investable point-in-time multiple.

## Reporting versions

A financial Observation or Fact may carry `reportingVersion` independently of
its accounting basis:

- `original-filing`: the value in the original filing's current-period column;
- `later-comparative`: the same economic period as presented as a comparison
  column in a later filing;
- `explicit-restatement`: a value from a filing explicitly labelled as revised
  or corrected.

`sourcePeriodEndDate` identifies the filing period that presented the value.
It is omitted on a derived Fact when its inputs came from several filing
periods; the exact versions remain available through `derivation.inputFactIds`.

The Gateway verifies values only against observations from the same reporting
version. It then selects the newest known version for each requested or derived
input. If that newest version fails source verification, the Gateway fails
closed instead of silently falling back to an older original value. A strict
point-in-time request naturally excludes versions published after `asOf`; a
post-disclosure request can select later comparable values without treating
them as facts known at the effective date.

## Compatibility

- Producers emit `schemaVersion: "1.1.0"`.
- The parser continues to accept persisted 1.0.0 FactSets.
- A 1.1.0 FactSet requires `request.knowledgeAsOf` and `temporalContext`.
- Consumers must preserve the temporal context in audit records and must not
  silently replace unavailable point-in-time facts with post-disclosure facts.
- Cache identity includes both timestamps.
- `reportingVersion` is optional only for legacy persisted facts and providers;
  new CNINFO and Eastmoney financial observations populate it.

The canonical fixture is
`tests/golden/contracts/verified-fact-set-1.1.0.json`. The exported draft-07
JSON Schema and its SHA-256 fingerprint are locked by tests.
