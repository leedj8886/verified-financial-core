import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseProviderBatch,
  type FetchImplementation,
  type ProviderRequest,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it, vi } from "vitest";
import { EastmoneyProvider } from "./provider.js";

const fixtureRoot = new URL(
  "../../../tests/fixtures/providers/eastmoney/",
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
      ...input,
      body: undefined,
      snapshotId: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      byteLength: body.byteLength,
    };
  },
};

describe("EastmoneyProvider", () => {
  it("preserves exact decimals and maps public quote and statements", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "push2.eastmoney.com") {
          return new Response(await fixture("quote-600519.json"));
        }
        switch (url.searchParams.get("reportName")) {
          case "RPT_DMSK_FN_INCOME":
            return new Response(await fixture("income-600519-2025.json"));
          case "RPT_DMSK_FN_BALANCE":
            return new Response(await fixture("balance-600519-2025.json"));
          case "RPT_DMSK_FN_CASHFLOW":
            return new Response(await fixture("cashflow-600519-2025.json"));
          default:
            return new Response("not found", { status: 404 });
        }
      },
    );
    const provider = new EastmoneyProvider({
      fetchImplementation,
      retries: 0,
    });
    const request = {
      instrument: {
        instrumentId: "XSHG:600519",
        companyId: "company:XSHG:600519",
        exchangeMic: "XSHG" as const,
        symbol: "600519",
        shareClass: "A" as const,
        tradingCurrency: "CNY" as const,
      },
      requirements: [
        { conceptId: "market.cap" as const, required: true },
        { conceptId: "valuation.pb" as const, required: true },
        { conceptId: "valuation.peTtm" as const, required: true },
        {
          conceptId: "income.revenue" as const,
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" as const },
        },
        {
          conceptId: "balance.assets" as const,
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" as const },
        },
        {
          conceptId: "cashFlow.operatingCashFlow" as const,
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" as const },
        },
      ],
      asOf: "2026-07-27T23:59:59+08:00",
      offline: false,
    };
    const batch = parseProviderBatch(provider, await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.company.legalName).toBe("贵州茅台");
    expect(batch.rawSnapshots).toHaveLength(4);
    expect(batch.rawSnapshots.every((snapshot) => snapshot.byteLength > 0))
      .toBe(true);
    expect(batch.observations.find((item) => item.concept === "market.cap"))
      .toMatchObject({ value: "1611130169000.8198", scale: "1" });
    expect(batch.observations.find((item) => item.concept === "income.revenue"))
      .toMatchObject({
        value: "172054171890.91",
        availability: {
          publishedAt: "2026-04-17T23:59:59+08:00",
        },
      });
    expect(batch.unmapped).toEqual([
      expect.objectContaining({ rawField: "f162", rawValue: "14.79" }),
    ]);
  });

  it("returns a typed issue without network access in offline mode", async () => {
    const provider = new EastmoneyProvider();
    const batch = await provider.fetch({
      instrument: {
        instrumentId: "XHKG:00700",
        companyId: "company:XHKG:00700",
        exchangeMic: "XHKG",
        symbol: "00700",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
      requirements: [{ conceptId: "market.price.close", required: true }],
      asOf: "2026-07-27T23:59:59+08:00",
      offline: true,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:00:00+08:00",
      snapshots,
    });
    expect(batch.issues[0]?.code).toBe("EMPTY_RESPONSE");
    expect(batch.rawSnapshots).toEqual([]);
  });

  it("returns the last unadjusted daily close available at historical as-of", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        expect(url.hostname).toBe("history.example");
        expect(url.searchParams.get("fqt")).toBe("0");
        expect(url.searchParams.get("klt")).toBe("101");
        expect(url.searchParams.get("end")).toBe("20250727");
        return new Response(await fixture("history-600519-2025.json"));
      },
    );
    const provider = new EastmoneyProvider({
      fetchImplementation,
      historyEndpoint: "https://history.example/kline",
      retries: 0,
    });
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
      }],
      asOf: "2025-07-27T23:59:59+08:00",
      offline: false,
    };
    const batch = parseProviderBatch(provider, await provider.fetch(
      historicalRequest,
      {
        signal: new AbortController().signal,
        now: "2026-07-28T10:00:00+08:00",
        snapshots,
      },
    ));
    expect(batch.issues).toEqual([]);
    expect(batch.company.legalName).toBe("贵州茅台");
    expect(batch.rawSnapshots).toHaveLength(1);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "market.price.close",
        value: "1455.00",
        period: expect.objectContaining({
          endDate: "2025-07-25",
        }),
        availability: expect.objectContaining({
          publishedAt: "2025-07-25T15:30:00+08:00",
        }),
        provenance: expect.objectContaining({
          rawField: "f53",
          transformations: [
            expect.objectContaining({
              transformId: "unadjusted-daily-close",
            }),
            expect.objectContaining({
              transformId: "conservative-market-close",
            }),
          ],
        }),
      }),
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("does not expose a same-day daily close before the conservative close time", async () => {
    const provider = new EastmoneyProvider({
      fetchImplementation: async () =>
        new Response(await fixture("history-600519-2025.json")),
      historyEndpoint: "https://history.example/kline",
      retries: 0,
    });
    const baseRequest: ProviderRequest = {
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
      }],
      asOf: "2025-07-25T15:29:59+08:00",
      offline: false,
    };
    const beforeClose = await provider.fetch(baseRequest, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    });
    expect(beforeClose.observations[0]?.period.endDate).toBe("2025-07-24");
    const atClose = await provider.fetch({
      ...baseRequest,
      asOf: "2025-07-25T15:30:00+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    });
    expect(atClose.observations[0]?.period.endDate).toBe("2025-07-25");
  });
});
