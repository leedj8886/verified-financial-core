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
  extractFinancialColumns,
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
  it("selects point-in-time shares using both effective and disclosure dates", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(JSON.stringify([{
            code: "601111",
            orgId: "gssh0601111",
            zwjc: "中国国航",
          }]));
        }
        if (url.pathname.endsWith("/api/stock/p_stock2215")) {
          return new Response(await fixture("share-changes-601111.json"));
        }
        return new Response("not found", { status: 404 });
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
      instrument: {
        instrumentId: "XSHG:601111",
        companyId: "company:XSHG:601111",
        exchangeMic: "XSHG",
        symbol: "601111",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: [{
        conceptId: "market.shares.outstanding",
        required: true,
        period: {
          fiscalYear: 2024,
          fiscalQuarter: 3,
          presentation: "quarter",
        },
      }],
      asOf: "2024-08-30T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-30T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.observations).toEqual([
      expect.objectContaining({
        instrumentId: "XSHG:601111",
        concept: "market.shares.outstanding",
        value: "1659372.0146",
        scale: "10000",
        period: {
          kind: "instant",
          endDate: "2024-08-30",
          fiscalYear: 2024,
          fiscalQuarter: 3,
          presentation: "quarter",
        },
        availability: expect.objectContaining({
          effectiveDate: "2024-02-07",
          filingDate: "2024-02-08",
          publishedAt: "2024-02-08T23:59:59+08:00",
        }),
        provenance: expect.objectContaining({
          rawField: "records[].F003N",
          extractionMethod: "api",
        }),
      }),
    ]);
    expect(batch.issues).toEqual([]);

    const defaultPeriodBatch = parseProviderBatch(
      provider,
      await provider.fetch({
        ...request,
        instrument: {
          instrumentId: "XSHG:601111",
          companyId: "company:XSHG:601111",
          exchangeMic: "XSHG",
          symbol: "601111",
          shareClass: "A",
          tradingCurrency: "CNY",
        },
        requirements: [{
          conceptId: "market.shares.outstanding",
          required: true,
        }],
        asOf: "2024-08-30T23:59:59+08:00",
      }, {
        signal: new AbortController().signal,
        now: "2026-07-30T10:00:00+08:00",
        snapshots,
      }),
    );
    expect(defaultPeriodBatch.observations[0]?.period).toEqual({
      kind: "instant",
      endDate: "2024-08-30",
      fiscalYear: 2024,
      presentation: "annual",
    });
  });

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

  it("preserves ASCII, Unicode, spaced, and parenthesized negative values", async () => {
    const text = await fixture("negative-number-formats.txt");
    expect(extractFinancialValues([text], {
      fiscalYear: 2025,
      presentation: "annual",
    })).toMatchObject({
      "income.revenue": "-1234567.89",
      "income.operatingProfit": "-44114192.78",
      "income.netProfit": "-32895831.45",
      "income.netProfitParent": "-156923683.82",
    });
  });

  it("selects the current main statement after a historical correction table", async () => {
    const text = await fixture("annual-main-statement-after-correction.txt");
    expect(extractFinancialValues([text], {
      fiscalYear: 2023,
      presentation: "annual",
    })).toMatchObject({
      "income.revenue": "5151265004.81",
      "income.netProfitParent": "-1031561794.05",
    });
  });

  it("supports airline statement labels, integer values, losses, and thousand-CNY scale", async () => {
    const extraction = extractFinancialColumns([
      await fixture("airline-statement-labels.txt"),
    ], {
      fiscalYear: 2023,
      fiscalQuarter: 2,
      presentation: "ytd",
    });
    expect(extraction.current).toMatchObject({
      "income.revenue": "59613193",
      "income.netProfitParent": "-3450728",
    });
    expect(extraction.currentEvidence["income.revenue"]).toMatchObject({
      scale: "1000",
    });
  });

  it("maps parent profit labels that spell out owners or shareholders", () => {
    const extraction = extractFinancialColumns([
      [
        "招商证券股份有限公司",
        "合并利润表",
        "2023 年度",
        "单位：人民币元",
        "项目 本期发生额 上期发生额",
        "一、营业总收入 19,821,213,073.58 19,219,229,958.91",
        "五、净利润 8,769,086,837.42 8,077,129,934.88",
        "1.归属于母公司所有者（或股东）的净利润 8,763,959,184.96 8,070,242,869.23",
        "母公司利润表",
      ].join("\n"),
    ], {
      fiscalYear: 2023,
      presentation: "annual",
    });

    expect(extraction.current["income.netProfitParent"]).toBe(
      "8763959184.96",
    );
    expect(extraction.comparative["income.netProfitParent"]).toBe(
      "8070242869.23",
    );
  });

  it("extracts China Southern interim rows after an inline note column", async () => {
    const extraction = extractFinancialColumns([
      await fixture("china-southern-2023h1.txt"),
    ], {
      fiscalYear: 2023,
      fiscalQuarter: 2,
      presentation: "ytd",
    });
    expect(extraction).toMatchObject({
      current: {
        "income.revenue": "71830",
        "income.netProfitParent": "-2875",
      },
      comparative: {
        "income.revenue": "40817",
        "income.netProfitParent": "-11488",
      },
      currentEvidence: {
        "income.revenue": { scale: "1000000" },
        "income.netProfitParent": { scale: "1000000" },
      },
    });
  });

  it("selects consolidated columns from China Eastern combined statements", async () => {
    const extraction = extractFinancialColumns([
      await fixture("china-eastern-2023h1-combined.txt"),
    ], {
      fiscalYear: 2023,
      fiscalQuarter: 2,
      presentation: "ytd",
    });
    expect(extraction).toMatchObject({
      current: {
        "income.revenue": "49425",
        "income.netProfitParent": "-6249",
      },
      comparative: {
        "income.revenue": "19354",
        "income.netProfitParent": "-18736",
      },
      currentEvidence: {
        "income.revenue": { scale: "1000000" },
        "income.netProfitParent": { scale: "1000000" },
      },
    });
  });

  it("classifies blank embedded financial statements as image-only", () => {
    const extraction = extractFinancialColumns([
      [
        "中国东方航空股份有限公司 2023 年度报告",
        "一、近三年主要会计数据和财务指标",
        "（一）主要会计数据",
        "单位：人民币百万元",
        "主要会计数据 2023 年 2022 年 2021 年",
        "营业收入 113,741 46,305 46,111 67,339 67,127",
        "归属于上市公司股东的",
        "净利润 -8,168 -37,356 -37,386 -12,149 -12,214",
        "（二）主要财务指标",
      ].join("\n"),
      "第九节 备查文件目录",
      "",
      "",
      "",
      "",
      "中国东方航空股份有限公司\n2023 年度财务报表附注",
    ], {
      fiscalYear: 2023,
      presentation: "annual",
    });

    expect(extraction).toMatchObject({
      current: {},
      currentEvidence: {},
      failures: {
        "income.revenue": "STATEMENT_IMAGE_ONLY",
        "income.operatingProfit": "STATEMENT_IMAGE_ONLY",
        "income.netProfit": "STATEMENT_IMAGE_ONLY",
        "income.netProfitParent": "STATEMENT_IMAGE_ONLY",
        "balance.assets": "STATEMENT_IMAGE_ONLY",
        "cashFlow.operatingCashFlow": "STATEMENT_IMAGE_ONLY",
      },
    });
  });

  it("classifies a long blank annual-report section without readable anchors as image-only", () => {
    const extraction = extractFinancialColumns([
      "春秋航空股份有限公司 2023 年年度报告\n第九节 债券相关情况",
      "",
      "",
      "",
      "",
      "",
      "",
      "ᱛ、㡠グ㛗Գᴿ䲆ޢਮ\n2023 ᒪᓜ䍘ࣗᣛ㺞䱺⌞",
    ], {
      fiscalYear: 2023,
      presentation: "annual",
    });

    expect(extraction.current).toEqual({});
    expect(extraction.failures).toMatchObject({
      "income.revenue": "STATEMENT_IMAGE_ONLY",
      "income.netProfitParent": "STATEMENT_IMAGE_ONLY",
      "balance.assets": "STATEMENT_IMAGE_ONLY",
      "cashFlow.operatingCashFlow": "STATEMENT_IMAGE_ONLY",
    });
  });

  it("keeps the current plain-integer column in China Southern annual rows", async () => {
    const extraction = extractFinancialColumns([
      await fixture("china-southern-2025fy.txt"),
    ], {
      fiscalYear: 2025,
      presentation: "annual",
    });
    expect(extraction).toMatchObject({
      current: {
        "income.revenue": "182256",
        "income.netProfitParent": "857",
      },
      comparative: {
        "income.revenue": "174224",
        "income.netProfitParent": "-1696",
      },
      currentEvidence: {
        "income.revenue": { scale: "1000000" },
        "income.netProfitParent": { scale: "1000000" },
      },
    });
  });

  it("does not concatenate China Southern quarterly columns or the next row", async () => {
    const extraction = extractFinancialColumns([
      await fixture("china-southern-2025q1.txt"),
    ], {
      fiscalYear: 2025,
      fiscalQuarter: 1,
      presentation: "ytd",
    });
    expect(extraction).toMatchObject({
      current: {
        "income.revenue": "43407",
        "income.netProfitParent": "-747",
      },
      comparative: {
        "income.revenue": "44601",
        "income.netProfitParent": "756",
      },
      currentEvidence: {
        "income.netProfitParent": {
          scale: "1000000",
          rawSnippet: expect.not.stringContaining("少数股东损益"),
        },
      },
    });
  });

  it("extracts current and restated comparative columns from one filing", async () => {
    const text = await fixture("quarterly-comparative-600150-2026q1.txt");
    expect(extractFinancialColumns([text], {
      fiscalYear: 2026,
      fiscalQuarter: 1,
      presentation: "ytd",
    })).toMatchObject({
      current: {
        "income.revenue": "43312405150.04",
        "income.netProfitParent": "4832277995.78",
      },
      comparative: {
        "income.revenue": "27962098360.55",
        "income.netProfitParent": "1374209099.84",
      },
      currentEvidence: {
        "income.revenue": {
          pageNumber: 1,
        },
      },
    });
  });

  it("emits latest-filing comparative observations for requested prior YTD periods", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600150.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          const form = new URLSearchParams(String(init?.body));
          return new Response(
            form.get("seDate")?.startsWith("2026-") === true
              ? await fixture("quarterly-600150-2026q1.json")
              : JSON.stringify({
                  totalAnnouncement: 0,
                  totalRecordNum: 0,
                  announcements: [],
                }),
          );
        }
        if (url.hostname === "static.cninfo.com.cn") {
          expect(url.pathname).toBe(
            "/finalpage/2026-04-30/1225261166.PDF",
          );
          return new Response("%PDF-comparative-fixture");
        }
        return new Response("not found", { status: 404 });
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        await fixture("quarterly-comparative-600150-2026q1.txt"),
      ],
      retries: 0,
    });
    const concepts = [
      "income.revenue",
      "income.netProfitParent",
    ] as const;
    const batch = parseProviderBatch(provider, await provider.fetch({
      instrument: {
        instrumentId: "XSHG:600150",
        companyId: "company:XSHG:600150",
        exchangeMic: "XSHG",
        symbol: "600150",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: concepts.flatMap((conceptId) => [
        {
          conceptId,
          required: false,
          period: {
            fiscalYear: 2025,
            fiscalQuarter: 1 as const,
            presentation: "ytd" as const,
          },
        },
        {
          conceptId,
          required: false,
          period: {
            fiscalYear: 2026,
            fiscalQuarter: 1 as const,
            presentation: "ytd" as const,
          },
        },
      ]),
      asOf: "2026-07-29T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-29T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        concept: "income.revenue",
        value: "27962098360.55",
        period: expect.objectContaining({
          fiscalYear: 2025,
          fiscalQuarter: 1,
          presentation: "ytd",
        }),
        provenance: expect.objectContaining({
          documentId: "1225261166",
          rawField: "合并利润表.营业总收入.上年同期",
          transformations: expect.arrayContaining([
            expect.objectContaining({
              transformId: "latest-filing-comparative-period",
            }),
          ]),
        }),
      }),
      expect.objectContaining({
        concept: "income.netProfitParent",
        value: "1374209099.84",
        period: expect.objectContaining({
          fiscalYear: 2025,
          fiscalQuarter: 1,
          presentation: "ytd",
        }),
      }),
    ]));
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

  it("prefers the A-share full report over a later H-share announcement", async () => {
    const downloadedPaths: string[] = [];
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(JSON.stringify([{
            code: "600685",
            orgId: "gssh0600685",
            zwjc: "中船防务",
          }]));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(JSON.stringify({
            totalAnnouncement: 2,
            totalRecordNum: 2,
            announcements: [
              {
                secCode: "600685",
                secName: "中船防务",
                orgId: "gssh0600685",
                announcementId: "h-share-report",
                announcementTitle: "中船防务H股公告_2023年年度报告",
                announcementTime: Date.parse("2024-04-26T00:00:00+08:00"),
                adjunctUrl: "finalpage/2024-04-26/h-share-report.PDF",
                adjunctType: "PDF",
              },
              {
                secCode: "600685",
                secName: "中船防务",
                orgId: "gssh0600685",
                announcementId: "a-share-report",
                announcementTitle: "中船防务2023年年度报告",
                announcementTime: Date.parse("2024-03-28T00:00:00+08:00"),
                adjunctUrl: "finalpage/2024-03-28/a-share-report.PDF",
                adjunctType: "PDF",
              },
            ],
          }));
        }
        if (url.hostname === "static.cninfo.com.cn") {
          downloadedPaths.push(url.pathname);
          return new Response("%PDF-A-H-selection-fixture");
        }
        return new Response("not found", { status: 404 });
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        [
          "中船海洋与防务装备股份有限公司",
          "合并利润表",
          "2023 年度",
          "（除特别注明外，金额单位均为人民币元）",
          "项目 2023 年度 2022 年度",
          "一、营业总收入 16,145,951,496.09 12,795,124,917.87",
          "归属于母公司股东的净利润 48,067,553.44 688,459,748.15",
          "合并现金流量表",
        ].join("\n"),
      ],
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
      instrument: {
        instrumentId: "XSHG:600685",
        companyId: "company:XSHG:600685",
        exchangeMic: "XSHG",
        symbol: "600685",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: ["income.revenue", "income.netProfitParent"].map(
        (conceptId) => ({
          conceptId: conceptId as ProviderRequest["requirements"][number]["conceptId"],
          required: true,
          period: { fiscalYear: 2023, presentation: "annual" as const },
        }),
      ),
      asOf: "2024-08-30T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-08-01T09:00:00+08:00",
      snapshots,
    }));

    expect(downloadedPaths).toEqual([
      "/finalpage/2024-03-28/a-share-report.PDF",
    ]);
    expect(batch.issues).toEqual([]);
    expect(batch.observations.every((observation) =>
      observation.provenance.documentId === "a-share-report"
    )).toBe(true);
  });

  it("persists OCR text and links OCR-derived facts to that snapshot", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(await fixture("annual-600519-2025.json"));
        }
        return new Response("%PDF-ocr-fixture");
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => ({
        pages: [await fixture("annual-600519-2025.txt")],
        ocr: {
          engine: "tesseract.js",
          version: "7.0.0",
          language: "chi_sim",
          pageNumbers: [1],
        },
      }),
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["json", "json", "pdf", "text"]);
    const ocrSnapshot = batch.rawSnapshots.at(-1)!;
    expect(batch.observations).not.toHaveLength(0);
    expect(batch.observations.every((observation) =>
      observation.provenance.rawSnapshotId === ocrSnapshot.snapshotId
      && observation.provenance.sourceUrl.endsWith("#ocr-text")
      && observation.provenance.transformations.some((step) =>
        step.transformId === "tesseract-ocr"
      )
      && observation.provenance.transformations.some((step) =>
        step.transformId === "ocr-spatial-line-reconstruction"
      )
    )).toBe(true);
  });

  it("reports an unusable OCR text layer separately from a missing statement", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(await fixture("annual-600519-2025.json"));
        }
        return new Response("%PDF-unusable-ocr-fixture");
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => ({
        pages: ["会 证 0 表\n本 期 致 上 年 同 朝 数\n7,757,496,967"],
        ocr: {
          engine: "tesseract.js",
          version: "7.0.0",
          language: "chi_sim",
          pageNumbers: [1],
        },
      }),
      retries: 0,
    });
    const batch = await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-08-01T09:00:00+08:00",
      snapshots,
    });

    expect(batch.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "PARSE_FAILED",
        reasonCode: "OCR_TEXT_UNUSABLE",
        requirements: [expect.objectContaining({
          conceptId: "income.revenue",
        })],
      }),
    ]));
  });

  it("preserves a typed statement diagnostic when the main table is absent", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(await fixture("annual-600519-2025.json"));
        }
        return new Response("%PDF-image-only-fixture");
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        "贵州茅台酒股份有限公司 2025 年年度报告\n财务报表附注",
      ],
      retries: 0,
    });
    const batch = await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    });

    expect(batch.unmapped).not.toHaveLength(0);
    expect(batch.unmapped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        intendedConceptId: "income.revenue",
        reasonCode: "UNMAPPED_SOURCE_FIELD",
      }),
    ]));
    expect(batch.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "PARSE_FAILED",
        reasonCode: "STATEMENT_NOT_FOUND",
        requirements: [expect.objectContaining({
          conceptId: "income.revenue",
        })],
      }),
    ]));
    expect(parseProviderBatch(provider, batch)).toEqual(batch);
  });

  it("preserves an image-only diagnostic instead of treating the report as absent", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/hisAnnouncement/query")) {
          return new Response(await fixture("annual-600519-2025.json"));
        }
        return new Response("%PDF-image-only-fixture");
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      extractTextImplementation: async () => [
        "贵州茅台酒股份有限公司 2025 年年度报告",
        "第九节 备查文件目录",
        "",
        "",
        "",
        "",
        "贵州茅台酒股份有限公司\n2025 年度财务报表附注",
      ],
      retries: 0,
    });
    const batch = await provider.fetch(request, {
      signal: new AbortController().signal,
      now: "2026-07-28T10:00:00+08:00",
      snapshots,
    });

    expect(batch.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "PARSE_FAILED",
        reasonCode: "STATEMENT_IMAGE_ONLY",
        requirements: [expect.objectContaining({
          conceptId: "income.revenue",
        })],
      }),
    ]));
    expect(parseProviderBatch(provider, batch)).toEqual(batch);
  });

  it("aggregates implemented official dividends and excludes ambiguous records", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/information/topSearch/query")) {
          return new Response(await fixture("search-600519.json"));
        }
        if (url.pathname.endsWith("/api/sysapi/p_sysapi1139")) {
          expect(init?.method).toBe("POST");
          expect(url.searchParams.get("scode")).toBe("600519");
          const token = new Headers(init?.headers).get("Accept-Enckey");
          expect(token).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
          return new Response(await fixture("dividend-600519.json"));
        }
        return new Response("not found", { status: 404 });
      },
    );
    const provider = new CninfoProvider({
      fetchImplementation,
      webapiBase: "https://webapi.cninfo.example/",
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
      ...request,
      requirements: [{
        conceptId: "distribution.dividendPerShare",
        required: true,
        period: { fiscalYear: 2024, presentation: "annual" },
      }],
      asOf: "2025-06-21T23:59:59+08:00",
    }, {
      signal: new AbortController().signal,
      now: "2025-06-21T10:00:00+08:00",
      snapshots,
    }));

    expect(batch.company.legalName).toBe("贵州茅台");
    expect(batch.issues).toEqual([]);
    expect(batch.rawSnapshots.map((snapshot) => snapshot.mediaType))
      .toEqual(["json", "json"]);
    expect(batch.observations).toEqual([
      expect.objectContaining({
        concept: "distribution.dividendPerShare",
        value: "515.55",
        unit: "CNY-per-share",
        scale: "0.1",
        period: {
          kind: "duration",
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          fiscalYear: 2024,
          presentation: "annual",
        },
        availability: expect.objectContaining({
          filingDate: "2025-06-20",
          publishedAt: "2025-06-20T23:59:59+08:00",
        }),
        provenance: expect.objectContaining({
          sourceType: "official",
          extractionMethod: "api",
          rawField: "records[].F012N",
          transformations: expect.arrayContaining([
            expect.objectContaining({ transformId: "per-ten-shares" }),
            expect.objectContaining({
              transformId: "aggregate-annual-cash-dividends",
              detail:
                "Sum 2 implemented cash distribution(s) assigned to fiscal year 2024",
            }),
          ]),
        }),
      }),
    ]);
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
    expect(batch.issues[0]).toMatchObject({
      code: "EMPTY_RESPONSE",
      reasonCode: "REPORT_NOT_AVAILABLE_AS_OF",
      requirements: expect.arrayContaining([
        expect.objectContaining({
          conceptId: "income.revenue",
          period: { fiscalYear: 2025, presentation: "annual" },
        }),
      ]),
    });
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
