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
  type StoredSnapshotRef,
} from "@verified-financial/provider-contract";
import {
  ObservationSchema,
  UnmappedObservationSchema,
  type ConceptId,
  type FactRequirement,
  type Observation,
  type ReportingPeriod,
  type UnmappedObservation,
} from "@verified-financial/schema";
import {
  isLosslessNumber,
  parse as parseLosslessJson,
} from "lossless-json";

const PROVIDER_ID = "eastmoney-direct";
const UPSTREAM_SOURCE_ID = "eastmoney";
const MAPPING_VERSION = "eastmoney@1.0.0";
const QUOTE_ENDPOINT = "https://push2.eastmoney.com/api/qt/stock/get";
const FINANCIAL_ENDPOINT =
  "https://datacenter-web.eastmoney.com/api/data/v1/get";

type JsonObject = Record<string, unknown>;

export interface EastmoneyProviderOptions {
  fetchImplementation?: FetchImplementation;
  retries?: number;
  timeoutMs?: number;
  quoteEndpoint?: string;
  financialEndpoint?: string;
}

interface FinancialQuery {
  reportName:
    | "RPT_DMSK_FN_INCOME"
    | "RPT_DMSK_FN_BALANCE"
    | "RPT_DMSK_FN_CASHFLOW";
  reportDate?: string;
  requirements: FactRequirement[];
}

interface FinancialField {
  rawField: string;
  concept: ConceptId;
  attribution?: "parent" | "all-shareholders";
}

const MARKET_CONCEPTS = new Set<ConceptId>([
  "market.price.close",
  "market.shares.outstanding",
  "market.cap",
  "valuation.peTtm",
  "valuation.pb",
]);

const financialFields: Record<FinancialQuery["reportName"], FinancialField[]> = {
  RPT_DMSK_FN_INCOME: [
    { rawField: "TOTAL_OPERATE_INCOME", concept: "income.revenue" },
    { rawField: "OPERATE_PROFIT", concept: "income.operatingProfit" },
    {
      rawField: "PARENT_NETPROFIT",
      concept: "income.netProfitParent",
      attribution: "parent",
    },
  ],
  RPT_DMSK_FN_BALANCE: [
    { rawField: "TOTAL_ASSETS", concept: "balance.assets" },
    { rawField: "TOTAL_LIABILITIES", concept: "balance.liabilities" },
    {
      rawField: "TOTAL_EQUITY",
      concept: "balance.equity",
      attribution: "all-shareholders",
    },
    { rawField: "MONETARYFUNDS", concept: "balance.cash" },
  ],
  RPT_DMSK_FN_CASHFLOW: [
    {
      rawField: "NETCASH_OPERATE",
      concept: "cashFlow.operatingCashFlow",
    },
    { rawField: "CONSTRUCT_LONG_ASSET", concept: "cashFlow.capex" },
  ],
};

export const EASTMONEY_FIELD_MAPPINGS: readonly SourceFieldMapping[] = [
  {
    upstreamSchema: "push2.quote",
    rawField: "f43",
    conceptId: "market.price.close",
    unit: "currency",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "push2.quote",
    rawField: "f84",
    conceptId: "market.shares.outstanding",
    unit: "shares",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "push2.quote",
    rawField: "f116",
    conceptId: "market.cap",
    unit: "currency",
    scale: "1",
    transformIds: [],
  },
  {
    upstreamSchema: "push2.quote",
    rawField: "f167",
    conceptId: "valuation.pb",
    unit: "ratio",
    scale: "1",
    transformIds: [],
  },
  ...Object.entries(financialFields).flatMap(([reportName, fields]) =>
    fields.map((field) => ({
      upstreamSchema: reportName,
      rawField: field.rawField,
      conceptId: field.concept,
      unit: "currency",
      scale: "1",
      transformIds: [],
    }))
  ),
];

