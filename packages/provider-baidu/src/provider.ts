import { createHash } from "node:crypto";
import {
  ProviderFailure,
  fetchBytes,
  type FetchImplementation,
  type ProviderBatch,
  type ProviderContext,
  type ProviderIssue,
  type ProviderRequest,
  type SourceFieldMapping,
  type SourceProvider,
} from "@verified-financial/provider-contract";
import {
  ObservationSchema,
  type ConceptId,
  type Observation,
  type ReportingPeriod,
} from "@verified-financial/schema";

const PROVIDER_ID = "baidu-direct";
const UPSTREAM_SOURCE_ID = "baidu";
const MAPPING_VERSION = "baidu@1.0.0";
const QUOTE_ENDPOINT = "https://gushitong.baidu.com/opendata";

type JsonObject = Record<string, unknown>;

export interface BaiduProviderOptions {
  fetchImplementation?: FetchImplementation;
  retries?: number;
  timeoutMs?: number;
  quoteEndpoint?: string;
}

export const BAIDU_FIELD_MAPPINGS: readonly SourceFieldMapping[] = [
  {
    upstreamSchema: "minute_data.pankouinfos.origin_pankou",
    rawField: "currentPrice",
    conceptId: "market.price.close",
    unit: "currency",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "minute_data.pankouinfos.origin_pankou",
    rawField: "capitalization",
    conceptId: "market.cap",
    unit: "currency",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "minute_data.pankouinfos.origin_pankou",
    rawField: "totalShareCapital",
    conceptId: "market.shares.outstanding",
    unit: "shares",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "minute_data.pankouinfos.origin_pankou",
    rawField: "peratio",
    conceptId: "valuation.peTtm",
    unit: "ratio",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "minute_data.pankouinfos.origin_pankou",
    rawField: "bvRatio",
    conceptId: "valuation.pb",
    unit: "ratio",
    scale: "1",
    transformIds: [],
  },
];

