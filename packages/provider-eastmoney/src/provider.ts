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
import { Decimal } from "decimal.js";
import {
  isLosslessNumber,
  parse as parseLosslessJson,
} from "lossless-json";

const PROVIDER_ID = "eastmoney-direct";
const UPSTREAM_SOURCE_ID = "eastmoney";
const MAPPING_VERSION = "eastmoney@1.5.0";
const QUOTE_ENDPOINT = "https://push2.eastmoney.com/api/qt/stock/get";
const HISTORY_ENDPOINT =
  "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const FINANCIAL_ENDPOINT =
  "https://datacenter-web.eastmoney.com/api/data/v1/get";
const SECURITIES_ENDPOINT =
  "https://datacenter.eastmoney.com/securities/api/data/v1/get";

type JsonObject = Record<string, unknown>;

export interface EastmoneyProviderOptions {
  fetchImplementation?: FetchImplementation;
  retries?: number;
  timeoutMs?: number;
  quoteEndpoint?: string;
  historyEndpoint?: string;
  financialEndpoint?: string;
  securitiesEndpoint?: string;
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

function datePart(value: string): string {
  return value.slice(0, 10);
}

function financialReportingVersion(
  reportDateValue: string,
  noticeDateValue: string,
): {
  kind: "original-filing" | "later-comparative";
  sourcePeriodEndDate: string;
} {
  const reportDate = datePart(reportDateValue);
  const noticeDate = datePart(noticeDateValue);
  const reportYear = Number(reportDate.slice(0, 4));
  const noticeYear = Number(noticeDate.slice(0, 4));
  const monthDay = reportDate.slice(5);
  const originalNoticeYear = monthDay === "12-31"
    ? reportYear + 1
    : reportYear;
  if (noticeYear <= originalNoticeYear) {
    return {
      kind: "original-filing",
      sourcePeriodEndDate: reportDate,
    };
  }
  const sourceYear = monthDay === "12-31" ? noticeYear - 1 : noticeYear;
  return {
    kind: "later-comparative",
    sourcePeriodEndDate: `${sourceYear}-${monthDay}`,
  };
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
    upstreamSchema: "RPT_SHAREBONUS_DET",
    rawField: "PRETAX_BONUS_RMB[]",
    conceptId: "distribution.dividendPerShare",
    unit: "currency-per-share",
    scale: "0.1",
    transformIds: [
      "per-ten-shares",
      "aggregate-annual-cash-dividends",
      "notice-date-end-of-day",
    ],
  },
  {
    upstreamSchema: "RPT_HKF10_MAIN_DIVBASIC",
    rawField: "PLAN_EXPLAIN[]",
    conceptId: "distribution.dividendPerShare",
    unit: "currency-per-share",
    scale: "1",
    transformIds: [
      "parse-cash-dividend-per-share",
      "aggregate-annual-cash-dividends",
      "update-date-end-of-day",
    ],
  },
  {
    upstreamSchema: "push2his.daily-kline",
    rawField: "f53",
    conceptId: "market.price.close",
    unit: "currency",
    scale: "1",
    transformIds: ["unadjusted-daily-close", "conservative-market-close"],
  },
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

function historicalPeriod(
  date: string,
  selector: ProviderRequest["requirements"][number]["period"],
): ReportingPeriod {
  return {
    kind: "instant",
    endDate: date,
    fiscalYear: selector?.fiscalYear ?? Number(date.slice(0, 4)),
    ...(selector?.fiscalQuarter === undefined
      ? {}
      : { fiscalQuarter: selector.fiscalQuarter }),
    presentation: selector?.presentation ?? "annual",
  };
}

function historicalPublishedAt(
  date: string,
  exchangeMic: ProviderRequest["instrument"]["exchangeMic"],
): string {
  const time = exchangeMic === "XHKG" ? "16:30:00" : "15:30:00";
  return `${date}T${time}+08:00`;
}

function isHistoricalDate(asOf: string, now: string): boolean {
  return marketDate(String(Date.parse(asOf) / 1000))
    < marketDate(String(Date.parse(now) / 1000));
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

interface DailyClose {
  date: string;
  close: string;
}

function parseDailyCloses(value: unknown): DailyClose[] {
  const object = asObject(value, "Eastmoney history response is not an object");
  const data = asObject(
    object["data"],
    "Eastmoney history data is missing",
  );
  const klines = data["klines"];
  if (!Array.isArray(klines)) {
    throw new Error("Eastmoney history klines are missing");
  }
  return klines.flatMap((item) => {
    if (typeof item !== "string") return [];
    const fields = item.split(",");
    const date = fields[0];
    const close = exactDecimal(fields[2]);
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return close === undefined ? [] : [{ date, close }];
  });
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

function isoDate(value: string): string | undefined {
  const normalized = value.slice(0, 10).replaceAll("/", "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : undefined;
}

function dividendPeriod(fiscalYear: number): ReportingPeriod {
  return {
    kind: "duration",
    startDate: `${fiscalYear}-01-01`,
    endDate: `${fiscalYear}-12-31`,
    fiscalYear,
    presentation: "annual",
  };
}

interface DividendComponent {
  fiscalYear: number;
  currency: "CNY" | "HKD" | "USD";
  value: string;
  availableDate: string;
  identity: string;
}

interface AnnualDividend {
  fiscalYear: number;
  currency: DividendComponent["currency"];
  value: string;
  availableDate: string;
  identities: string[];
}

function parseHongKongCashDividend(
  plan: string,
): Pick<DividendComponent, "currency" | "value"> | undefined {
  const match = /^每股派(港币|港元|人民币|美元)([+-]?(?:\d+(?:\.\d*)?|\.\d+))元?$/
    .exec(plan.replaceAll(/\s+/g, ""));
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const currency = {
    "港币": "HKD",
    "港元": "HKD",
    "人民币": "CNY",
    "美元": "USD",
  }[match[1]] as DividendComponent["currency"] | undefined;
  return currency === undefined
    ? undefined
    : { currency, value: match[2] };
}

function aggregateAnnualDividends(
  components: readonly DividendComponent[],
): AnnualDividend[] {
  const unique = new Map<string, DividendComponent>();
  for (const component of components) {
    const existing = unique.get(component.identity);
    if (
      existing === undefined
      || component.availableDate > existing.availableDate
    ) {
      unique.set(component.identity, component);
    }
  }
  const groups = new Map<string, DividendComponent[]>();
  for (const component of unique.values()) {
    const key = `${component.fiscalYear}:${component.currency}`;
    const group = groups.get(key) ?? [];
    group.push(component);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    return {
      fiscalYear: first.fiscalYear,
      currency: first.currency,
      value: group.reduce(
        (total, component) => total.plus(component.value),
        new Decimal(0),
      ).toString(),
      availableDate: group
        .map((component) => component.availableDate)
        .sort()
        .at(-1)!,
      identities: group.map((component) => component.identity).sort(),
    };
  }).sort((left, right) =>
    right.fiscalYear - left.fiscalYear
    || left.currency.localeCompare(right.currency)
  );
}

function requestedDividendYears(
  requirements: readonly FactRequirement[],
): ReadonlySet<number> | undefined {
  const dividends = requirements.filter((requirement) =>
    requirement.conceptId === "distribution.dividendPerShare"
  );
  if (dividends.some((requirement) => requirement.period === undefined)) {
    return undefined;
  }
  return new Set(dividends.flatMap((requirement) =>
    requirement.period === undefined ? [] : [requirement.period.fiscalYear]
  ));
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
  readonly capabilities = [
    "market",
    "financials",
    "dividends",
    "valuation",
  ] as const;
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

  private historyUrl(instrumentId: string, asOf: string): string {
    const endDate = marketDate(String(Date.parse(asOf) / 1000));
    const url = new URL(this.options.historyEndpoint ?? HISTORY_ENDPOINT);
    url.searchParams.set("secid", marketCode(instrumentId));
    url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6");
    url.searchParams.set(
      "fields2",
      "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    );
    url.searchParams.set("klt", "101");
    url.searchParams.set("fqt", "0");
    url.searchParams.set("beg", shiftDate(endDate, -370).replaceAll("-", ""));
    url.searchParams.set("end", endDate.replaceAll("-", ""));
    url.searchParams.set("lmt", "400");
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

  private dividendUrl(
    instrument: ProviderRequest["instrument"],
  ): string {
    if (instrument.exchangeMic === "XHKG") {
      const url = new URL(
        this.options.securitiesEndpoint ?? SECURITIES_ENDPOINT,
      );
      url.searchParams.set("reportName", "RPT_HKF10_MAIN_DIVBASIC");
      url.searchParams.set(
        "columns",
        "SECURITY_CODE,UPDATE_DATE,NOTICE_DATE,REPORT_TYPE,"
          + "EX_DIVIDEND_DATE,DIVIDEND_DATE,TRANSFER_END_DATE,YEAR,"
          + "PLAN_EXPLAIN,IS_BFP",
      );
      url.searchParams.set(
        "filter",
        `(SECURITY_CODE="${instrument.symbol}")(IS_BFP="0")`,
      );
      url.searchParams.set("sortColumns", "NOTICE_DATE,EX_DIVIDEND_DATE");
      url.searchParams.set("sortTypes", "-1,-1");
      url.searchParams.set("pageSize", "200");
      url.searchParams.set("pageNumber", "1");
      url.searchParams.set("source", "F10");
      url.searchParams.set("client", "PC");
      return url.toString();
    }
    const url = new URL(this.options.financialEndpoint ?? FINANCIAL_ENDPOINT);
    url.searchParams.set("reportName", "RPT_SHAREBONUS_DET");
    url.searchParams.set("columns", "ALL");
    url.searchParams.set(
      "filter",
      `(SECURITY_CODE="${instrument.symbol}")`,
    );
    url.searchParams.set("sortColumns", "REPORT_DATE");
    url.searchParams.set("sortTypes", "-1");
    url.searchParams.set("pageSize", "500");
    url.searchParams.set("pageNumber", "1");
    url.searchParams.set("source", "WEB");
    url.searchParams.set("client", "WEB");
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
    const historicalClose = requestedConcepts.has("market.price.close")
      && isHistoricalDate(request.asOf, context.now);
    const historicalCloseSelector = request.requirements.find(
      (requirement) => requirement.conceptId === "market.price.close",
    )?.period;
    const needsCurrentQuote = [...requestedConcepts].some((concept) =>
      MARKET_CONCEPTS.has(concept)
      && !(concept === "market.price.close" && historicalClose)
    );
    if (needsCurrentQuote) {
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
          if (concept === "market.price.close" && historicalClose) continue;
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

    if (historicalClose) {
      const sourceUrl = this.historyUrl(
        request.instrument.instrumentId,
        request.asOf,
      );
      try {
        const { parsed, snapshot } = await this.request(sourceUrl, context);
        rawSnapshots.push(snapshot);
        const data = asObject(
          parsed["data"],
          "Eastmoney history data is missing",
        );
        legalName = asString(data["name"]) ?? legalName;
        const dailyClose = parseDailyCloses(parsed)
          .filter((item) =>
            Date.parse(historicalPublishedAt(
              item.date,
              request.instrument.exchangeMic,
            )) <= Date.parse(request.asOf)
          )
          .sort((left, right) => right.date.localeCompare(left.date))[0];
        if (dailyClose === undefined) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message:
              `Eastmoney has no unadjusted daily close available as of ${request.asOf}`,
            retryable: false,
          });
        }
        const publishedAt = historicalPublishedAt(
          dailyClose.date,
          request.instrument.exchangeMic,
        );
        const period = historicalPeriod(
          marketDate(String(Date.parse(request.asOf) / 1000)),
          historicalCloseSelector,
        );
        observations.push(ObservationSchema.parse({
          observationId: stableId("obs", {
            providerId: this.providerId,
            snapshotId: snapshot.snapshotId,
            rawField: "f53",
            concept: "market.price.close",
            period,
          }),
          companyId: request.instrument.companyId,
          instrumentId: request.instrument.instrumentId,
          concept: "market.price.close",
          value: dailyClose.close,
          unit: request.instrument.tradingCurrency,
          scale: "1",
          period,
          basis: quoteBasis(request.instrument.tradingCurrency),
          availability: {
            effectiveDate: dailyClose.date,
            publishedAt,
            sourceAsOf: publishedAt,
            fetchedAt: context.now,
          },
          provenance: {
            providerId: this.providerId,
            upstreamSourceId: this.upstreamSourceId,
            sourceType: "aggregator",
            sourceUrl,
            rawSnapshotId: snapshot.snapshotId,
            rawField: "f53",
            extractionMethod: "api",
            fetchedAt: context.now,
            transformations: [
              {
                transformId: "unadjusted-daily-close",
                version: "1.0.0",
                detail: "Request daily K-line data with fqt=0",
              },
              {
                transformId: "conservative-market-close",
                version: "1.0.0",
                detail:
                  request.instrument.exchangeMic === "XHKG"
                    ? "Treat the HK daily close as available at 16:30 +08:00"
                    : "Treat the mainland daily close as available at 15:30 +08:00",
              },
            ],
          },
        }));
      } catch (error) {
        issues.push(error instanceof ProviderFailure
          ? error.issue
          : {
              providerId: this.providerId,
              code: "PARSE_FAILED",
              message: error instanceof Error
                ? error.message
                : "Failed to parse Eastmoney history",
              retryable: false,
            });
      }
    }

    if (requestedConcepts.has("distribution.dividendPerShare")) {
      const sourceUrl = this.dividendUrl(request.instrument);
      try {
        const { parsed, snapshot } = await this.request(sourceUrl, context);
        const result = parsed["result"];
        if (result === null || result === undefined) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message: asString(parsed["message"])
              ?? "No Eastmoney dividend data",
            retryable: false,
          });
        }
        const rows = asObject(result, "Eastmoney dividend result is invalid")[
          "data"
        ];
        if (!Array.isArray(rows) || rows.length === 0) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message: "Eastmoney dividend data is empty",
            retryable: false,
          });
        }
        rawSnapshots.push(snapshot);
        const components = rows.flatMap((item): DividendComponent[] => {
          const row = asObject(item, "Eastmoney dividend row is invalid");
          if (request.instrument.exchangeMic === "XHKG") {
            const fiscalYear = Number(asString(row["YEAR"]));
            const plan = asString(row["PLAN_EXPLAIN"]);
            const availableDate = asString(row["UPDATE_DATE"]);
            const parsedPlan = plan === undefined
              ? undefined
              : parseHongKongCashDividend(plan);
            const isoAvailableDate = availableDate === undefined
              ? undefined
              : isoDate(availableDate);
            if (
              !Number.isInteger(fiscalYear)
              || parsedPlan === undefined
              || isoAvailableDate === undefined
            ) {
              return [];
            }
            return [{
              fiscalYear,
              currency: parsedPlan.currency,
              value: parsedPlan.value,
              availableDate: isoAvailableDate,
              identity: JSON.stringify({
                year: fiscalYear,
                plan,
                exDividendDate: asString(row["EX_DIVIDEND_DATE"]),
              }),
            }];
          }
          if (asString(row["ASSIGN_PROGRESS"]) !== "实施分配") return [];
          const reportDate = asString(row["REPORT_DATE"]);
          const noticeDate = asString(row["NOTICE_DATE"]);
          const value = exactDecimal(row["PRETAX_BONUS_RMB"]);
          const isoReportDate = reportDate === undefined
            ? undefined
            : isoDate(reportDate);
          const availableDate = noticeDate === undefined
            ? undefined
            : isoDate(noticeDate);
          if (
            isoReportDate === undefined
            || availableDate === undefined
            || value === undefined
          ) {
            return [];
          }
          legalName = asString(row["SECURITY_NAME_ABBR"]) ?? legalName;
          return [{
            fiscalYear: Number(isoReportDate.slice(0, 4)),
            currency: "CNY",
            value,
            availableDate,
            identity: JSON.stringify({
              reportDate: isoReportDate,
              value,
              exDividendDate: asString(row["EX_DIVIDEND_DATE"]),
            }),
          }];
        });
        const requestedYears = requestedDividendYears(request.requirements);
        const dividends = aggregateAnnualDividends(components).filter(
          (dividend) =>
            requestedYears === undefined
            || requestedYears.has(dividend.fiscalYear),
        );
        if (dividends.length === 0) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message:
              "Eastmoney has no implemented annual cash dividend for the request",
            retryable: false,
          });
        }
        for (const dividend of dividends) {
          const isHongKong = request.instrument.exchangeMic === "XHKG";
          const rawField = isHongKong
            ? "PLAN_EXPLAIN[]"
            : "PRETAX_BONUS_RMB[]";
          const period = dividendPeriod(dividend.fiscalYear);
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              snapshotId: snapshot.snapshotId,
              rawField,
              concept: "distribution.dividendPerShare",
              period,
              currency: dividend.currency,
              identities: dividend.identities,
            }),
            companyId: request.instrument.companyId,
            instrumentId: request.instrument.instrumentId,
            concept: "distribution.dividendPerShare",
            value: dividend.value,
            unit: `${dividend.currency}-per-share`,
            scale: isHongKong ? "1" : "0.1",
            period,
            basis: quoteBasis(dividend.currency),
            availability: noticeAvailability(
              dividend.availableDate,
              context.now,
            ),
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "aggregator",
              sourceUrl,
              rawSnapshotId: snapshot.snapshotId,
              rawField,
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: [
                ...(isHongKong
                  ? [{
                      transformId: "parse-cash-dividend-per-share",
                      version: "1.0.0",
                      detail:
                        "Parse explicit per-share cash amounts and currencies from PLAN_EXPLAIN",
                    }]
                  : [{
                      transformId: "per-ten-shares",
                      version: "1.0.0",
                      detail:
                        "Scale PRETAX_BONUS_RMB from cash per 10 shares to cash per share",
                    }]),
                {
                  transformId: "aggregate-annual-cash-dividends",
                  version: "1.0.0",
                  detail:
                    `Sum ${dividend.identities.length} implemented cash distribution(s) assigned to fiscal year ${dividend.fiscalYear}`,
                },
                {
                  transformId: isHongKong
                    ? "update-date-end-of-day"
                    : "notice-date-end-of-day",
                  version: "1.0.0",
                  detail: isHongKong
                    ? "Treat the latest UPDATE_DATE as available at end of day"
                    : "Treat the latest NOTICE_DATE as available at end of day",
                },
              ],
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
                : "Failed to parse Eastmoney dividends",
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
          const reportingVersion = financialReportingVersion(
            reportDate,
            noticeDate,
          );
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
              reportingVersion,
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
                transformations: [
                  ...(reportingVersion.kind === "later-comparative"
                    ? [{
                        transformId: "historical-comparative-record",
                        version: "1.0.0",
                        detail:
                          `Classify REPORT_DATE ${datePart(reportDate)} published on ${datePart(noticeDate)} as the comparison column of the ${reportingVersion.sourcePeriodEndDate} filing`,
                      }]
                    : []),
                  {
                    transformId: "notice-date-end-of-day",
                    version: "1.0.0",
                    detail: "Treat NOTICE_DATE as available at end of day",
                  },
                ],
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
