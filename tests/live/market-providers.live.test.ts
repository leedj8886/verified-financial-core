import { createHash } from "node:crypto";
import { BaiduProvider } from "../../packages/provider-baidu/src/index.js";
import { CninfoProvider } from "../../packages/provider-cninfo/src/index.js";
import {
  parseProviderBatch,
  type ProviderRequest,
  type SnapshotWriter,
  type SourceProvider,
} from "../../packages/provider-contract/src/index.js";
import { EastmoneyProvider } from "../../packages/provider-eastmoney/src/index.js";
import { HkexProvider } from "../../packages/provider-hkex/src/index.js";
import { TencentProvider } from "../../packages/provider-tencent/src/index.js";
import { describe, expect, it } from "vitest";

const snapshots: SnapshotWriter = {
  async put(input) {
    const body = typeof input.body === "string"
      ? new TextEncoder().encode(input.body)
      : input.body;
    return {
      snapshotId: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      providerId: input.providerId,
      sourceUrl: input.sourceUrl,
      mediaType: input.mediaType,
      fetchedAt: input.fetchedAt,
      byteLength: body.byteLength,
    };
  },
};

const marketRequest: ProviderRequest = {
  instrument: {
    instrumentId: "XSHG:600519",
    companyId: "company:XSHG:600519",
    exchangeMic: "XSHG",
    symbol: "600519",
    shareClass: "A",
    tradingCurrency: "CNY",
  },
  requirements: [
    { conceptId: "market.price.close", required: true },
    { conceptId: "market.cap", required: true },
    { conceptId: "valuation.pb", required: true },
  ],
  asOf: new Date().toISOString(),
  offline: false,
};

async function fetchLive(provider: SourceProvider, request = marketRequest) {
  const batch = await provider.fetch(request, {
    signal: AbortSignal.timeout(25_000),
    now: new Date().toISOString(),
    snapshots,
  });
  return parseProviderBatch(provider, batch);
}

describe("public A/H provider live canaries", () => {
  for (const provider of [
    new EastmoneyProvider(),
    new TencentProvider(),
    new BaiduProvider(),
  ]) {
    it(`${provider.providerId} returns a current public quote`, async () => {
      const batch = await fetchLive(provider);
      expect(batch.issues).toEqual([]);
      expect(batch.observations.some((item) =>
        item.concept === "market.price.close"
      )).toBe(true);
      expect(batch.rawSnapshots[0]?.byteLength).toBeGreaterThan(0);
    });
  }

  it("Eastmoney returns a traceable annual statement", async () => {
    const provider = new EastmoneyProvider();
    const batch = await fetchLive(provider, {
      ...marketRequest,
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
    });
    expect(batch.issues).toEqual([]);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "income.revenue",
        period: expect.objectContaining({
          fiscalYear: 2025,
          presentation: "annual",
        }),
      }),
    ]);
  });

  it("Tencent returns the last historical unadjusted daily close", async () => {
    const provider = new TencentProvider();
    const batch = await fetchLive(provider, {
      ...marketRequest,
      requirements: [{
        conceptId: "market.price.close",
        required: true,
      }],
      asOf: "2025-07-27T23:59:59+08:00",
    });
    expect(batch.issues).toEqual([]);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "market.price.close",
        value: "1455.000",
        period: expect.objectContaining({
          endDate: "2025-07-25",
        }),
        provenance: expect.objectContaining({
          rawField: "[2]",
          transformations: expect.arrayContaining([
            expect.objectContaining({
              transformId: "unadjusted-daily-close",
            }),
          ]),
        }),
      }),
    ]);
  });

  it("Tencent returns a historical Hong Kong daily close", async () => {
    const provider = new TencentProvider();
    const batch = await fetchLive(provider, {
      instrument: {
        instrumentId: "XHKG:00700",
        companyId: "company:XHKG:00700",
        exchangeMic: "XHKG",
        symbol: "00700",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [{
        conceptId: "market.price.close",
        required: true,
      }],
      asOf: "2025-07-27T23:59:59+08:00",
      offline: false,
    });
    expect(batch.issues).toEqual([]);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "market.price.close",
        value: "550.500",
        period: expect.objectContaining({
          endDate: "2025-07-25",
        }),
        availability: expect.objectContaining({
          publishedAt: "2025-07-25T16:30:00+08:00",
        }),
      }),
    ]);
  });

  it("CNINFO returns a fact extracted from an official annual filing", async () => {
    const provider = new CninfoProvider();
    const batch = await fetchLive(provider, {
      ...marketRequest,
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
    });
    expect(batch.issues).toEqual([]);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "income.revenue",
        provenance: expect.objectContaining({
          sourceType: "official",
          extractionMethod: "pdf",
        }),
      }),
    ]);
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["json", "json", "pdf"]);
  });

  it("HKEX returns a fact extracted from an official annual filing", async () => {
    const provider = new HkexProvider();
    const batch = await fetchLive(provider, {
      instrument: {
        instrumentId: "XHKG:00700",
        companyId: "company:XHKG:00700",
        exchangeMic: "XHKG",
        symbol: "00700",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
      asOf: new Date().toISOString(),
      offline: false,
    });
    expect(batch.issues).toEqual([]);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "income.revenue",
        unit: "CNY",
        scale: "1000000",
        provenance: expect.objectContaining({
          sourceType: "official",
          extractionMethod: "pdf",
        }),
      }),
    ]);
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["text", "json", "pdf"]);
  });
});