const rawFieldByConcept = new Map<ConceptId, string>([
  ["market.price.close", "currentPrice"],
  ["market.cap", "capitalization"],
  ["market.shares.outstanding", "totalShareCapital"],
  ["valuation.peTtm", "peratio"],
  ["valuation.pb", "bvRatio"],
]);

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function findQuote(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findQuote(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = asObject(value);
  if (object === undefined) return undefined;
  if (asObject(object["minute_data"]) !== undefined) return object;
  for (const child of Object.values(object)) {
    const found = findQuote(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function exactDecimal(value: unknown): string | undefined {
  return typeof value === "string"
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
      && value !== "0"
    ? value
    : undefined;
}

function stableId(value: unknown): string {
  return `obs:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function quoteTime(raw: unknown): {
  date: string;
  publishedAt: string;
} {
  const seconds = exactDecimal(raw);
  if (seconds === undefined) throw new Error("Baidu update time is missing");
  const instant = new Date(Number(seconds) * 1000);
  if (Number.isNaN(instant.valueOf())) {
    throw new Error("Baidu update time is invalid");
  }
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return { date, publishedAt: instant.toISOString() };
}

function quotePeriod(date: string, concept: ConceptId): ReportingPeriod {
  return {
    kind: "instant",
    endDate: date,
    fiscalYear: Number(date.slice(0, 4)),
    presentation: concept === "valuation.peTtm" ? "ttm" : "annual",
  };
}

function quoteUrl(endpoint: string, symbol: string): string {
  const url = new URL(endpoint);
  const parameters = {
    openapi: "1",
    dspName: "iphone",
    tn: "tangram",
    client: "app",
    query: symbol,
    code: symbol,
    word: symbol,
    resource_id: "5429",
    ma_ver: "4",
    finClientType: "pc",
  };
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export class BaiduProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["market", "valuation"] as const;

  constructor(private readonly options: BaiduProviderOptions = {}) {}

  async fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch> {
    const observations: Observation[] = [];
    const rawSnapshots: ProviderBatch["rawSnapshots"] = [];
    const issues: ProviderIssue[] = [];
    let legalName = request.instrument.instrumentId;

    if (request.offline) {
      issues.push({
        providerId: this.providerId,
        code: "EMPTY_RESPONSE",
        message: "Offline mode does not access Baidu",
        retryable: false,
      });
    } else if (
      request.requirements.some((requirement) =>
        rawFieldByConcept.has(requirement.conceptId)
      )
    ) {
      const sourceUrl = quoteUrl(
        this.options.quoteEndpoint ?? QUOTE_ENDPOINT,
        request.instrument.symbol,
      );
      try {
        const bytes = await fetchBytes(sourceUrl, {
          providerId: this.providerId,
          signal: context.signal,
          ...(this.options.fetchImplementation === undefined
            ? {}
            : { fetchImplementation: this.options.fetchImplementation }),
          ...(this.options.retries === undefined
            ? {}
            : { retries: this.options.retries }),
          ...(this.options.timeoutMs === undefined
            ? {}
            : { timeoutMs: this.options.timeoutMs }),
          headers: {
            Accept: "application/json,text/plain,*/*",
            Referer: "https://gushitong.baidu.com/",
            "User-Agent": "verified-financial-core/0.1",
          },
        });
        const snapshot = await context.snapshots.put({
          providerId: this.providerId,
          sourceUrl,
          mediaType: "json",
          fetchedAt: context.now,
          body: bytes,
        });
        rawSnapshots.push(snapshot);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        const quote = findQuote(payload);
        if (quote === undefined) throw new Error("Baidu quote data is missing");
        legalName = typeof quote["name"] === "string"
          ? quote["name"]
          : legalName;
        const minuteData = asObject(quote["minute_data"]);
        const update = asObject(minuteData?.["update"]);
        const pankou = asObject(minuteData?.["pankouinfos"]);
        const origin = asObject(pankou?.["origin_pankou"]);
        if (origin === undefined) {
          throw new Error("Baidu origin_pankou data is missing");
        }
        const timestamp = quoteTime(update?.["time"]);
        const requestedConcepts = new Set(
          request.requirements.map((item) => item.conceptId),
        );
        for (const [concept, rawField] of rawFieldByConcept) {
          if (!requestedConcepts.has(concept)) continue;
          if (
            concept === "valuation.peTtm"
            && request.instrument.exchangeMic === "XHKG"
          ) {
            continue;
          }
          const value = exactDecimal(origin[rawField]);
          if (value === undefined) continue;
          const period = quotePeriod(timestamp.date, concept);
          const unit = concept === "market.shares.outstanding"
            ? "shares"
            : concept === "market.price.close" || concept === "market.cap"
              ? request.instrument.tradingCurrency
              : "ratio";
          observations.push(ObservationSchema.parse({
            observationId: stableId({
              snapshotId: snapshot.snapshotId,
              concept,
              period,
            }),
            companyId: request.instrument.companyId,
            instrumentId: request.instrument.instrumentId,
            concept,
            value,
            unit,
            scale: "1",
            period,
            basis: {
              standard: "OTHER",
              scope: "standalone",
              presentation: "reported",
              attribution: "all-shareholders",
              currency: request.instrument.tradingCurrency,
            },
            availability: {
              publishedAt: timestamp.publishedAt,
              sourceAsOf: timestamp.publishedAt,
              fetchedAt: context.now,
            },
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "aggregator",
              sourceUrl,
              rawSnapshotId: snapshot.snapshotId,
              rawField,
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: [],
            },
          }));
        }
      } catch (error) {
        issues.push(error instanceof ProviderFailure
          ? error.issue
          : {
              providerId: this.providerId,
              code: "PARSE_FAILED",
              message: error instanceof Error
                ? error.message
                : "Failed to parse Baidu quote",
              retryable: false,
            });
      }
    }

    return {
      providerId: this.providerId,
      upstreamSourceId: this.upstreamSourceId,
      company: {
        companyId: request.instrument.companyId,
        legalName,
        jurisdiction: request.instrument.exchangeMic === "XHKG" ? "HK" : "CN",
      },
      instruments: [request.instrument],
      observations,
      unmapped: [],
      rawSnapshots,
      mappingVersions: [MAPPING_VERSION],
      issues,
    };
  }
}
