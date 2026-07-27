import { createHash } from "node:crypto";
import {
  parseProviderBatch,
  type FetchImplementation,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it } from "vitest";
import { BaiduProvider } from "./provider.js";

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

const payload = {
  Result: [{
    DisplayData: {
      resultData: {
        tplData: {
          result: {
            code: "600519",
            name: "贵州茅台",
            minute_data: {
              update: { time: "1785120143" },
              pankouinfos: {
                origin_pankou: {
                  currentPrice: "1288.05",
                  capitalization: "1610167606168",
                  totalShareCapital: "1250081601",
                  peratio: "19.466",
                  bvRatio: "6.92",
                },
              },
            },
          },
        },
      },
    },
  }],
};

describe("BaiduProvider", () => {
  it("finds the nested origin payload and maps exact A-share values", async () => {
    const fetchImplementation: FetchImplementation = async () =>
      new Response(JSON.stringify(payload));
    const provider = new BaiduProvider({
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
        { conceptId: "market.shares.outstanding", required: true },
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

    expect(batch.company.legalName).toBe("贵州茅台");
    expect(batch.observations.find((item) => item.concept === "market.cap"))
      .toMatchObject({ value: "1610167606168", scale: "1" });
    expect(batch.observations.find((item) => item.concept === "valuation.peTtm"))
      .toMatchObject({ value: "19.466" });
    expect(batch.issues).toEqual([]);
  });

  it("does not expose Baidu's conflicting HK PE as PE TTM", async () => {
    const fetchImplementation: FetchImplementation = async () =>
      new Response(JSON.stringify(payload));
    const provider = new BaiduProvider({
      fetchImplementation,
      retries: 0,
    });
    const batch = await provider.fetch({
      instrument: {
        instrumentId: "XHKG:00700",
        companyId: "company:XHKG:00700",
        exchangeMic: "XHKG",
        symbol: "00700",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [{ conceptId: "valuation.peTtm", required: true }],
      asOf: "2026-07-27T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    });
    expect(batch.observations).toEqual([]);
  });
});
