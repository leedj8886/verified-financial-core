# VerifiedFactSet 1.0.0 Contract

`VerifiedFactSet` is the frozen handoff between the Gateway and downstream
consumers such as Dexter, AI Berkshire, MCP tools, and Research CI.

The npm workspace package remains at `0.1.x`. The independent wire-format
version is `1.0.0`.

## TypeScript consumption

Always validate data at the process boundary:

```ts
import {
  VERIFIED_FACT_SET_SCHEMA_VERSION,
  parseVerifiedFactSet,
} from "@verified-financial/schema";

const factSet = parseVerifiedFactSet(JSON.parse(input));

if (factSet.schemaVersion !== VERIFIED_FACT_SET_SCHEMA_VERSION) {
  throw new Error("Unsupported VerifiedFactSet contract");
}
```

Use the opt-in JSON Schema entry point when a machine-readable structural
contract is needed:

```ts
import {
  VERIFIED_FACT_SET_JSON_SCHEMA,
  VERIFIED_FACT_SET_JSON_SCHEMA_ID,
} from "@verified-financial/schema/json-schema";
```

The exported document targets JSON Schema draft-07. The JSON Schema validates
wire structure, required fields, enums, numeric-string formats, timestamps,
and the fixed schema version. `parseVerifiedFactSet` remains authoritative for
cross-field financial semantics that JSON Schema cannot express, including
concept scope, canonical unit, period kind, and verification usability.

## Compatibility policy

- Producers emit exactly `schemaVersion: "1.0.0"`.
- Consumers reject unknown schema versions instead of guessing compatibility.
- Unknown top-level fields are rejected.
- A breaking field, meaning, or invariant change requires a new wire version.
- A new wire version must ship with a new Golden Contract fixture and JSON
  Schema fingerprint.
- Package versions, concept-registry versions, Provider mapping versions,
  formula versions, and validation-rules versions are separate from the wire
  version.

`lineageVersions` is optional only so previously persisted 1.0.0 FactSets
remain readable. Every newly generated FactSet includes:

- `conceptRegistryVersion`;
- `validationRulesVersion`;
- sorted `mappingVersions`;
- the formula ID-to-version map.

## Downstream rules

Research CI and other consumers:

1. parse the complete FactSet before reading individual facts;
2. preserve `factSetId`, `schemaVersion`, `lineageVersions`, status, reason
   codes, observation IDs, and snapshot IDs in their audit record;
3. accept a Fact only when its status meets the consumer's declared threshold;
4. never replace Gateway values with a separate data-fetching or TTM layer;
5. use `factId` and `observationIds` when reporting a correction or conflict.

The Gateway answers “is this data package reliable?” Downstream Research CI
answers “did this report use that reliable package correctly?”

## Golden Contract

The canonical consumer fixture is:

`tests/golden/contracts/verified-fact-set-1.0.0.json`

Tests validate the fixture with both the authoritative Zod parser and Ajv
against the exported draft-07 JSON Schema. A SHA-256 fingerprint prevents
unreviewed structural drift.
