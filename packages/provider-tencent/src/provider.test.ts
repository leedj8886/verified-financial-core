import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseProviderBatch,
  type FetchImplementation,
  type ProviderRequest,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it } from "vitest";
import { TencentProvider } from "./provider.js";

const fixtureRoot = new URL(
  "../../../tests/fixtures/providers/tencent/",
  import.meta.url,
);

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(name, fixtureRoot), "utf8");
}

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

function quoteFixture(): string {
  const fields = Array<string>(60).fill("");
  fields[1] = "MOUTAI";
  fields[2] = "600519";
  fields[3] = "1288.82";
  fields[30] = "20260727104141";
  fields[39] = "19.48";
  fields[45] = "16111.30";
  fields[46] = "6.92";
  return `v_sh600519="${fields.join("~")}";`;
}

const historicalRequest: ProviderRequest = {
  instrument: {
    instrumentId: "XSHG:600519",
    companyId: "company:XSHG:600519",
    exchangeMic: "XSHG",
    symbol: "600519",
    shareClass: "A",
    tradingCurrency: "CNY",
  },
  requirements: [{
    conceptId: "market.price.close",
    required: true,
    period: {
      fiscalYear: 2025,
      fiscalQuarter: 3,
      presentation: "quarter",
    },
  }],
  asOf: "2025-07-27T23:59:59+08:00",
  offline: false,
};

describe("TencentProvider", () => {
  it("keeps quote ratios exact and expresses market cap with a source scale", async () => {
    const fetchImplementation: FetchImplementation = async () =>
      new Response(quoteFixture());
    const provider = new TencentProvider({
      fetchImplementation,
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
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
        { conceptId: "valuation.peTtm", required: true },
        { conceptId: "valuation.pb", required: true },
      ],
      asOf: "2026-07-27T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    }));

    expect(batch.company.legalName).toBe("MOUTAI");
    expect(batch.rawSnapshots[0]?.byteLength).toBeGreaterThan(0);
    expect(batch.observations.find((item) => item.concept === "market.cap"))
      .toMatchObject({ value: "16111.30", scale: "100000000" });
    expect(batch.observations.find((item) => item.concept === "valuation.peTtm"))
      .toMatchObject({ value: "19.48", scale: "1" });
    expect(batch.observations.find((item) => item.concept === "valuation.pb"))
      .toMatchObject({ value: "6.92", scale: "1" });
  });

  it("returns the last unadjusted daily close available before a weekend asOf", async () => {
    const calls: string[] = [];
    const fetchImplementation: FetchImplementation = async (input) => {
      calls.push(String(input));
      return new Response(await fixture("history-600519-2025.json"));
    };
    const provider = new TencentProvider({
      fetchImplementation,
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch(
      historicalRequest,
      {
        signal: new AbortController().signal,
        now: "2026-07-27T10:45:00+08:00",
        snapshots,
      },
    ));

    expect(batch.issues).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/appstock/app/kline/kline?");
    expect(calls[0]).toContain(
      "param=sh600519%2Cday%2C2025-01-28%2C2025-07-27%2C200",
    );
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "market.price.close",
        value: "1455.000",
        period: expect.objectContaining({
          endDate: "2025-07-27",
          fiscalYear: 2025,
          fiscalQuarter: 3,
          presentation: "quarter",
        }),
        availability: expect.objectContaining({
          effectiveDate: "2025-07-25",
          publishedAt: "2025-07-25T15:30:00+08:00",
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

  it("keeps the history window below Tencent's effective row cap", async () => {
    const calls: string[] = [];
    const provider = new TencentProvider({
      fetchImplementation: async (input) => {
        calls.push(String(input));
        return new Response(await fixture("history-600519-2025.json"));
      },
      retries: 0,
    });

    await provider.fetch(historicalRequest, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    });

    expect(calls[0]).toContain(
      "param=sh600519%2Cday%2C2025-01-28%2C2025-07-27%2C200",
    );
  });

  it("does not expose a daily close before its conservative availability time", async () => {
    const fetchImplementation: FetchImplementation = async () =>
      new Response(await fixture("history-600519-2025.json"));
    const provider = new TencentProvider({
      fetchImplementation,
      retries: 0,
    });

    const beforeClose = parseProviderBatch(provider, await provider.fetch({
      ...historicalRequest,
      asOf: "2025-07-25T15:29:59+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    }));
    const atClose = parseProviderBatch(provider, await provider.fetch({
      ...historicalRequest,
      asOf: "2025-07-25T15:30:00+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    }));

    expect(beforeClose.observations[0]).toMatchObject({
      value: "1491.500",
      period: { endDate: "2025-07-25" },
      availability: { effectiveDate: "2025-07-24" },
    });
    expect(atClose.observations[0]).toMatchObject({
      value: "1455.000",
      period: { endDate: "2025-07-25" },
      availability: { effectiveDate: "2025-07-25" },
    });
  });

  it("uses the later conservative close time for Hong Kong instruments", async () => {
    const provider = new TencentProvider({
      fetchImplementation: async () =>
        new Response(await fixture("history-00700-2025.json")),
      retries: 0,
    });
    const request: ProviderRequest = {
      instrument: {
        instrumentId: "XHKG:00700",
        companyId: "company:XHKG:00700",
        exchangeMic: "XHKG",
        symbol: "00700",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [{ conceptId: "market.price.close", required: true }],
      asOf: "2025-07-25T16:29:59+08:00",
      offline: false,
    };

    const beforeClose = await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    });
    const atClose = await provider.fetch({
      ...request,
      asOf: "2025-07-25T16:30:00+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    });

    expect(beforeClose.observations[0]).toMatchObject({
      value: "557.000",
      period: { endDate: "2025-07-25" },
      availability: { effectiveDate: "2025-07-24" },
    });
    expect(atClose.observations[0]).toMatchObject({
      value: "550.500",
      period: { endDate: "2025-07-25" },
      availability: {
        effectiveDate: "2025-07-25",
        publishedAt: "2025-07-25T16:30:00+08:00",
      },
    });
  });
});
