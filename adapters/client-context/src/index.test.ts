import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseVerifiedFactSet,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import { describe, expect, it } from "vitest";
import {
  buildClientFinancialContext,
  formatClientFinancialContext,
} from "./index.js";

function loadJson(relativePath: string): unknown {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadFactSet(): VerifiedFactSet {
  return parseVerifiedFactSet(loadJson(
    "../../../tests/golden/contracts/verified-fact-set-1.0.0.json",
  ));
}

describe("client financial context", () => {
  it("matches the Golden consumer contract", () => {
    const context = buildClientFinancialContext(loadFactSet());
    const expected = loadJson(
      "../../../tests/golden/consumers/client-context-1.0.0.json",
    );
    expect(context).toEqual(expected);
    expect(JSON.parse(formatClientFinancialContext(loadFactSet())))
      .toEqual(expected);
  });

  it("withholds values below the declared status threshold", () => {
    const factSet = structuredClone(loadFactSet());
    const fact = factSet.facts[0]!;
    fact.status = "warning";
    fact.verification.status = "warning";
    fact.reasonCodes = ["SINGLE_SOURCE"];
    fact.verification.reasonCodes = ["SINGLE_SOURCE"];
    factSet.reasonCodes = ["SINGLE_SOURCE"];
    factSet.summary = {
      verified: 0,
      warnings: 1,
      failed: 0,
      unmapped: 0,
      overallStatus: "warning",
    };

    const context = buildClientFinancialContext(factSet);

    expect(context.gate).toEqual({
      minimumStatus: "verified",
      actualStatus: "warning",
      passed: false,
    });
    expect(context.acceptedFacts).toEqual([]);
    expect(context.blockedFacts).toHaveLength(1);
    expect(context.blockedFacts[0]).not.toHaveProperty("value");
    expect(context.issues).toEqual([
      "FACT_SET_BELOW_MINIMUM_STATUS",
      "SINGLE_SOURCE",
    ]);
  });

  it("can explicitly accept warnings without accepting failed facts", () => {
    const factSet = structuredClone(loadFactSet());
    const fact = factSet.facts[0]!;
    fact.status = "warning";
    fact.verification.status = "warning";
    fact.reasonCodes = ["SINGLE_SOURCE"];
    fact.verification.reasonCodes = ["SINGLE_SOURCE"];
    const failedFact = structuredClone(fact);
    failedFact.factId = "fact:failed";
    failedFact.status = "failed";
    failedFact.usable = false;
    failedFact.reasonCodes = ["SOURCE_CONFLICT"];
    failedFact.verification = {
      ...failedFact.verification,
      verificationId: "vr:failed",
      status: "failed",
      usable: false,
      reasonCodes: ["SOURCE_CONFLICT"],
    };
    factSet.facts.push(failedFact);
    factSet.summary = {
      verified: 0,
      warnings: 1,
      failed: 1,
      unmapped: 0,
      overallStatus: "failed",
    };

    const context = buildClientFinancialContext(factSet, {
      minimumStatus: "warning",
    });

    expect(context.gate.passed).toBe(false);
    expect(context.acceptedFacts[0]?.value).toBe("172054171890.91");
    expect(context.blockedFacts).toHaveLength(1);
    expect(context.blockedFacts[0]).toMatchObject({
      factId: "fact:failed",
      disposition: "blocked",
      status: "failed",
      usable: false,
    });
    expect(context.blockedFacts[0]).not.toHaveProperty("value");
  });

  it("rejects input that is not a complete frozen FactSet", () => {
    expect(() => buildClientFinancialContext({
      schemaVersion: "1.0.0",
    })).toThrow();
  });
});
