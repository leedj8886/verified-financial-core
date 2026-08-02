import { createHash } from "node:crypto";
import {
  parseProviderBatch,
  type FetchImplementation,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it } from "vitest";
import { BaiduHkFinancialProvider } from "./financial-provider.js";
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

describe("BaiduHkFinancialProvider", () => {
  const financialPayload = {
    Result: {
      content: {
        profitSheetV2: {
          unit: "亿人民币",
          chartInfo: [{
            type: "全部",
            header: ["总营收", "股东应占溢利", "除税后溢利", "经营溢利"],
            body: [[
              "2024FY",
              "248.29", "22.30",
              "44.37", "41.44",
              "44.54", "39.76",
              "58.20", "39.60",
            ]],
          }],
        },
        balanceSheetV2: {
          unit: "亿人民币",
          chartInfo: [{
            type: "全部",
            header: ["总资产", "总负债", "总权益", "现金及等价物"],
            body: [[
              "2024FY",
              "197.83", "35.56",
              "47.23", "18.13",
              "150.61", "42.34",
              "53.18", "56.87",
            ]],
          }],
        },
        cashFlowSheetV2: {
          unit: "亿人民币",
          chartInfo: [{
            type: "全部",
            header: ["经营现金流"],
            body: [["2024FY", "60.09", "58.38"]],
          }],
        },
      },
    },
  };

  it("maps H-share V2 financial tables without inventing a filing date", async () => {
    const fetchImplementation: FetchImplementation = async (input) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("finance.pae.baidu.com");
      expect(url.searchParams.get("code")).toBe("02097");
      expect(url.searchParams.get("market")).toBe("hk");
      expect(url.searchParams.get("widgetType")).toBe("finance");
      return new Response(JSON.stringify(financialPayload));
    };
    const provider = new BaiduHkFinancialProvider({
      fetchImplementation,
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
      instrument: {
        instrumentId: "XHKG:02097",
        companyId: "company:XHKG:02097",
        exchangeMic: "XHKG",
        symbol: "02097",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
        {
          conceptId: "income.netProfitParent",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
        {
          conceptId: "balance.assets",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
        {
          conceptId: "balance.equity",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
        {
          conceptId: "cashFlow.operatingCashFlow",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
      ],
      asOf: "2024-12-31T23:59:59+08:00",
      knowledgeAsOf: "2026-08-02T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-08-02T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.observations.find((item) => item.concept === "income.revenue"))
      .toMatchObject({
        value: "248.29",
        unit: "CNY",
        scale: "100000000",
        availability: {
          publishedAt: "2026-08-02T10:00:00+08:00",
          sourceAsOf: "2026-08-02T10:00:00+08:00",
        },
        provenance: {
          rawField: "profitSheetV2.总营收",
          transformations: expect.arrayContaining([
            expect.objectContaining({ transformId: "current-view-no-filing-date" }),
          ]),
        },
      });
    expect(batch.observations.find((item) => item.concept === "income.revenue"))
      .not.toHaveProperty("reportingVersion");
    expect(batch.observations.find((item) => item.concept === "income.netProfitParent"))
      .toMatchObject({ value: "44.37", scale: "100000000" });
    expect(batch.observations.find((item) => item.concept === "balance.assets"))
      .toMatchObject({ value: "197.83" });
    expect(batch.observations.find((item) => item.concept === "balance.equity"))
      .toMatchObject({ value: "150.61" });
    expect(batch.observations.find((item) => item.concept === "cashFlow.operatingCashFlow"))
      .toMatchObject({ value: "60.09" });
    expect(batch.issues).toEqual([]);
  });

  it("supports only H-share instruments", async () => {
    const provider = new BaiduHkFinancialProvider();
    expect(provider.supportsInstrument({
      instrumentId: "XHKG:02097",
      companyId: "company:XHKG:02097",
      exchangeMic: "XHKG",
      symbol: "02097",
      shareClass: "H",
      tradingCurrency: "HKD",
    })).toBe(true);
    expect(provider.supportsInstrument({
      instrumentId: "XSHG:600519",
      companyId: "company:XSHG:600519",
      exchangeMic: "XSHG",
      symbol: "600519",
      shareClass: "A",
      tradingCurrency: "CNY",
    })).toBe(false);
  });
});
