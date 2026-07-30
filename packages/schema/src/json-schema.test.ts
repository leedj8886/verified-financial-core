import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  VERIFIED_FACT_SET_JSON_SCHEMA,
  VERIFIED_FACT_SET_JSON_SCHEMA_ID,
} from "./json-schema.js";
import {
  VERIFIED_FACT_SET_SCHEMA_VERSION,
  parseVerifiedFactSet,
} from "./facts.js";

function loadContractFixture(): unknown {
  const path = fileURLToPath(
    new URL(
      "../../../tests/golden/contracts/verified-fact-set-1.0.0.json",
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("VerifiedFactSet JSON contract", () => {
  it("publishes a draft-07 schema with a fixed wire version", () => {
    expect(VERIFIED_FACT_SET_JSON_SCHEMA).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: VERIFIED_FACT_SET_JSON_SCHEMA_ID,
      title: "VerifiedFactSet",
      additionalProperties: false,
      properties: {
        schemaVersion: {
          type: "string",
          const: VERIFIED_FACT_SET_SCHEMA_VERSION,
        },
      },
    });
  });

  it("keeps the Zod and generated JSON Schema contracts compatible", () => {
    const fixture = loadContractFixture();
    const zodParsed = parseVerifiedFactSet(fixture);
    const ajv = new Ajv.Ajv({ allErrors: true, strict: true });
    addFormats.default(ajv);
    const validate = ajv.compile(VERIFIED_FACT_SET_JSON_SCHEMA);

    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(fixture).toEqual(zodParsed);
    expect(zodParsed.summary.overallStatus).toBe("verified");
    expect(zodParsed.lineageVersions).toMatchObject({
      conceptRegistryVersion: "1.0.0",
      validationRulesVersion: "1.6.0",
    });
  });

  it("detects accidental structural contract drift", () => {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(VERIFIED_FACT_SET_JSON_SCHEMA))
      .digest("hex");
    expect(fingerprint)
      .toBe("0a78079951bd18d2d28fe693ad0301a140db491e970c2979e535603d2d087efe");
  });
});
