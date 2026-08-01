# Client Financial Context 1.1.0

`@verified-financial/client-context` is the shared LLM-facing projection of a
complete `VerifiedFactSet`. Version 1.1.0 preserves the FactSet's dual temporal
semantics instead of reducing them to a single historical date.

The `factSet` header contains `asOf`, `knowledgeAsOf`, and `temporalMode`.
Every accepted or blocked Fact includes its `temporalEvidence` when supplied by
VerifiedFactSet 1.1.0 and its `reportingVersion` when the source distinguishes
an original filing, a later comparative column, or an explicit restatement. A
post-disclosure context also carries the
`POST_DISCLOSURE_CONTEXT` issue so an Agent cannot silently describe later
evidence as information known at the effective date.

The status gate remains unchanged: temporal mode does not turn a verified Fact
into a warning Fact, and it never makes a failed Fact usable. Dexter, AI
Berkshire, and Research CI must retain these temporal fields in prompts and
audit records.

The canonical fixture is
`tests/golden/consumers/client-context-1.1.0.json`, generated from
`tests/golden/contracts/verified-fact-set-1.1.0.json`.
