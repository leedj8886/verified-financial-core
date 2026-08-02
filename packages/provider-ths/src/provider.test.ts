import { createHash } from "node:crypto";
import {
  parseProviderBatch,
  type FetchImplementation,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it, vi } from "vitest";
import { ThsFinancialProvider } from "./provider.js";

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

function page(
  data: unknown[],
  options: { page: number; size?: number; total?: number },
): string {
  return JSON.stringify({
    status_code: 0,
    data: {
      page: options.page,
      size: options.size ?? 1,
      total: options.total ?? data.length,
      data,
    },
  });
}

const report2024H1 = {
  report: "2024-2",
  report_name: "2024中报",
  date: "2024-06-30",
  quarter_name: "2024二季度",
  index_list: {
    operating_income_total: {
      value: "27433010105.0900",
      single: "15000000000.0000",
    },
    operating_profit: { value: "14000000000.0000", single: "7000000000" },
    net_profit: { value: "10981937854.8500", single: "5900000000" },
    parent_holder_net_profit: {
      value: "10569764458.8800",
      single: "5600000000",
    },
  },
};

const report2023FY = {
  report: "2023-4",
  report_name: "2023年报",
  date: "2023-12-31",
  quarter_name: "2023四季度",
  index_list: {
    operating_income_total: { value: "60000000000.0000", single: "18000000000" },
    operating_profit: { value: "24000000000.0000", single: "7000000000" },
    net_profit: { value: "21000000000.0000", single: "6000000000" },
    parent_holder_net_profit: { value: "20000000000.0000", single: "5800000000" },
  },
};