function asObject(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function exactDecimal(value: unknown): string | undefined {
  if (isLosslessNumber(value)) return value.toString();
  if (
    typeof value === "string"
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function marketCode(instrumentId: string): string {
  const [exchangeMic, symbol] = instrumentId.split(":");
  switch (exchangeMic) {
    case "XSHG":
      return `1.${symbol}`;
    case "XSHE":
    case "XBSE":
      return `0.${symbol}`;
    case "XHKG":
      return `116.${symbol}`;
    default:
      throw new Error(`UNSUPPORTED_INSTRUMENT:${instrumentId}`);
  }
}

function marketDate(timestampSeconds: string): string {
  const date = new Date(Number(timestampSeconds) * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function quotePeriod(timestampSeconds: string): ReportingPeriod {
  const endDate = marketDate(timestampSeconds);
  return {
    kind: "instant",
    endDate,
    fiscalYear: Number(endDate.slice(0, 4)),
    presentation: "annual",
  };
}

function quoteBasis(currency: string) {
  return {
    standard: "OTHER" as const,
    scope: "standalone" as const,
    presentation: "reported" as const,
    attribution: "all-shareholders" as const,
    currency,
  };
}

function statementReportDate(
  requirement: FactRequirement,
): string | undefined {
  const period = requirement.period;
  if (period === undefined) return undefined;
  if (period.presentation === "quarter" || period.presentation === "ttm") {
    return undefined;
  }
  if (period.presentation === "annual") {
    return `${period.fiscalYear}-12-31`;
  }
  const monthDay = {
    1: "03-31",
    2: "06-30",
    3: "09-30",
    4: "12-31",
  }[period.fiscalQuarter!];
  return `${period.fiscalYear}-${monthDay}`;
}

function statementPeriod(
  rawReportDate: string,
  requirement: FactRequirement,
  kind: "instant" | "duration",
): ReportingPeriod {
  const endDate = rawReportDate.slice(0, 10);
  const fiscalYear = Number(endDate.slice(0, 4));
  const month = endDate.slice(5, 7);
  const fiscalQuarter = {
    "03": 1,
    "06": 2,
    "09": 3,
  }[month] as 1 | 2 | 3 | undefined;
  const presentation = requirement.period?.presentation
    ?? (month === "12" ? "annual" : "ytd");
  return {
    kind,
    ...(kind === "duration" ? { startDate: `${fiscalYear}-01-01` } : {}),
    endDate,
    fiscalYear,
    ...(presentation === "quarter" || presentation === "ytd"
      ? { fiscalQuarter: requirement.period?.fiscalQuarter ?? fiscalQuarter }
      : {}),
    presentation,
  };
}

function noticeAvailability(noticeDate: string, fetchedAt: string) {
  const date = noticeDate.slice(0, 10);
  return {
    filingDate: date,
    publishedAt: `${date}T23:59:59+08:00`,
    fetchedAt,
  };
}

function financialReportForConcept(
  concept: ConceptId,
): FinancialQuery["reportName"] | undefined {
  return (
    Object.entries(financialFields) as [
      FinancialQuery["reportName"],
      FinancialField[],
    ][]
  ).find(([, fields]) => fields.some((field) => field.concept === concept))?.[0];
}

export class EastmoneyProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["market", "financials", "valuation"] as const;
  private readonly options: EastmoneyProviderOptions;

  constructor(options: EastmoneyProviderOptions = {}) {
    this.options = options;
  }

  private async request(
    url: string,
    context: ProviderContext,
  ): Promise<{ parsed: JsonObject; snapshot: StoredSnapshotRef }> {
    const bytes = await fetchBytes(url, {
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
        Referer: "https://data.eastmoney.com/",
        "User-Agent": "verified-financial-core/0.1",
      },
    });
    const snapshot = await context.snapshots.put({
      providerId: this.providerId,
      sourceUrl: url,
      mediaType: "json",
      fetchedAt: context.now,
      body: bytes,
    });
    const text = new TextDecoder().decode(bytes);
    return {
      parsed: asObject(
        parseLosslessJson(text),
        "Eastmoney response is not an object",
      ),
      snapshot,
    };
  }

  private quoteUrl(instrumentId: string): string {
    const url = new URL(this.options.quoteEndpoint ?? QUOTE_ENDPOINT);
    url.searchParams.set("secid", marketCode(instrumentId));
    url.searchParams.set(
      "fields",
      "f43,f57,f58,f84,f85,f86,f116,f117,f162,f167",
    );
    url.searchParams.set("fltt", "2");
    return url.toString();
  }

  private quoteFallbackUrl(instrumentId: string): string | undefined {
    if (this.options.quoteEndpoint !== undefined) return undefined;
    const url = new URL(this.quoteUrl(instrumentId));
    url.hostname = "push2his.eastmoney.com";
    return url.toString();
  }

  private financialUrl(
    symbol: string,
    query: FinancialQuery,
  ): string {
    const url = new URL(this.options.financialEndpoint ?? FINANCIAL_ENDPOINT);
    url.searchParams.set("reportName", query.reportName);
    url.searchParams.set("columns", "ALL");
    const dateFilter = query.reportDate === undefined
      ? ""
      : `(REPORT_DATE='${query.reportDate}')`;
    url.searchParams.set(
      "filter",
      `(SECURITY_CODE="${symbol}")${dateFilter}`,
    );
    url.searchParams.set("sortColumns", "REPORT_DATE");
    url.searchParams.set("sortTypes", "-1");
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("pageNumber", "1");
    return url.toString();
  }

  async fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch> {
    const observations: Observation[] = [];
    const unmapped: UnmappedObservation[] = [];
    const rawSnapshots: ProviderBatch["rawSnapshots"] = [];
    const issues: ProviderIssue[] = [];
    let legalName = request.instrument.instrumentId;

    if (request.offline) {
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
        unmapped,
        rawSnapshots,
        mappingVersions: [MAPPING_VERSION],
        issues: [{
          providerId: this.providerId,
          code: "EMPTY_RESPONSE",
          message: "Offline mode does not access Eastmoney",
          retryable: false,
        }],
      };
    }

    const requestedConcepts = new Set(
      request.requirements.map((requirement) => requirement.conceptId),
    );
    if ([...requestedConcepts].some((concept) => MARKET_CONCEPTS.has(concept))) {
      try {
        let sourceUrl = this.quoteUrl(request.instrument.instrumentId);
        let response: Awaited<ReturnType<EastmoneyProvider["request"]>>;
        try {
          response = await this.request(sourceUrl, context);
        } catch (error) {
          const fallbackUrl = this.quoteFallbackUrl(
            request.instrument.instrumentId,
          );
          if (
            !(error instanceof ProviderFailure)
            || !error.issue.retryable
            || fallbackUrl === undefined
          ) {
            throw error;
          }
          sourceUrl = fallbackUrl;
          response = await this.request(sourceUrl, context);
        }
        const { parsed, snapshot } = response;
        const { snapshotId } = snapshot;
        const data = asObject(parsed["data"], "Eastmoney quote data is missing");
        const updateTime = exactDecimal(data["f86"]);
        if (updateTime === undefined) throw new Error("Eastmoney f86 is missing");
        legalName = asString(data["f58"]) ?? legalName;
        rawSnapshots.push(snapshot);
        const period = quotePeriod(updateTime);
        const publishedAt = new Date(Number(updateTime) * 1000).toISOString();
        const marketFields: [string, ConceptId, string][] = [
          ["f43", "market.price.close", request.instrument.tradingCurrency],
          ["f84", "market.shares.outstanding", "shares"],
          ["f116", "market.cap", request.instrument.tradingCurrency],
          ["f167", "valuation.pb", "ratio"],
        ];
        for (const [rawField, concept, unit] of marketFields) {
          if (!requestedConcepts.has(concept)) continue;
          const value = exactDecimal(data[rawField]);
          if (value === undefined) continue;
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              snapshotId,
              rawField,
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
            basis: quoteBasis(request.instrument.tradingCurrency),
            availability: {
              publishedAt,
              sourceAsOf: publishedAt,
              fetchedAt: context.now,
            },
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "aggregator",
              sourceUrl,
              rawSnapshotId: snapshotId,
              rawField,
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: [],
            },
          }));
        }
        if (requestedConcepts.has("valuation.peTtm")) {
          unmapped.push(UnmappedObservationSchema.parse({
            unmappedId: stableId("unmapped", {
              snapshotId,
              rawField: "f162",
            }),
            providerId: this.providerId,
            upstreamSourceId: this.upstreamSourceId,
            rawSnapshotId: snapshotId,
            rawField: "f162",
            rawValue: exactDecimal(data["f162"]),
            reasonCode: "UNMAPPED_SOURCE_FIELD",
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
                : "Failed to parse Eastmoney quote",
              retryable: false,
            });
      }
    }

    if (request.instrument.exchangeMic !== "XHKG") {
      const queries = new Map<string, FinancialQuery>();
      for (const requirement of request.requirements) {
        const reportName = financialReportForConcept(requirement.conceptId);
        if (reportName === undefined) continue;
        if (
          requirement.period?.presentation === "quarter"
          || requirement.period?.presentation === "ttm"
        ) {
          continue;
        }
        const reportDate = statementReportDate(requirement);
        const key = JSON.stringify({ reportName, reportDate });
        const existing = queries.get(key);
        if (existing !== undefined) {
          existing.requirements.push(requirement);
          continue;
        }
        const query: FinancialQuery = {
          reportName,
          ...(reportDate === undefined ? {} : { reportDate }),
          requirements: [requirement],
        };
        queries.set(key, query);
      }
      for (const query of queries.values()) {
        try {
          const sourceUrl = this.financialUrl(
            request.instrument.symbol,
            query,
          );
          const { parsed, snapshot } = await this.request(sourceUrl, context);
          const { snapshotId } = snapshot;
          const result = parsed["result"];
          if (result === null || result === undefined) {
            issues.push({
              providerId: this.providerId,
              code: "EMPTY_RESPONSE",
              message: asString(parsed["message"])
                ?? `No Eastmoney ${query.reportName} data`,
              retryable: false,
            });
            continue;
          }
          const rows = asObject(result, "Eastmoney result is invalid")["data"];
          if (!Array.isArray(rows) || rows.length === 0) {
            throw new Error("Eastmoney financial data is empty");
          }
          const row = asObject(rows[0], "Eastmoney financial row is invalid");
          const reportDate = asString(row["REPORT_DATE"]);
          const noticeDate = asString(row["NOTICE_DATE"]);
          if (reportDate === undefined || noticeDate === undefined) {
            throw new Error("Eastmoney report availability is missing");
          }
          legalName = asString(row["SECURITY_NAME_ABBR"]) ?? legalName;
          rawSnapshots.push(snapshot);
          for (const field of financialFields[query.reportName]) {
            const requirement = query.requirements.find(
              (item) => item.conceptId === field.concept,
            );
            if (requirement === undefined) continue;
            const value = exactDecimal(row[field.rawField]);
            if (value === undefined) continue;
            const definitionKind = query.reportName === "RPT_DMSK_FN_BALANCE"
              ? "instant"
              : "duration";
            const period = statementPeriod(
              reportDate,
              requirement,
              definitionKind,
            );
            observations.push(ObservationSchema.parse({
              observationId: stableId("obs", {
                providerId: this.providerId,
                snapshotId,
                rawField: field.rawField,
                concept: field.concept,
                period,
              }),
              companyId: request.instrument.companyId,
              concept: field.concept,
              value,
              unit: "CNY",
              scale: "1",
              period,
              basis: {
                standard: "CAS",
                scope: "consolidated",
                presentation: "reported",
                ...(field.attribution === undefined
                  ? {}
                  : { attribution: field.attribution }),
                currency: "CNY",
              },
              availability: noticeAvailability(noticeDate, context.now),
              provenance: {
                providerId: this.providerId,
                upstreamSourceId: this.upstreamSourceId,
                sourceType: "aggregator",
                sourceUrl,
                rawSnapshotId: snapshotId,
                rawField: field.rawField,
                extractionMethod: "api",
                fetchedAt: context.now,
                transformations: [{
                  transformId: "notice-date-end-of-day",
                  version: "1.0.0",
                  detail: "Treat NOTICE_DATE as available at end of day",
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
                  : "Failed to parse Eastmoney financials",
                retryable: false,
              });
        }
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
      unmapped,
      rawSnapshots,
      mappingVersions: [MAPPING_VERSION],
      issues,
    };
  }
}
