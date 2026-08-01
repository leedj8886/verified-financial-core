import { describe, expect, it } from "vitest";
import {
  FactRequestSchema,
  ObservationSchema,
  VERIFIED_FACT_SET_SCHEMA_VERSION,
  VerificationResultSchema,
  VerifiedFactSetSchema,
  isSupportedVerifiedFactSetSchemaVersion,
  parseVerifiedFactSet,
} from "./facts.js";

const observation = {
  observationId: "obs:1",
  companyId: "company:600519",
  concept: "income.revenue",
  value: "100.1",
  unit: "CNY",
  scale: "1",
  period: {
    kind: "duration",
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    fiscalYear: 2025,
    presentation: "annual",
  },
  basis: {
    standard: "CAS",
    scope: "consolidated",
    presentation: "reported",
    attribution: "parent",
    currency: "CNY",
  },
  availability: {
    publishedAt: "2026-03-20T18:00:00+08:00",
    fetchedAt: "2026-07-26T10:00:00+08:00",
  },
  provenance: {
    providerId: "eastmoney-direct",
    upstreamSourceId: "eastmoney",
    sourceType: "aggregator",
    sourceUrl: "https://example.invalid",
    rawSnapshotId: "sha256:abc",
    rawField: "TOTAL_OPERATE_INCOME",
    extractionMethod: "api",
    fetchedAt: "2026-07-26T10:00:00+08:00",
    transformations: [],
  },
} as const;

