import { describe, expect, it } from "vitest";
import {
  ProviderBatchSchema,
  ProviderFailure,
  ProviderRequestSchema,
  parseProviderBatch,
  type SourceProvider,
  type StoredSnapshotRef,
} from "./contract.js";

const instrument = {
  instrumentId: "XSHG:600519",
  companyId: "company:600519",
  exchangeMic: "XSHG" as const,
  symbol: "600519",
  shareClass: "A" as const,
  tradingCurrency: "CNY" as const,
};
const snapshot: StoredSnapshotRef = {
  snapshotId: `sha256:${"a".repeat(64)}`,
  providerId: "fixture",
  sourceUrl: "https://example.invalid/fixture",
  mediaType: "json",
  fetchedAt: "2026-07-27T10:00:00+08:00",
  byteLength: 2,
};
const observation = {
  observationId: "obs:fixture",
  companyId: "company:600519",
  concept: "income.revenue" as const,
  value: "100",
  unit: "CNY",
  scale: "1",
  period: {
    kind: "duration" as const,
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    fiscalYear: 2025,
    presentation: "annual" as const,
  },
  basis: {
    standard: "CAS" as const,
    scope: "consolidated" as const,
    presentation: "reported" as const,
    attribution: "parent" as const,
    currency: "CNY",
  },
  availability: {
    publishedAt: "2026-03-20T18:00:00+08:00",
    fetchedAt: "2026-07-27T10:00:00+08:00",
  },
  provenance: {
    providerId: "fixture",
    upstreamSourceId: "fixture-upstream",
    sourceType: "aggregator" as const,
    sourceUrl: "https://example.invalid/fixture",
    rawSnapshotId: snapshot.snapshotId,
    rawField: "revenue",
    extractionMethod: "api" as const,
    fetchedAt: "2026-07-27T10:00:00+08:00",
    transformations: [],
  },
};
const batch = {
  providerId: "fixture",
  upstreamSourceId: "fixture-upstream",
  company: {
    companyId: "company:600519",
    legalName: "Fixture Company",
    jurisdiction: "CN",
  },
  instruments: [instrument],
  observations: [observation],
  unmapped: [],
  rawSnapshots: [snapshot],
  mappingVersions: ["fixture@1"],
  issues: [],
};
const provider: SourceProvider = {
  providerId: "fixture",
  upstreamSourceId: "fixture-upstream",
  capabilities: ["financials"],
  async fetch() {
    return batch;
  },
};

describe("provider contract", () => {
  it("accepts a complete provider request and batch", () => {
    expect(ProviderRequestSchema.parse({
      instrument,
      requirements: [{
        conceptId: "income.revenue",
        required: true,
      }],
      asOf: "2026-07-27T23:59:59+08:00",
      offline: false,
    }).instrument.instrumentId).toBe("XSHG:600519");
    expect(parseProviderBatch(provider, batch).observations).toHaveLength(1);
  });

  it("rejects lineage outside the provider batch", () => {
    expect(() => ProviderBatchSchema.parse({
      ...batch,
      rawSnapshots: [],
    })).toThrow("snapshot outside its batch");
  });

  it("rejects provider identity spoofing", () => {
    expect(() => parseProviderBatch(provider, {
      ...batch,
      providerId: "other",
      observations: [{
        ...observation,
        provenance: {
          ...observation.provenance,
          providerId: "other",
        },
      }],
    })).toThrow("PROVIDER_IDENTITY_MISMATCH");
  });

  it("keeps provider failures machine-readable", () => {
    const failure = new ProviderFailure({
      providerId: "fixture",
      code: "RATE_LIMITED",
      message: "Quota exhausted",
      retryable: true,
    });
    expect(failure.issue).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });
});