describe("ThsFinancialProvider", () => {
  it("maps exact cumulative A-share values and paginates every requested statement", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({
        Referer: "https://basic.10jqka.com.cn/",
      });
      expect(String((init?.headers as Record<string, string>)["User-Agent"]))
        .toContain("Mozilla");
      expect(url.searchParams.get("code")).toBe("600030");
      expect(url.searchParams.get("market")).toBe("17");
      const statement = url.searchParams.get("id");
      const requestedPage = Number(url.searchParams.get("page"));
      if (statement === "client_stock_benefit") {
        return new Response(requestedPage === 1
          ? page([report2024H1], { page: 1, total: 2 })
          : page([report2023FY], { page: 2, total: 2 }));
      }
      if (statement === "client_stock_debt") {
        return new Response(page([{
          ...report2024H1,
          index_list: {
            assets_total: { value: "1500000000000.0000" },
            total_debt: { value: "1200000000000.0000" },
            holder_equity_total: { value: "300000000000.0000" },
            cash: { value: "120000000000.0000" },
          },
        }], { page: 1 }));
      }
      if (statement === "client_stock_cash") {
        return new Response(page([{
          ...report2024H1,
          index_list: {
            act_cash_flow_net: { value: "18000000000.0000" },
            pay_fixed_assets_etc_cash: { value: "3000000000.0000" },
          },
        }], { page: 1 }));
      }
      return new Response("not found", { status: 404 });
    });
    const provider = new ThsFinancialProvider({
      fetchImplementation,
      pageSize: 1,
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
      instrument: {
        instrumentId: "XSHG:600030",
        companyId: "company:XSHG:600030",
        exchangeMic: "XSHG",
        symbol: "600030",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: [
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2024, fiscalQuarter: 2, presentation: "ytd" },
        },
        {
          conceptId: "income.netProfitParent",
          required: true,
          period: { fiscalYear: 2024, fiscalQuarter: 2, presentation: "ytd" },
        },
        {
          conceptId: "balance.assets",
          required: true,
          period: { fiscalYear: 2024, fiscalQuarter: 2, presentation: "ytd" },
        },
        {
          conceptId: "cashFlow.operatingCashFlow",
          required: true,
          period: { fiscalYear: 2024, fiscalQuarter: 2, presentation: "ytd" },
        },
      ],
      asOf: "2024-08-30T23:59:59+08:00",
      knowledgeAsOf: "2026-08-02T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-08-02T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.observations.find((item) => item.concept === "income.revenue"))
      .toMatchObject({
        value: "27433010105.0900",
        scale: "1",
        availability: {
          publishedAt: "2026-08-02T10:00:00+08:00",
          sourceAsOf: "2026-08-02T10:00:00+08:00",
        },
        provenance: {
          rawField: "operating_income_total.value",
          transformations: [
            expect.objectContaining({ transformId: "current-view-no-filing-date" }),
          ],
        },
      });
    expect(batch.observations.find((item) => item.concept === "income.revenue"))
      .not.toHaveProperty("reportingVersion");
    expect(batch.observations.find((item) => item.concept === "income.netProfitParent"))
      .toMatchObject({ value: "10569764458.8800" });
    expect(batch.observations.find((item) => item.concept === "balance.assets"))
      .toMatchObject({ value: "1500000000000.0000" });
    expect(batch.observations.find((item) => item.concept === "cashFlow.operatingCashFlow"))
      .toMatchObject({ value: "18000000000.0000" });
    expect(batch.rawSnapshots).toHaveLength(4);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(batch.issues).toEqual([]);
  });

  it("uses single-quarter values only for quarter presentation", async () => {
    const provider = new ThsFinancialProvider({
      fetchImplementation: async () =>
        new Response(page([report2024H1], { page: 1 })),
      retries: 0,
    });
    const batch = await provider.fetch({
      instrument: {
        instrumentId: "XSHE:000001",
        companyId: "company:XSHE:000001",
        exchangeMic: "XSHE",
        symbol: "000001",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2024, fiscalQuarter: 2, presentation: "quarter" },
      }],
      asOf: "2024-08-30T23:59:59+08:00",
      knowledgeAsOf: "2026-08-02T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-08-02T10:00:00+08:00",
      snapshots,
    });

    expect(batch.observations).toEqual([
      expect.objectContaining({
        value: "15000000000.0000",
        period: expect.objectContaining({ presentation: "quarter" }),
        provenance: expect.objectContaining({
          rawField: "operating_income_total.single",
        }),
      }),
    ]);
  });

  it("does not mislabel a cumulative report as a direct TTM fact", async () => {
    const provider = new ThsFinancialProvider({
      fetchImplementation: async () =>
        new Response(page([report2024H1], { page: 1 })),
      retries: 0,
    });
    const batch = await provider.fetch({
      instrument: {
        instrumentId: "XSHG:600030",
        companyId: "company:XSHG:600030",
        exchangeMic: "XSHG",
        symbol: "600030",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2024, fiscalQuarter: 2, presentation: "ttm" },
      }],
      asOf: "2024-08-30T23:59:59+08:00",
      knowledgeAsOf: "2026-08-02T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-08-02T10:00:00+08:00",
      snapshots,
    });

    expect(batch.observations).toEqual([]);
  });

  it("rejects H shares before network access", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>();
    const provider = new ThsFinancialProvider({ fetchImplementation });
    expect(provider.supportsInstrument({
      instrumentId: "XHKG:02097",
      companyId: "company:XHKG:02097",
      exchangeMic: "XHKG",
      symbol: "02097",
      shareClass: "H",
      tradingCurrency: "HKD",
    })).toBe(false);
    const batch = await provider.fetch({
      instrument: {
        instrumentId: "XHKG:02097",
        companyId: "company:XHKG:02097",
        exchangeMic: "XHKG",
        symbol: "02097",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [{ conceptId: "income.revenue", required: true }],
      asOf: "2026-08-02T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-08-02T10:00:00+08:00",
      snapshots,
    });
    expect(batch.issues[0]).toMatchObject({
      code: "UNSUPPORTED_INSTRUMENT",
      reasonCode: "THS_A_SHARE_ONLY",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