function emptyFactSetInput() {
  return {
    schemaVersion: "1.0.0" as const,
    factSetId: "fs:empty",
    request: {
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue" as const,
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" as const },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    },
    generatedAt: "2026-07-26T10:00:00+08:00",
    company: {
      companyId: "company:600519",
      legalName: "贵州茅台酒股份有限公司",
      jurisdiction: "CN",
    },
    instruments: [],
    facts: [],
    unmapped: [],
    validations: [],
    rawSnapshotIds: [],
    reasonCodes: ["EMPTY_FACT_SET"],
    summary: {
      verified: 0,
      warnings: 0,
      failed: 1,
      unmapped: 0,
      overallStatus: "failed" as const,
    },
  };
}

describe("financial fact contracts", () => {
  it("rejects binary floating-point values", () => {
    expect(() => ObservationSchema.parse({
      ...observation,
      value: 100.1,
    })).toThrow();
  });

  it("enforces canonical concept semantics", () => {
    expect(() => ObservationSchema.parse({
      ...observation,
      instrumentId: "XSHG:600519",
    })).toThrow("Company-scoped concepts cannot have instrumentId");
    expect(() => ObservationSchema.parse({
      ...observation,
      unit: "shares",
    })).toThrow("Expected canonical unit CNY");
    expect(() => ObservationSchema.parse({
      ...observation,
      period: {
        kind: "instant",
        endDate: "2025-12-31",
        fiscalYear: 2025,
        presentation: "annual",
      },
    })).toThrow("Expected duration period");
  });

  it("requires exact concept-period requirements", () => {
    const request = FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    });
    expect(request.requirements[0]?.required).toBe(true);
  });

  it("accepts an explicit post-disclosure knowledge cutoff", () => {
    const request = FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: {
          fiscalYear: 2024,
          fiscalQuarter: 2,
          presentation: "ttm",
        },
      }],
      asOf: "2024-08-30T23:59:59+08:00",
      knowledgeAsOf: "2024-09-30T23:59:59+08:00",
    });

    expect(request.knowledgeAsOf).toBe("2024-09-30T23:59:59+08:00");
  });

  it("distinguishes original filings from later comparative versions", () => {
    expect(ObservationSchema.parse({
      ...observation,
      reportingVersion: {
        kind: "later-comparative",
        sourcePeriodEndDate: "2026-12-31",
      },
    }).reportingVersion).toEqual({
      kind: "later-comparative",
      sourcePeriodEndDate: "2026-12-31",
    });
  });

  it("rejects a knowledge cutoff before the effective as-of", () => {
    expect(() => FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
      }],
      asOf: "2024-08-30T23:59:59+08:00",
      knowledgeAsOf: "2024-08-29T23:59:59+08:00",
    })).toThrow("knowledgeAsOf cannot be earlier than asOf");
  });

  it("rejects unsupported presentations", () => {
    expect(() => FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "distribution.dividendPerShare",
        required: true,
        period: {
          fiscalYear: 2025,
          fiscalQuarter: 1,
          presentation: "quarter",
        },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    })).toThrow("Presentation quarter is not allowed");
  });

  it("enforces period selector quarter rules", () => {
    expect(() => FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "quarter" },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    })).toThrow("Quarter and YTD requirements need fiscalQuarter");
    expect(() => FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: {
          fiscalYear: 2025,
          fiscalQuarter: 4,
          presentation: "annual",
        },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    })).toThrow("Annual requirements cannot specify fiscalQuarter");
  });

  it("requires instrument identity for instrument concepts", () => {
    expect(() => ObservationSchema.parse({
      ...observation,
      concept: "market.price.close",
      period: {
        kind: "instant",
        endDate: "2025-12-31",
        fiscalYear: 2025,
        presentation: "annual",
      },
    })).toThrow("Instrument-scoped concepts require instrumentId");
  });

  it("keeps verification status and usability consistent", () => {
    expect(() => VerificationResultSchema.parse({
      verificationId: "vr:invalid",
      status: "failed",
      usable: true,
      observationIds: ["obs:1"],
      independentUpstreamSourceIds: ["eastmoney"],
      reasonCodes: ["UNRESOLVED_SOURCE_CONFLICT"],
    })).toThrow("Failed verification cannot be usable");
    expect(() => VerificationResultSchema.parse({
      verificationId: "vr:invalid-warning",
      status: "warning",
      usable: false,
      observationIds: ["obs:1"],
      independentUpstreamSourceIds: ["eastmoney"],
      reasonCodes: ["SINGLE_INDEPENDENT_SOURCE"],
    })).toThrow("Verified or warning verification must be usable");
  });

  it("accepts an explicit failed empty FactSet", () => {
    const factSet = VerifiedFactSetSchema.parse(emptyFactSetInput());
    expect(factSet.summary.overallStatus).toBe("failed");
  });

  it("rejects unsupported versions and unknown top-level fields", () => {
    expect(VERIFIED_FACT_SET_SCHEMA_VERSION).toBe("1.1.0");
    expect(isSupportedVerifiedFactSetSchemaVersion("1.0.0")).toBe(true);
    expect(isSupportedVerifiedFactSetSchemaVersion("1.1.0")).toBe(true);
    expect(isSupportedVerifiedFactSetSchemaVersion("2.0.0")).toBe(false);
    expect(() => parseVerifiedFactSet({
      schemaVersion: "2.0.0",
    })).toThrow();
    const valid = emptyFactSetInput();
    expect(() => parseVerifiedFactSet({
      ...valid,
      unexpected: true,
    })).toThrow("Unrecognized key");
  });

  it("requires explicit temporal metadata for 1.1.0 FactSets", () => {
    expect(() => VerifiedFactSetSchema.parse({
      ...emptyFactSetInput(),
      schemaVersion: "1.1.0",
    })).toThrow("requires request.knowledgeAsOf");
  });

  it("keeps 1.1.0 request and temporal context consistent", () => {
    const current = {
      ...emptyFactSetInput(),
      schemaVersion: "1.1.0" as const,
      request: {
        ...emptyFactSetInput().request,
        knowledgeAsOf: "2026-07-26T23:59:59+08:00",
      },
      temporalContext: {
        effectiveAsOf: "2026-07-26T23:59:59+08:00",
        knowledgeAsOf: "2026-07-26T23:59:59+08:00",
        mode: "post-disclosure" as const,
        facts: [],
      },
    };
    expect(() => VerifiedFactSetSchema.parse(current))
      .toThrow("temporalContext.mode must be point-in-time");
  });
});
