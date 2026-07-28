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
  CninfoProvider,
  extractFinancialValues,
} from "./provider.js";

const fixtureRoot = new URL(
  "../../../tests/fixtures/providers/cninfo/",
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
    instrumentId: "XSHG:600519",
    companyId: "company:XSHG:600519",
    exchangeMic: "XSHG",
    symbol: "600519",
    shareClass: "A",
    tradingCurrency: "CNY",
  },
  requirements: [
    "income.revenue",
    "income.netProfitParent",
    "balance.assets",
    "balance.liabilities",
    "balance.equity",
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

describe("CninfoProvider", () => {
  it("extracts current consolidated values without crossing statement boundaries", async () => {
    const text = await fixture("annual-600519-2025.txt");
    expect(extractFinancialValues([text])).toMatchObject({
      "income.revenue": "172054171890.91",
      "income.operatingProfit": "114808950164.24",
      "income.netProfit": "85310324833.67",
      "income.netProfitParent": "82320067101.68",
      "balance.assets": "303834844021.44",
      "balance.liabilities": "49875590112.37",
      "balance.equity": "253959253909.07",
      "balance.cash": "51690610946.50",
      "cashFlow.operatingCashFlow": "61522204989.35",
      "cashFlow.capex": "3127594916.41",
    });
  });

  it("resolves the issuer, selects the full report, and emits official facts", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          expect(init?.method).toBe("POST");
          expect(String(init?.body)).toContain("keyWord=600519");
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          expect(String(init?.body)).toContain(
            "category=category_ndbg_szsh",
          );
          return new Response(await fixture("annual-600519-2025.json"));
        }
        if (url.hostname === "static.cninfo.com.cn") {
          expect(url.pathname).toBe(
            "/finalpage/2026-04-17/1225114741.PDF",
          );
          return new Response("%PDF-fixture");
        }
        return new Response("not found", { status: 404 });
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        await fixture("annual-600519-2025.txt"),
      ],
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.company.legalName).toBe("贵州茅台");
    expect(batch.issues).toEqual([]);
    expect(batch.unmapped).toEqual([]);
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["json", "json", "pdf"]);
    expect(batch.observations).toHaveLength(request.requirements.length);
    expect(batch.observations.find((item) =>
      item.concept === "balance.liabilities"
    )).toMatchObject({ value: "49875590112.37" });
    expect(batch.observations.every((item) =>
      item.provenance.sourceType === "official"
      && item.provenance.documentId === "1225114741"
      && item.provenance.extractionMethod === "pdf"
      && item.availability.filingDate === "2026-04-17"
    )).toBe(true);
  });

  it("fails closed before end-of-day availability and never downloads the PDF", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(await fixture("annual-600519-2025.json"));
        }
        return new Response("%PDF-should-not-download");
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => {
        throw new Error("Should not extract");
      },
      retries: 0,
    });
    const batch = await provider.fetch({
      ...request,
      asOf: "2026-04-17T12:00:00+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2026-04-17T12:00:00+08:00",
      snapshots,
    });
    expect(batch.observations).toEqual([]);
    expect(batch.issues[0]?.code).toBe("EMPTY_RESPONSE");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("preserves an unreadable official PDF snapshot and returns a typed issue", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(await fixture("annual-600519-2025.json"));
        }
        return new Response("%PDF-unreadable-fixture");
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => {
        throw new Error("Fixture parse failure");
      },
      retries: 0,
    });
    const batch = await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    });
    expect(batch.observations).toEqual([]);
    expect(batch.issues[0]?.code).toBe("OFFICIAL_DOCUMENT_UNREADABLE");
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["json", "json", "pdf"]);
  });

  it("rejects H shares and stays offline without network access", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>();
    const provider = new CninfoProvider({ fetchImplementation });
    const hShareRequest: ProviderRequest = {
      ...request,
      instrument: {
        instrumentId: "XHKG:00700",
        companyId: "company:XHKG:00700",
        exchangeMic: "XHKG",
        symbol: "00700",
        shareClass: "H",
        tradingCurrency: "HKD",
      },
    };
    expect((await provider.fetch(hShareRequest, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    })).issues[0]?.code).toBe("UNSUPPORTED_INSTRUMENT");
    expect((await provider.fetch({
      ...request,
      offline: true,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    })).issues[0]?.code).toBe("EMPTY_RESPONSE");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
