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

const PROVIDER_ID = "tencent-direct";
const UPSTREAM_SOURCE_ID = "tencent";
const MAPPING_VERSION = "tencent@1.0.0";
const QUOTE_ENDPOINT = "https://qt.gtimg.cn/q=";

export interface TencentProviderOptions {
  fetchImplementation?: FetchImplementation;
  retries?: number;
  timeoutMs?: number;
  quoteEndpoint?: string;
}

export const TENCENT_FIELD_MAPPINGS: readonly SourceFieldMapping[] = [
  {
    upstreamSchema: "qt.quote",
    rawField: "3",
    conceptId: "market.price.close",
    unit: "currency",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "qt.quote",
    rawField: "39",
    conceptId: "valuation.peTtm",
    unit: "ratio",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "qt.quote",
    rawField: "45",
    conceptId: "market.cap",
    unit: "currency",
    scale: "100000000",
    transformIds: ["yi-currency-scale"],
  },
  {
    upstreamSchema: "qt.quote.a-share",
    rawField: "46",
    conceptId: "valuation.pb",
    unit: "ratio",
    scale: "1",
    transformIds: [],
  },
];

const fieldByConcept = new Map<ConceptId, {
  index: number;
  scale: string;
  aShareOnly?: boolean;
}>([
  ["market.price.close", { index: 3, scale: "1" }],
  ["valuation.peTtm", { index: 39, scale: "1" }],
  ["market.cap", { index: 45, scale: "100000000" }],
  ["valuation.pb", { index: 46, scale: "1", aShareOnly: true }],
]);

function stableId(value: unknown): string {
  return `obs:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function quoteSymbol(instrumentId: string): string {
  const [exchangeMic, symbol] = instrumentId.split(":");
  switch (exchangeMic) {
    case "XSHG":
      return `sh${symbol}`;
    case "XSHE":
      return `sz${symbol}`;
    case "XBSE":
      return `bj${symbol}`;
    case "XHKG":
      return `hk${symbol}`;
    default:
      throw new Error(`UNSUPPORTED_INSTRUMENT:${instrumentId}`);
  }
}

function parseTimestamp(raw: string): {
  publishedAt: string;
  date: string;
} {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 14) throw new Error("Tencent update time is missing");
  const date =
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const time =
    `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
  return { date, publishedAt: `${date}T${time}+08:00` };
}

function quotePeriod(date: string, concept: ConceptId): ReportingPeriod {
  return {
    kind: "instant",
    endDate: date,
    fiscalYear: Number(date.slice(0, 4)),
    presentation: concept === "valuation.peTtm" ? "ttm" : "annual",
  };
}

function parseFields(bytes: Uint8Array): string[] {
  const text = new TextDecoder("gb18030").decode(bytes);
  const match = /="([^"]*)"/.exec(text);
  if (match?.[1] === undefined) {
    throw new Error("Tencent quote payload is malformed");
  }
  return match[1].split("~");
}

function exactDecimal(value: string | undefined): string | undefined {
  return value !== undefined
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
      && value !== "0"
    ? value
    : undefined;
}

export class TencentProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["market", "valuation"] as const;

  constructor(private readonly options: TencentProviderOptions = {}) {}

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
        message: "Offline mode does not access Tencent",
        retryable: false,
      });
    } else if (
      request.requirements.some((requirement) =>
        fieldByConcept.has(requirement.conceptId)
      )
    ) {
      const sourceUrl = `${
        this.options.quoteEndpoint ?? QUOTE_ENDPOINT
      }${quoteSymbol(request.instrument.instrumentId)}`;
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
            Accept: "text/plain,*/*",
            Referer: "https://gu.qq.com/",
            "User-Agent": "verified-financial-core/0.1",
          },
        });
        const snapshot = await context.snapshots.put({
          providerId: this.providerId,
          sourceUrl,
          mediaType: "text",
          fetchedAt: context.now,
          body: bytes,
        });
        rawSnapshots.push(snapshot);
        const fields = parseFields(bytes);
        legalName = fields[1] || legalName;
        const timestamp = parseTimestamp(fields[30] ?? "");
        const requestedConcepts = new Set(
          request.requirements.map((item) => item.conceptId),
        );
        for (const [concept, mapping] of fieldByConcept) {
          if (!requestedConcepts.has(concept)) continue;
          if (
            mapping.aShareOnly === true
            && request.instrument.exchangeMic === "XHKG"
          ) {
            continue;
          }
          const value = exactDecimal(fields[mapping.index]);
          if (value === undefined) continue;
          const period = quotePeriod(timestamp.date, concept);
          const unit = concept === "market.price.close"
              || concept === "market.cap"
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
            scale: mapping.scale,
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
              rawField: String(mapping.index),
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: mapping.scale === "1"
                ? []
                : [{
                    transformId: "yi-currency-scale",
                    version: "1.0.0",
                    detail: "Tencent reports market cap in 100 million currency units",
                  }],
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
                : "Failed to parse Tencent quote",
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
