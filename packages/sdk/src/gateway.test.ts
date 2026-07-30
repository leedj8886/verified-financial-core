import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderFailure,
  type ProviderBatch,
  type ProviderCapability,
  type ProviderContext,
  type ProviderRequest,
  type SourceProvider,
} from "@verified-financial/provider-contract";
import type {
  AccountingBasis,
  ConceptId,
  FactRequest,
  ReportingPeriod,
} from "@verified-financial/schema";
import {
  ContentAddressedSnapshotStore,
  MetadataStore,
} from "@verified-financial/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FinancialGateway,
  defaultMaxAgeSeconds,
} from "./gateway.js";

interface FixtureProviderOptions {
  providerId: string;
  upstreamSourceId?: string;
  value?: string;
  publishedAt?: string;
  fail?: boolean;
}

interface DerivationRecord {
  concept: ConceptId;
  value: string;
  unit: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
  instrumentScoped?: boolean;
  publishedAt?: string;
}

function makeDerivationProvider(options: {
  providerId: string;
  capabilities: ProviderCapability[];
  records: DerivationRecord[];
  sourceType?: "official" | "first-party" | "aggregator";
}): {
  provider: SourceProvider;
  fetch: ReturnType<typeof vi.fn<SourceProvider["fetch"]>>;
} {
  const fetch = vi.fn<SourceProvider["fetch"]>(async (
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch> => {
    const sourceUrl = `https://example.invalid/${options.providerId}`;
    const snapshot = await context.snapshots.put({
      providerId: options.providerId,
      sourceUrl,
      mediaType: "json",
      fetchedAt: context.now,
      body: JSON.stringify({ records: options.records.length }),
    });
    const requested = options.records.filter((record) =>
      request.requirements.some((requirement) =>
        requirement.conceptId === record.concept
        && (
          requirement.period === undefined
          || (
            requirement.period.fiscalYear === record.period.fiscalYear
            && requirement.period.fiscalQuarter
              === record.period.fiscalQuarter
            && requirement.period.presentation === record.period.presentation
          )
        )
      )
    );
    return {
      providerId: options.providerId,
      upstreamSourceId: options.providerId,
      company: {
        companyId: request.instrument.companyId,
        legalName: "Derived Fixture Company",
        jurisdiction: "CN",
      },
      instruments: [request.instrument],
      observations: requested.map((record, index) => ({
        observationId: [
          "obs",
          options.providerId,
          record.concept,
          record.period.fiscalYear,
          record.period.fiscalQuarter ?? "fy",
          record.period.presentation,
          index,
        ].join(":"),
        companyId: request.instrument.companyId,
        ...(record.instrumentScoped === true
          ? { instrumentId: request.instrument.instrumentId }
          : {}),
        concept: record.concept,
        value: record.value,
        unit: record.unit,
        scale: "1",
        period: record.period,
        basis: record.basis,
        availability: {
          publishedAt: record.publishedAt
            ?? "2026-07-20T18:00:00+08:00",
          fetchedAt: context.now,
        },
        provenance: {
          providerId: options.providerId,
          upstreamSourceId: options.providerId,
          sourceType: options.sourceType ?? "aggregator",
          sourceUrl,
          rawSnapshotId: snapshot.snapshotId,
          rawField: record.concept,
          extractionMethod: "api",
          fetchedAt: context.now,
          transformations: [],
        },
      })),
      unmapped: [],
      rawSnapshots: [snapshot],
      mappingVersions: [`${options.providerId}@1`],
      issues: [],
    };
  });
  return {
    provider: {
      providerId: options.providerId,
      upstreamSourceId: options.providerId,
      capabilities: options.capabilities,
      fetch,
    },
    fetch,
  };
}

function makeProvider(options: FixtureProviderOptions): SourceProvider {
  const upstreamSourceId = options.upstreamSourceId ?? options.providerId;
  return {
    providerId: options.providerId,
    upstreamSourceId,
    capabilities: ["financials"],
    async fetch(
      request: ProviderRequest,
      context: ProviderContext,
    ): Promise<ProviderBatch> {
      if (options.fail === true) {
        throw new ProviderFailure({
          providerId: options.providerId,
          code: "TIMEOUT",
          message: "Fixture timeout",
          retryable: true,
        });
      }
      const sourceUrl = `https://example.invalid/${options.providerId}`;
      const snapshot = await context.snapshots.put({
        providerId: options.providerId,
        sourceUrl,
        mediaType: "json",
        fetchedAt: context.now,
        body: JSON.stringify({
          provider: options.providerId,
          value: options.value ?? "100",
        }),
      });
      return {
        providerId: options.providerId,
        upstreamSourceId,
        company: {
          companyId: request.instrument.companyId,
          legalName: "Fixture Company",
          jurisdiction: "CN",
        },
        instruments: [request.instrument],
        observations: [{
          observationId: `obs:${options.providerId}`,
          companyId: request.instrument.companyId,
          concept: "income.revenue",
          value: options.value ?? "100",
          unit: "CNY",
          scale: "1",
          period: {
            kind: "duration",
            startDate: "2025-01-01",
            endDate: "2025-12-31",
            fiscalYear: 2025,
            presentation: "annual",
          },
          basis: {
            standard: "CAS",
            scope: "consolidated",
            presentation: "reported",
            attribution: "parent",
            currency: "CNY",
          },
          availability: {
            publishedAt: options.publishedAt
              ?? "2026-03-20T18:00:00+08:00",
            fetchedAt: context.now,
          },
          provenance: {
            providerId: options.providerId,
            upstreamSourceId,
            sourceType: "aggregator",
            sourceUrl,
            rawSnapshotId: snapshot.snapshotId,
            rawField: "revenue",
            extractionMethod: "api",
            fetchedAt: context.now,
            transformations: [],
          },
        }],
        unmapped: [],
        rawSnapshots: [snapshot],
        mappingVersions: [`${options.providerId}@1`],
        issues: [],
      };
    },
  };
}

const request: FactRequest = {
  instrument: "600519.SH",
  requirements: [{
    conceptId: "income.revenue",
    required: true,
    period: { fiscalYear: 2025, presentation: "annual" },
  }],
  asOf: "2026-07-27T23:59:59+08:00",
};

const directories: string[] = [];
const openMetadata: MetadataStore[] = [];

async function makeGateway(
  providers: SourceProvider[],
  providerTimeoutMs = 30_000,
  now: () => string = () => "2026-07-27T10:00:00+08:00",
): Promise<{
  directory: string;
  gateway: FinancialGateway;
  metadata: MetadataStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "verified-gateway-"));
  directories.push(directory);
  const metadata = new MetadataStore(join(directory, "metadata.sqlite"));
  openMetadata.push(metadata);
  const snapshots = new ContentAddressedSnapshotStore(
    join(directory, "raw"),
    metadata,
  );
  return {
    directory,
    metadata,
    gateway: new FinancialGateway({
      providers,
      metadata,
      snapshots,
      now,
      providerTimeoutMs,
    }),
  };
}

