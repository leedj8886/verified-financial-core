import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseProviderBatch,
  type FetchImplementation,
  type ProviderRequest,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it, vi } from "vitest";
import {
  extractFinancialValues,
  HkexProvider,
} from "./provider.js";

const fixtureRoot = new URL(
  "../../../tests/fixtures/providers/hkex/",
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
      providerId: input.providerId,
      sourceUrl: input.sourceUrl,
      mediaType: input.mediaType,
      fetchedAt: input.fetchedAt,
      snapshotId: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      byteLength: body.byteLength,
    };
  },
};

const request: ProviderRequest = {
  instrument: {
    instrumentId: "XHKG:00700",
    companyId: "company:XHKG:00700",
    exchangeMic: "XHKG",
    symbol: "00700",
    shareClass: "H",
    tradingCurrency: "HKD",
  },
  requirements: [
    "income.revenue",
    "income.operatingProfit",
    "income.netProfit",
    "income.netProfitParent",
    "balance.assets",
    "balance.liabilities",
    "balance.equity",
    "balance.cash",
    "cashFlow.operatingCashFlow",
    "cashFlow.capex",
  ].map((conceptId) => ({
    conceptId: conceptId as ProviderRequest["requirements"][number]["conceptId"],
    required: true,
    period: { fiscalYear: 2025, presentation: "annual" as const },
  })),
  asOf: "2026-07-28T23:59:59+08:00",
  offline: false,
};

function mockFetch(options: {
  report?: string;
  results?: string;
  pdf?: string;
} = {}): FetchImplementation {
  return vi.fn<FetchImplementation>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search/prefix.do")) {
      expect(url.searchParams.get("name")).toBe("00700");
      expect(url.searchParams.get("callback")).toBe("callback");
      return new Response(await fixture("search-00700.jsonp"));
    }
    if (url.pathname.endsWith("/search/titleSearchServlet.do")) {
      const title = url.searchParams.get("title");
      expect(url.searchParams.get("stockId")).toBe("7609");
      expect(url.searchParams.get("toDate")).not.toContain("-");
      if (title === "annual report") {
        return new Response(
          options.report ?? await fixture("annual-report-00700-2025.json"),
        );
      }
      return new Response(
        options.results ?? await fixture("annual-results-00700-2025.json"),
      );
    }
    if (url.pathname.endsWith(".pdf")) {
      return new Response(options.pdf ?? "%PDF-fixture");
    }
    return new Response("not found", { status: 404 });
  });
}

describe("HkexProvider", () => {
  it("extracts current consolidated values, statement scale, and capex components", async () => {
    const text = await fixture("annual-00700-2025.txt");
    expect(extractFinancialValues([text])).toEqual({
      values: {
        "income.revenue": "751766",
        "income.operatingProfit": "241562",
        "income.netProfit": "229801",
        "income.netProfitParent": "224842",
        "balance.assets": "2038986",
        "balance.liabilities": "797921",
        "balance.equity": "1241065",
        "balance.cash": "141041",
        "cashFlow.operatingCashFlow": "303052",
        "cashFlow.capex": "112881",
      },
      currency: "CNY",
      scale: "1000000",
      standard: "IFRS",
    });
  });

  it("resolves the issuer, prefers the full report, and emits official facts", async () => {
    const fetchImplementation = mockFetch();
    const provider = new HkexProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        await fixture("annual-00700-2025.txt"),
      ],
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.company.legalName).toBe("TENCENT");
    expect(batch.issues).toEqual([]);
    expect(batch.unmapped).toEqual([]);
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["text", "json", "pdf"]);
    expect(batch.observations).toHaveLength(request.requirements.length);
    expect(batch.observations.find((item) =>
      item.concept === "income.revenue"
    )).toMatchObject({
      value: "751766",
      unit: "CNY",
      scale: "1000000",
      availability: {
        filingDate: "2026-04-09",
        publishedAt: "2026-04-09T17:21:00+08:00",
      },
      provenance: {
        sourceType: "official",
        documentId: "12100024",
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("falls back to the earlier results announcement for historical as-of", async () => {
    const fetchImplementation = mockFetch();
    const provider = new HkexProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        await fixture("annual-00700-2025.txt"),
      ],
      retries: 0,
    });
    const batch = await provider.fetch({
      ...request,
      asOf: "2026-03-18T16:31:00+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-03-18T16:31:00+08:00",
      snapshots,
    });
    expect(batch.issues).toEqual([]);
    expect(batch.observations[0]?.provenance.documentId).toBe("12056832");
    expect(batch.observations[0]?.availability.publishedAt)
      .toBe("2026-03-18T16:30:00+08:00");
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["text", "json", "json", "pdf"]);
  });

  it("fails closed before the exact release minute and does not download a PDF", async () => {
    const fetchImplementation = mockFetch({
      results: await fixture("empty.json"),
    });
    const provider = new HkexProvider({
      fetchImplementation,
      extractTextImplementation: async () => {
        throw new Error("Should not extract");
      },
      retries: 0,
    });
    const batch = await provider.fetch({
      ...request,
      asOf: "2026-04-09T17:20:00+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-04-09T17:20:00+08:00",
      snapshots,
    });
    expect(batch.observations).toEqual([]);
    expect(batch.issues[0]?.code).toBe("EMPTY_RESPONSE");
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("preserves unreadable PDFs and rejects non-HK or offline requests", async () => {
    const fetchImplementation = mockFetch();
    const provider = new HkexProvider({
      fetchImplementation,
      extractTextImplementation: async () => {
        throw new Error("Fixture parse failure");
      },
      retries: 0,
    });
    const unreadable = await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    });
    expect(unreadable.issues[0]?.code).toBe(
      "OFFICIAL_DOCUMENT_UNREADABLE",
    );
    expect(unreadable.rawSnapshots.at(-1)?.mediaType).toBe("pdf");

    const network = vi.fn<FetchImplementation>();
    const guarded = new HkexProvider({ fetchImplementation: network });
    const aShareRequest: ProviderRequest = {
      ...request,
      instrument: {
        instrumentId: "XSHG:600519",
        companyId: "company:XSHG:600519",
        exchangeMic: "XSHG",
        symbol: "600519",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
    };
    expect((await guarded.fetch(aShareRequest, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    })).issues[0]?.code).toBe("UNSUPPORTED_INSTRUMENT");
    expect((await guarded.fetch({
      ...request,
      offline: true,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    })).issues[0]?.code).toBe("EMPTY_RESPONSE");
    expect(network).not.toHaveBeenCalled();
  });
});
