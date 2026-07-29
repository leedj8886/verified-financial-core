import type { FactRequest } from "@verified-financial/schema";
import { describe, expect, it } from "vitest";
import {
  buildFactSet,
  type BuildFactSetInput,
} from "./fact-set.js";
import { makeFact, makeRequest, makeUnmapped } from "./test-fixtures.js";

function makeBuildInput(
  overrides: Partial<BuildFactSetInput> = {},
): BuildFactSetInput {
  const fact = makeFact();
  return {
    schemaVersion: "1.0.0",
    request: makeRequest(),
    generatedAt: "2026-07-26T10:00:00+08:00",
    company: {
      companyId: "company:600519",
      legalName: "贵州茅台酒股份有限公司",
      jurisdiction: "CN",
    },
    instruments: [{
      instrumentId: "XSHG:600519",
      companyId: "company:600519",
      exchangeMic: "XSHG",
      symbol: "600519",
      shareClass: "A",
      tradingCurrency: "CNY",
    }],
    facts: [fact],
    unmapped: [],
    validations: [fact.verification],
    rawSnapshotIds: ["sha256:eastmoney-direct"],
    mappingVersions: ["foundation-fixture@1.0.0"],
    validationRulesVersion: "1.0.0",
    ...overrides,
  };
}

describe("FactSet assembly", () => {
  it("fails when a required requirement has no usable fact", () => {
    const factSet = buildFactSet(makeBuildInput({
      request: makeRequest([
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
        {
          conceptId: "income.netProfitParent",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
      ]),
    }));
    expect(factSet.summary).toMatchObject({
      overallStatus: "failed",
      failed: 1,
    });
  });

  it("matches every requested period independently", () => {
    const factSet = buildFactSet(makeBuildInput({
      request: makeRequest([
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
      ]),
    }));
    expect(factSet.summary.overallStatus).toBe("failed");
  });

  it("warns when optional output is unresolved", () => {
    const factSet = buildFactSet(makeBuildInput({
      request: makeRequest([
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
        {
          conceptId: "balance.cash",
          required: false,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
      ]),
      unmapped: [makeUnmapped()],
    }));
    expect(factSet.summary.overallStatus).toBe("warning");
  });

  it("preserves Gateway issues and downgrades an otherwise verified set", () => {
    const factSet = buildFactSet(makeBuildInput({
      reasonCodes: [
        "PROVIDER_FAILURE:fixture:TIMEOUT",
        "PROVIDER_FAILURE:fixture:TIMEOUT",
      ],
    }));
    expect(factSet).toMatchObject({
      reasonCodes: ["PROVIDER_FAILURE:fixture:TIMEOUT"],
      summary: { overallStatus: "warning" },
    });
  });

  it("normalizes unordered collections before hashing", () => {
    const revenue = makeFact({ factId: "fact:revenue" });
    const cash = makeFact({
      factId: "fact:cash",
      observationId: "obs:cash",
      concept: "balance.cash",
    });
    const requirements: FactRequest["requirements"] = [
      {
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      },
      {
        conceptId: "balance.cash",
        required: false,
        period: { fiscalYear: 2025, presentation: "annual" },
      },
    ];
    const first = buildFactSet(makeBuildInput({
      request: makeRequest(requirements),
      facts: [revenue, cash],
      validations: [revenue.verification, cash.verification],
      rawSnapshotIds: ["sha256:b", "sha256:a", "sha256:b"],
    }));
    const second = buildFactSet(makeBuildInput({
      request: makeRequest([...requirements].reverse()),
      facts: [cash, revenue],
      validations: [cash.verification, revenue.verification],
      rawSnapshotIds: ["sha256:a", "sha256:b"],
      generatedAt: "2026-07-26T11:00:00+08:00",
    }));
    expect(first.factSetId).toBe(second.factSetId);
    expect(second.facts.map((fact) => fact.factId))
      .toEqual(["fact:cash", "fact:revenue"]);
  });

  it("returns a failed machine-readable empty FactSet", () => {
    const factSet = buildFactSet(makeBuildInput({
      facts: [],
      validations: [],
      rawSnapshotIds: [],
    }));
    expect(factSet).toMatchObject({
      reasonCodes: ["EMPTY_FACT_SET"],
      summary: { overallStatus: "failed" },
      lineageVersions: {
        conceptRegistryVersion: "1.0.0",
        validationRulesVersion: "1.0.0",
        mappingVersions: ["foundation-fixture@1.0.0"],
        formulaVersions: {
          "fcf.ocf-minus-capex.v1": "1.0.0",
          "market-cap.price-times-shares.v1": "1.0.0",
          "pe.price-divided-by-eps.v1": "1.0.0",
          "roe.average-equity.v1": "1.0.0",
          "ttm.flow.v1": "1.0.0",
        },
      },
    });
  });
});
