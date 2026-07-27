import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderFailure,
  type ProviderBatch,
  type ProviderContext,
  type ProviderRequest,
  type SourceProvider,
} from "@verified-financial/provider-contract";
import type { FactRequest } from "@verified-financial/schema";
import {
  ContentAddressedSnapshotStore,
  MetadataStore,
} from "@verified-financial/storage";
import { afterEach, describe, expect, it } from "vitest";
import { FinancialGateway } from "./gateway.js";

interface FixtureProviderOptions {
  providerId: string;
  upstreamSourceId?: string;
  value?: string;
  publishedAt?: string;
  fail?: boolean;
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
      now: () => "2026-07-27T10:00:00+08:00",
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
