import { describe, expect, it } from "vitest";
import { ProvenanceSchema } from "./provenance.js";

describe("provenance", () => {
  it("separates adapter identity from the real upstream", () => {
    const provenance = ProvenanceSchema.parse({
      providerId: "legacy-akshare-adapter",
      upstreamSourceId: "eastmoney",
      sourceType: "aggregator",
      sourceUrl: "https://example.invalid/source",
      rawSnapshotId: "sha256:abc",
      rawField: "TOTAL_OPERATE_INCOME",
      extractionMethod: "api",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      transformations: [],
    });
    expect(provenance.providerId).not.toBe(provenance.upstreamSourceId);
  });

  it("rejects missing raw lineage", () => {
    expect(() => ProvenanceSchema.parse({
      providerId: "eastmoney-direct",
      upstreamSourceId: "eastmoney",
      sourceType: "aggregator",
      sourceUrl: "https://example.invalid/source",
      rawField: "f116",
      extractionMethod: "api",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      transformations: [],
    })).toThrow();
  });
});
