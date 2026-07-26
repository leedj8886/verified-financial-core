import { describe, expect, it } from "vitest";
import {
  FactRequestSchema,
  ObservationSchema,
  VerificationResultSchema,
  VerifiedFactSetSchema,
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
    const factSet = VerifiedFactSetSchema.parse({
      schemaVersion: "1.0.0",
      factSetId: "fs:empty",
      request: {
        instrument: "XSHG:600519",
        requirements: [{
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
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
        overallStatus: "failed",
      },
    });
    expect(factSet.summary.overallStatus).toBe("failed");
  });
});
