import { describe, expect, it } from "vitest";
import {
  ConceptIdSchema,
  CONCEPT_REGISTRY,
  getConceptDefinition,
} from "./concepts.js";

describe("canonical concept registry", () => {
  it("contains the MVP concepts with fixed semantics", () => {
    expect(getConceptDefinition("income.revenue")).toEqual({
      conceptId: "income.revenue",
      valueType: "decimal",
      scope: "company",
      periodKind: "duration",
      canonicalUnit: "currency",
      allowedPresentations: ["quarter", "ytd", "annual", "ttm"],
    });
    expect(CONCEPT_REGISTRY["market.price.close"].scope).toBe("instrument");
    expect(CONCEPT_REGISTRY["balance.assets"].periodKind).toBe("instant");
  });

  it("rejects provider-private fields", () => {
    expect(() => ConceptIdSchema.parse("TOTAL_OPERATE_INCOME")).toThrow();
  });
});