afterEach(async () => {
  for (const metadata of openMetadata.splice(0)) {
    try {
      metadata.close();
    } catch {
      // A test may close the store before reopening it.
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("FinancialGateway", () => {
  it("uses shorter default freshness for market and valuation data", () => {
    expect(defaultMaxAgeSeconds([
      { conceptId: "income.revenue", required: true },
    ])).toBe(86_400);
    expect(defaultMaxAgeSeconds([
      { conceptId: "market.cap", required: true },
    ])).toBe(60);
  });

  it("routes requirements only to providers with matching capabilities", async () => {
    const marketFetch = vi.fn<SourceProvider["fetch"]>();
    const marketProvider: SourceProvider = {
      providerId: "market-only",
      upstreamSourceId: "market-only",
      capabilities: ["market"],
      fetch: marketFetch,
    };
    const { gateway } = await makeGateway([
      makeProvider({ providerId: "financial" }),
      marketProvider,
    ]);
    const factSet = await gateway.getFacts(request);
    expect(factSet.facts[0]?.concept).toBe("income.revenue");
    expect(marketFetch).not.toHaveBeenCalled();
    expect(factSet.reasonCodes).not.toContain(
      "PROVIDER_FAILURE:market-only:EMPTY_RESPONSE",
    );
  });

  it("does not route to a capable provider that rejects the instrument", async () => {
    const unsupportedFetch = vi.fn<SourceProvider["fetch"]>(async () => {
      throw new ProviderFailure({
        providerId: "hk-only",
        code: "UNSUPPORTED_INSTRUMENT",
        message: "HK-only provider received a mainland instrument",
        retryable: false,
      });
    });
    const unsupportedProvider = {
      providerId: "hk-only",
      upstreamSourceId: "hk-only",
      capabilities: ["financials"] as const,
      supportsInstrument: () => false,
      fetch: unsupportedFetch,
    };
    const { gateway } = await makeGateway([
      makeProvider({ providerId: "official", value: "100" }),
      makeProvider({ providerId: "aggregator", value: "100" }),
      unsupportedProvider,
    ]);

    const factSet = await gateway.getFacts(request);

    expect(unsupportedFetch).not.toHaveBeenCalled();
    expect(factSet.reasonCodes).not.toContain(
      "PROVIDER_FAILURE:hk-only:UNSUPPORTED_INSTRUMENT",
    );
    expect(factSet.summary.overallStatus).toBe("verified");
  });

  it("prefers company metadata from a provider that supplied observations", async () => {
    const emptyProvider: SourceProvider = {
      providerId: "empty-financial",
      upstreamSourceId: "empty-financial",
      capabilities: ["financials"],
      async fetch(providerRequest) {
        return {
          providerId: "empty-financial",
          upstreamSourceId: "empty-financial",
          company: {
            companyId: providerRequest.instrument.companyId,
            legalName: providerRequest.instrument.instrumentId,
            jurisdiction: "CN",
          },
          instruments: [providerRequest.instrument],
          observations: [],
          unmapped: [],
          rawSnapshots: [],
          mappingVersions: ["empty-financial@1"],
          issues: [],
        };
      },
    };
    const fixtureProvider = makeProvider({ providerId: "hk-official" });
    const hkProvider: SourceProvider = {
      ...fixtureProvider,
      async fetch(providerRequest, context) {
        const batch = await fixtureProvider.fetch(providerRequest, context);
        return {
          ...batch,
          company: {
            companyId: providerRequest.instrument.companyId,
            legalName: "TENCENT",
            jurisdiction: "HK",
          },
        };
      },
    };
    const { gateway } = await makeGateway([emptyProvider, hkProvider]);
    const factSet = await gateway.getFacts({
      ...request,
      instrument: "0700.HK",
    });
    expect(factSet.company).toEqual({
      companyId: "company:XHKG:00700",
      legalName: "TENCENT",
      jurisdiction: "HK",
    });
  });

  it("derives free cash flow from expanded dependencies and preserves lineage", async () => {
    const basis: AccountingBasis = {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
    };
    const period: ReportingPeriod = {
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    };
    const fixture = makeDerivationProvider({
      providerId: "financial-derived",
      capabilities: ["financials"],
      records: [
        {
          concept: "cashFlow.operatingCashFlow",
          value: "120",
          unit: "CNY",
          period,
          basis,
        },
        {
          concept: "cashFlow.capex",
          value: "35",
          unit: "CNY",
          period,
          basis,
        },
      ],
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "cashFlow.freeCashFlow",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    });
    expect(factSet.facts).toHaveLength(1);
    expect(factSet.facts[0]).toMatchObject({
      concept: "cashFlow.freeCashFlow",
      value: "85",
      derivation: { formulaId: "fcf.ocf-minus-capex.v1" },
    });
    const fetchedConcepts = fixture.fetch.mock.calls[0]?.[0].requirements
      .map((requirement) => requirement.conceptId);
    expect(fetchedConcepts).toEqual([
      "cashFlow.capex",
      "cashFlow.freeCashFlow",
      "cashFlow.operatingCashFlow",
    ]);
    expect(
      (await gateway.explainFact(factSet.facts[0]!.factId)).observations,
    ).toHaveLength(2);
  });

  it("derives annual ROE from profit and opening/closing equity", async () => {
    const basis: AccountingBasis = {
      standard: "IFRS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "all-shareholders",
      currency: "CNY",
    };
    const fixture = makeDerivationProvider({
      providerId: "roe-derived",
      capabilities: ["financials"],
      records: [
        {
          concept: "income.netProfit",
          value: "20",
          unit: "CNY",
          period: {
            kind: "duration",
            startDate: "2025-01-01",
            endDate: "2025-12-31",
            fiscalYear: 2025,
            presentation: "annual",
          },
          basis,
        },
        {
          concept: "balance.equity",
          value: "90",
          unit: "CNY",
          period: {
            kind: "instant",
            endDate: "2024-12-31",
            fiscalYear: 2024,
            presentation: "annual",
          },
          basis,
        },
        {
          concept: "balance.equity",
          value: "110",
          unit: "CNY",
          period: {
            kind: "instant",
            endDate: "2025-12-31",
            fiscalYear: 2025,
            presentation: "annual",
          },
          basis,
        },
      ],
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "profitability.roe",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    });

    expect(factSet.facts).toEqual([
      expect.objectContaining({
        concept: "profitability.roe",
        value: "0.2",
        unit: "ratio",
        derivation: expect.objectContaining({
          formulaId: "roe.average-equity.v1",
        }),
      }),
    ]);
    expect(fixture.fetch.mock.calls[0]?.[0].requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conceptId: "income.netProfit",
          period: { fiscalYear: 2025, presentation: "annual" },
        }),
        expect.objectContaining({
          conceptId: "balance.equity",
          period: { fiscalYear: 2024, presentation: "annual" },
        }),
        expect.objectContaining({
          conceptId: "balance.equity",
          period: { fiscalYear: 2025, presentation: "annual" },
        }),
      ]),
    );
  });

  it("derives an explicit-quarter TTM flow from YTD and annual facts", async () => {
    const basis: AccountingBasis = {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
    };
    const fixture = makeDerivationProvider({
      providerId: "ttm-derived",
      capabilities: ["financials"],
      records: [
        {
          concept: "income.revenue",
          value: "80",
          unit: "CNY",
          period: {
            kind: "duration",
            startDate: "2026-01-01",
            endDate: "2026-06-30",
            fiscalYear: 2026,
            fiscalQuarter: 2,
            presentation: "ytd",
          },
          basis,
        },
        {
          concept: "income.revenue",
          value: "100",
          unit: "CNY",
          period: {
            kind: "duration",
            startDate: "2025-01-01",
            endDate: "2025-12-31",
            fiscalYear: 2025,
            presentation: "annual",
          },
          basis,
        },
        {
          concept: "income.revenue",
          value: "70",
          unit: "CNY",
          period: {
            kind: "duration",
            startDate: "2025-01-01",
            endDate: "2025-06-30",
            fiscalYear: 2025,
            fiscalQuarter: 2,
            presentation: "ytd",
          },
          basis,
        },
      ],
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: {
          fiscalYear: 2026,
          fiscalQuarter: 2,
          presentation: "ttm",
        },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    });
    expect(factSet.facts).toHaveLength(1);
    expect(factSet.facts[0]).toMatchObject({
      concept: "income.revenue",
      value: "110",
      period: {
        startDate: "2025-07-01",
        endDate: "2026-06-30",
        fiscalYear: 2026,
        fiscalQuarter: 2,
        presentation: "ttm",
      },
      derivation: { formulaId: "ttm.flow.v1" },
    });
  });

  it("uses the latest filing's restated comparative period for TTM", async () => {
    const basis: AccountingBasis = {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
    };
    const currentPeriod: ReportingPeriod = {
      kind: "duration",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      fiscalYear: 2026,
      fiscalQuarter: 1,
      presentation: "ytd",
    };
    const annualPeriod: ReportingPeriod = {
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    };
    const comparativePeriod: ReportingPeriod = {
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-03-31",
      fiscalYear: 2025,
      fiscalQuarter: 1,
      presentation: "ytd",
    };
    const commonRecords: DerivationRecord[] = [
      {
        concept: "income.revenue",
        value: "43312405150.04",
        unit: "CNY",
        period: currentPeriod,
        basis,
      },
      {
        concept: "income.revenue",
        value: "151977991216.09",
        unit: "CNY",
        period: annualPeriod,
        basis,
      },
      {
        concept: "income.netProfitParent",
        value: "4832277995.78",
        unit: "CNY",
        period: currentPeriod,
        basis,
      },
      {
        concept: "income.netProfitParent",
        value: "7848378198.33",
        unit: "CNY",
        period: annualPeriod,
        basis,
      },
    ];
    const official = makeDerivationProvider({
      providerId: "cninfo",
      capabilities: ["financials"],
      sourceType: "official",
      records: [
        ...commonRecords,
        {
          concept: "income.revenue",
          value: "15857983133.24",
          unit: "CNY",
          period: comparativePeriod,
          basis,
          publishedAt: "2025-04-30T23:59:59+08:00",
        },
        {
          concept: "income.revenue",
          value: "27962098360.55",
          unit: "CNY",
          period: comparativePeriod,
          basis,
          publishedAt: "2026-04-30T23:59:59+08:00",
        },
        {
          concept: "income.netProfitParent",
          value: "1126903895.50",
          unit: "CNY",
          period: comparativePeriod,
          basis,
          publishedAt: "2025-04-30T23:59:59+08:00",
        },
        {
          concept: "income.netProfitParent",
          value: "1374209099.84",
          unit: "CNY",
          period: comparativePeriod,
          basis,
          publishedAt: "2026-04-30T23:59:59+08:00",
        },
      ],
    });
    const aggregator = makeDerivationProvider({
      providerId: "eastmoney",
      capabilities: ["financials"],
      records: [
        ...commonRecords,
        {
          concept: "income.revenue",
          value: "27962098360.55",
          unit: "CNY",
          period: comparativePeriod,
          basis,
          publishedAt: "2026-04-30T23:59:59+08:00",
        },
        {
          concept: "income.netProfitParent",
          value: "1374209099.84",
          unit: "CNY",
          period: comparativePeriod,
          basis,
          publishedAt: "2026-04-30T23:59:59+08:00",
        },
      ],
    });
    const { gateway } = await makeGateway([
      official.provider,
      aggregator.provider,
    ]);
    const factSet = await gateway.getFacts({
      instrument: "600150.SH",
      requirements: [
        "income.revenue",
        "income.netProfitParent",
      ].map((conceptId) => ({
        conceptId: conceptId as ConceptId,
        required: true,
        period: {
          fiscalYear: 2026,
          fiscalQuarter: 1 as const,
          presentation: "ttm" as const,
        },
      })),
      asOf: "2026-07-29T23:59:59+08:00",
    });

    expect(factSet.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        concept: "income.revenue",
        value: "167328298005.58",
        usable: true,
      }),
      expect.objectContaining({
        concept: "income.netProfitParent",
        value: "11306447094.27",
        usable: true,
      }),
    ]));
    expect(factSet.summary.overallStatus).toBe("verified");
  });

  it("composes TTM flow derivations before deriving free cash flow", async () => {
    const basis: AccountingBasis = {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
    };
    const periods: ReportingPeriod[] = [
      {
        kind: "duration",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        fiscalYear: 2026,
        fiscalQuarter: 2,
        presentation: "ytd",
      },
      {
        kind: "duration",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        fiscalYear: 2025,
        presentation: "annual",
      },
      {
        kind: "duration",
        startDate: "2025-01-01",
        endDate: "2025-06-30",
        fiscalYear: 2025,
        fiscalQuarter: 2,
        presentation: "ytd",
      },
    ];
    const series: Array<{ concept: ConceptId; values: string[] }> = [
      {
        concept: "cashFlow.operatingCashFlow",
        values: ["80", "100", "70"],
      },
      {
        concept: "cashFlow.capex",
        values: ["30", "40", "20"],
      },
    ];
    const fixture = makeDerivationProvider({
      providerId: "fcf-ttm-derived",
      capabilities: ["financials"],
      records: series.flatMap(({ concept, values }) =>
        periods.map((period, index) => ({
          concept,
          value: values[index]!,
          unit: "CNY",
          period,
          basis,
        }))
      ),
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "cashFlow.freeCashFlow",
        required: true,
        period: {
          fiscalYear: 2026,
          fiscalQuarter: 2,
          presentation: "ttm",
        },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    });
    expect(factSet.facts[0]).toMatchObject({
      concept: "cashFlow.freeCashFlow",
      value: "60",
      derivation: {
        formulaId: "fcf.ocf-minus-capex.v1",
      },
    });
    const explanation = await gateway.explainFact(factSet.facts[0]!.factId);
    expect(explanation.observations).toHaveLength(6);
    expect(explanation.inputs).toHaveLength(2);
    for (const ttmInput of explanation.inputs) {
      expect(ttmInput.inputs).toHaveLength(3);
      for (const input of ttmInput.inputs) {
        expect(await gateway.explainFact(input.fact.factId)).toMatchObject({
          fact: { factId: input.fact.factId },
        });
      }
    }
  });

  it("reports the exact missing TTM input period", async () => {
    const basis: AccountingBasis = {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
    };
    const fixture = makeDerivationProvider({
      providerId: "ttm-one-period-missing",
      capabilities: ["financials"],
      records: [
        {
          concept: "income.revenue",
          value: "80",
          unit: "CNY",
          period: {
            kind: "duration",
            startDate: "2024-01-01",
            endDate: "2024-06-30",
            fiscalYear: 2024,
            fiscalQuarter: 2,
            presentation: "ytd",
          },
          basis,
        },
        {
          concept: "income.revenue",
          value: "100",
          unit: "CNY",
          period: {
            kind: "duration",
            startDate: "2023-01-01",
            endDate: "2023-12-31",
            fiscalYear: 2023,
            presentation: "annual",
          },
          basis,
        },
      ],
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: {
          fiscalYear: 2024,
          fiscalQuarter: 2,
          presentation: "ttm",
        },
      }],
      asOf: "2024-08-30T23:59:59+08:00",
    });

    expect(factSet.reasonCodes).toContain(
      "DERIVATION_INPUT_MISSING:income.revenue:2023-06-30:ytd",
    );
    expect(factSet.reasonCodes).toContain(
      "PROVIDER_INPUT_MISSING:ttm-one-period-missing:"
      + "income.revenue:2023-06-30:ytd:EMPTY_RESPONSE",
    );
  });

  it("derives market cap from price and shares and caches the result", async () => {
    const basis: AccountingBasis = {
      standard: "OTHER",
      scope: "standalone",
      presentation: "reported",
      attribution: "all-shareholders",
      currency: "CNY",
    };
    const period: ReportingPeriod = {
      kind: "instant",
      endDate: "2026-07-27",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      presentation: "quarter",
    };
    const fixture = makeDerivationProvider({
      providerId: "market-derived",
      capabilities: ["market"],
      records: [
        {
          concept: "market.price.close",
          value: "20",
          unit: "CNY",
          period,
          basis,
          instrumentScoped: true,
        },
        {
          concept: "market.shares.outstanding",
          value: "1000",
          unit: "shares",
          period,
          basis,
          instrumentScoped: true,
        },
      ],
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const marketRequest: FactRequest = {
      instrument: "600519.SH",
      requirements: [{
        conceptId: "market.cap",
        required: true,
        period: {
          fiscalYear: 2026,
          fiscalQuarter: 3,
          presentation: "quarter",
        },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    };
    const first = await gateway.getFacts(marketRequest);
    const second = await gateway.getFacts(marketRequest);
    expect(first.facts[0]).toMatchObject({
      concept: "market.cap",
      value: "20000",
      derivation: { formulaId: "market-cap.price-times-shares.v1" },
    });
    expect(second.factSetId).toBe(first.factSetId);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a TTM request has no explicit quarter", async () => {
    const fixture = makeDerivationProvider({
      providerId: "ttm-missing-quarter",
      capabilities: ["financials"],
      records: [],
    });
    const { gateway } = await makeGateway([fixture.provider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2026, presentation: "ttm" },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    });
    expect(factSet.facts).toEqual([]);
    expect(factSet.summary.overallStatus).toBe("failed");
    expect(factSet.reasonCodes).toContain(
      "DERIVATION_UNAVAILABLE:income.revenue",
    );
  });

  it("reuses a fresh cached FactSet without calling the provider", async () => {
    const delegate = makeProvider({ providerId: "cached" });
    const fetch = vi.fn(delegate.fetch.bind(delegate));
    const provider: SourceProvider = { ...delegate, fetch };
    const { gateway } = await makeGateway([provider]);
    const cachedRequest: FactRequest = {
      ...request,
      freshness: {
        maxAgeSeconds: 300,
        allowStaleOnProviderFailure: true,
      },
    };
    const first = await gateway.getFacts(cachedRequest);
    const second = await gateway.getFacts(cachedRequest);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.factSetId).toBe(first.factSetId);
  });

  it("refreshes cache age even when immutable facts keep the same ID", async () => {
    let currentNow = "2026-07-27T10:00:00+08:00";
    const delegate = makeProvider({ providerId: "stable" });
    const fetch = vi.fn(delegate.fetch.bind(delegate));
    const { gateway } = await makeGateway(
      [{ ...delegate, fetch }],
      30_000,
      () => currentNow,
    );
    const shortCacheRequest: FactRequest = {
      ...request,
      freshness: {
        maxAgeSeconds: 1,
        allowStaleOnProviderFailure: true,
      },
    };
    const first = await gateway.getFacts(shortCacheRequest);
    currentNow = "2026-07-27T10:00:02+08:00";
    const refreshed = await gateway.getFacts(shortCacheRequest);
    expect(refreshed.factSetId).toBe(first.factSetId);
    expect(fetch).toHaveBeenCalledTimes(2);

    currentNow = "2026-07-27T10:00:02.500+08:00";
    await gateway.getFacts(shortCacheRequest);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("replays cached facts offline and marks stale snapshots", async () => {
    let currentNow = "2026-07-27T10:00:00+08:00";
    const delegates = [
      makeProvider({ providerId: "alpha" }),
      makeProvider({ providerId: "beta", value: "100.5" }),
    ];
    const fetches = delegates.map((delegate) =>
      vi.fn(delegate.fetch.bind(delegate))
    );
    const providers = delegates.map((delegate, index): SourceProvider => ({
      ...delegate,
      fetch: fetches[index]!,
    }));
    const { gateway } = await makeGateway(
      providers,
      30_000,
      () => currentNow,
    );
    await gateway.getFacts({
      ...request,
      freshness: {
        maxAgeSeconds: 0,
        allowStaleOnProviderFailure: true,
      },
    });
    currentNow = "2026-07-27T10:00:01+08:00";
    const replay = await gateway.getFacts({
      ...request,
      freshness: {
        maxAgeSeconds: 0,
        allowStaleOnProviderFailure: true,
        offline: true,
      },
    });
    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual([1, 1]);
    expect(replay.facts[0]?.status).toBe("verified");
    expect(replay.reasonCodes).toEqual([
      "OFFLINE_SNAPSHOT",
      "STALE_CACHE",
    ]);
    expect(replay.summary.overallStatus).toBe("warning");
    expect(await gateway.getFactSet(replay.factSetId)).toEqual(replay);
  });

  it("fails closed on an offline cache miss without invoking providers", async () => {
    const delegate = makeProvider({ providerId: "unused" });
    const fetch = vi.fn(delegate.fetch.bind(delegate));
    const { gateway } = await makeGateway([{ ...delegate, fetch }]);
    const factSet = await gateway.getFacts({
      ...request,
      freshness: {
        maxAgeSeconds: 0,
        allowStaleOnProviderFailure: true,
        offline: true,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(factSet.facts).toEqual([]);
    expect(factSet.reasonCodes).toEqual([
      "EMPTY_FACT_SET",
      "OFFLINE_SNAPSHOT",
    ]);
  });

  it("falls back to stale cache only when live providers cannot satisfy the request", async () => {
    let currentNow = "2026-07-27T10:00:00+08:00";
    const alphaOptions: FixtureProviderOptions = { providerId: "alpha" };
    const betaOptions: FixtureProviderOptions = {
      providerId: "beta",
      value: "100.5",
    };
    const { gateway } = await makeGateway(
      [makeProvider(alphaOptions), makeProvider(betaOptions)],
      30_000,
      () => currentNow,
    );
    const fallbackRequest: FactRequest = {
      ...request,
      freshness: {
        maxAgeSeconds: 1,
        allowStaleOnProviderFailure: true,
      },
    };
    await gateway.getFacts(fallbackRequest);
    alphaOptions.fail = true;
    betaOptions.fail = true;
    currentNow = "2026-07-27T10:00:10+08:00";
    const fallback = await gateway.getFacts(fallbackRequest);
    expect(fallback.facts[0]?.status).toBe("verified");
    expect(fallback.reasonCodes).toEqual([
      "PROVIDER_FAILURE:alpha:TIMEOUT",
      "PROVIDER_FAILURE:beta:TIMEOUT",
      "STALE_CACHE",
    ]);
    expect(fallback.summary.overallStatus).toBe("warning");

    const noFallback = await gateway.getFacts({
      ...fallbackRequest,
      freshness: {
        maxAgeSeconds: 1,
        allowStaleOnProviderFailure: false,
      },
    });
    expect(noFallback.facts).toEqual([]);
    expect(noFallback.summary.overallStatus).toBe("failed");
    expect(noFallback.reasonCodes).not.toContain("STALE_CACHE");
  });

  it("verifies independent providers and persists full explanation lineage", async () => {
    const { directory, gateway, metadata } = await makeGateway([
      makeProvider({ providerId: "alpha", value: "100" }),
      makeProvider({ providerId: "beta", value: "100.5" }),
    ]);
    const factSet = await gateway.getFacts(request);
    expect(factSet.summary.overallStatus).toBe("verified");
    expect(factSet.rawSnapshotIds).toHaveLength(2);
    const fact = factSet.facts[0]!;
    expect((await gateway.explainFact(fact.factId)).observations)
      .toHaveLength(2);

    metadata.close();
    const reopened = new MetadataStore(join(directory, "metadata.sqlite"));
    openMetadata.push(reopened);
    const persisted = reopened.getFactSet(factSet.factSetId);
    expect(persisted?.factSetId).toBe(factSet.factSetId);
    expect(reopened.explainFact(fact.factId)?.observations).toHaveLength(2);
  });

  it("does not count two wrappers over one upstream as independent", async () => {
    const { gateway } = await makeGateway([
      makeProvider({
        providerId: "wrapper-a",
        upstreamSourceId: "same-upstream",
      }),
      makeProvider({
        providerId: "wrapper-b",
        upstreamSourceId: "same-upstream",
      }),
    ]);
    expect((await gateway.getFacts(request)).facts[0]).toMatchObject({
      status: "warning",
      reasonCodes: ["SINGLE_INDEPENDENT_SOURCE"],
    });
  });

  it("preserves a provider failure without discarding verified facts", async () => {
    const { gateway } = await makeGateway([
      makeProvider({ providerId: "alpha" }),
      makeProvider({ providerId: "beta", value: "100.5" }),
      makeProvider({ providerId: "broken", fail: true }),
    ]);
    const factSet = await gateway.getFacts(request);
    expect(factSet.facts[0]?.status).toBe("verified");
    expect(factSet).toMatchObject({
      reasonCodes: ["PROVIDER_FAILURE:broken:TIMEOUT"],
      summary: { overallStatus: "warning" },
    });
  });

  it("filters future publications and fails closed when no fact remains", async () => {
    const { gateway } = await makeGateway([
      makeProvider({
        providerId: "future",
        publishedAt: "2026-08-01T10:00:00+08:00",
      }),
    ]);
    const factSet = await gateway.getFacts(request);
    expect(factSet.facts).toHaveLength(0);
    expect(factSet.reasonCodes).toEqual([
      "EMPTY_FACT_SET",
      "NOT_AVAILABLE_AS_OF:future",
    ]);
    expect(factSet.summary.overallStatus).toBe("failed");
  });

  it("returns a structured failed FactSet when every provider fails", async () => {
    const { gateway } = await makeGateway([
      makeProvider({ providerId: "broken", fail: true }),
    ]);
    const factSet = await gateway.getFacts(request);
    expect(factSet).toMatchObject({
      facts: [],
      reasonCodes: [
        "EMPTY_FACT_SET",
        "PROVIDER_FAILURE:broken:TIMEOUT",
      ],
      summary: { overallStatus: "failed" },
    });
  });

  it("enforces the Gateway timeout even when a provider ignores abort", async () => {
    const hangingProvider: SourceProvider = {
      providerId: "hanging",
      upstreamSourceId: "hanging",
      capabilities: ["financials"],
      async fetch() {
        return await new Promise<ProviderBatch>(() => undefined);
      },
    };
    const { gateway } = await makeGateway([hangingProvider], 5);
    const factSet = await gateway.getFacts(request);
    expect(factSet.reasonCodes).toEqual([
      "EMPTY_FACT_SET",
      "PROVIDER_FAILURE:hanging:TIMEOUT",
    ]);
  });

  it("rejects an observation from the wrong A/H share class", async () => {
    const wrongShareProvider: SourceProvider = {
      providerId: "wrong-share",
      upstreamSourceId: "wrong-share",
      capabilities: ["market"],
      async fetch(providerRequest, context) {
        const sourceUrl = "https://example.invalid/wrong-share";
        const snapshot = await context.snapshots.put({
          providerId: "wrong-share",
          sourceUrl,
          mediaType: "json",
          fetchedAt: context.now,
          body: "{\"price\":\"300\"}",
        });
        const hShare = {
          instrumentId: "XHKG:00700",
          companyId: providerRequest.instrument.companyId,
          exchangeMic: "XHKG" as const,
          symbol: "00700",
          shareClass: "H" as const,
          tradingCurrency: "HKD" as const,
        };
        return {
          providerId: "wrong-share",
          upstreamSourceId: "wrong-share",
          company: {
            companyId: providerRequest.instrument.companyId,
            legalName: "Fixture Dual-listed Company",
            jurisdiction: "CN",
          },
          instruments: [providerRequest.instrument, hShare],
          observations: [{
            observationId: "obs:wrong-share",
            companyId: providerRequest.instrument.companyId,
            instrumentId: hShare.instrumentId,
            concept: "market.price.close",
            value: "300",
            unit: "HKD",
            scale: "1",
            period: {
              kind: "instant",
              endDate: "2025-12-31",
              fiscalYear: 2025,
              presentation: "annual",
            },
            basis: {
              standard: "IFRS",
              scope: "consolidated",
              presentation: "reported",
              attribution: "all-shareholders",
              currency: "HKD",
            },
            availability: {
              publishedAt: "2026-03-20T18:00:00+08:00",
              fetchedAt: context.now,
            },
            provenance: {
              providerId: "wrong-share",
              upstreamSourceId: "wrong-share",
              sourceType: "aggregator",
              sourceUrl,
              rawSnapshotId: snapshot.snapshotId,
              rawField: "price",
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: [],
            },
          }],
          unmapped: [],
          rawSnapshots: [snapshot],
          mappingVersions: ["wrong-share@1"],
          issues: [],
        };
      },
    };
    const { gateway } = await makeGateway([wrongShareProvider]);
    const factSet = await gateway.getFacts({
      instrument: "600519.SH",
      requirements: [{
        conceptId: "market.price.close",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
      asOf: "2026-07-27T23:59:59+08:00",
    });
    expect(factSet.facts).toEqual([]);
    expect(factSet.reasonCodes).toEqual([
      "EMPTY_FACT_SET",
      "INSTRUMENT_SCOPE_MISMATCH:wrong-share",
    ]);
  });
});
