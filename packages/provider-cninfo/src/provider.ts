import { createCipheriv, createHash } from "node:crypto";
import {
  fetchBytes,
  ProviderFailure,
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
  type AccountingBasis,
  type ConceptId,
  type FactRequirement,
  type Observation,
  type ReportingPeriod,
  type UnmappedObservation,
} from "@verified-financial/schema";
import { Decimal } from "decimal.js";
import { extractText, getDocumentProxy } from "unpdf";

const PROVIDER_ID = "cninfo-direct";
const UPSTREAM_SOURCE_ID = "cninfo";
const MAPPING_VERSION = "cninfo@1.1.0";
const API_BASE = "https://www.cninfo.com.cn/new/";
const WEBAPI_BASE = "https://webapi.cninfo.com.cn/";
const PDF_BASE = "https://static.cninfo.com.cn/";
const WEBAPI_CIPHER_KEY = "1234567887654321";
const USER_AGENT =
  "verified-financial-core/0.1 (+https://github.com/leedj8886/verified-financial-core)";

type JsonObject = Record<string, unknown>;

interface SearchResult {
  code: string;
  orgId: string;
  zwjc: string;
  category?: string;
  delisted?: string;
}

interface Announcement {
  secCode: string;
  secName: string;
  orgId: string;
  announcementId: string;
  announcementTitle: string;
  announcementTime: number;
  adjunctUrl: string;
  adjunctType: string;
}

interface DividendComponent {
  fiscalYear: number;
  value: string;
  availableDate: string;
  identity: string;
}

interface AnnualDividend {
  fiscalYear: number;
  value: string;
  availableDate: string;
  identities: string[];
}

type StatementKind = "balance" | "income" | "cashFlow";

interface FieldDefinition {
  concept: ConceptId;
  statement: StatementKind;
  rawField: string;
  patterns: RegExp[];
  attribution?: AccountingBasis["attribution"];
}

interface FilingQuery {
  fiscalYear: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  presentation: "annual" | "ytd";
  category: string;
  reportLabel: string;
  requirements: FactRequirement[];
}

export type PdfTextExtractor = (
  data: Uint8Array<ArrayBuffer>,
) => Promise<string[]>;

export interface CninfoProviderOptions {
  fetchImplementation?: FetchImplementation;
  extractTextImplementation?: PdfTextExtractor;
  retries?: number;
  timeoutMs?: number;
  apiBase?: string;
  webapiBase?: string;
  pdfBase?: string;
}

const fieldDefinitions: readonly FieldDefinition[] = [
  {
    concept: "income.revenue",
    statement: "income",
    rawField: "合并利润表.营业总收入",
    patterns: [
      /一、?营业总收入[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/,
      /营业总收入[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/,
    ],
  },
  {
    concept: "income.operatingProfit",
    statement: "income",
    rawField: "合并利润表.营业利润",
    patterns: [
      /三、?营业利润[^0-9]{0,50}([+-]?\d[\d,]*\.\d+)/,
      /营业利润[^0-9]{0,50}([+-]?\d[\d,]*\.\d+)/,
    ],
  },
  {
    concept: "income.netProfit",
    statement: "income",
    rawField: "合并利润表.净利润",
    patterns: [
      /五、?净利润[^0-9]{0,50}([+-]?\d[\d,]*\.\d+)/,
      /净利润[^0-9]{0,50}([+-]?\d[\d,]*\.\d+)/,
    ],
  },
  {
    concept: "income.netProfitParent",
    statement: "income",
    rawField: "合并利润表.归属于母公司股东的净利润",
    patterns: [
      /归属于母公司(?:股东|所有者)的净利润[^0-9]{0,60}([+-]?\d[\d,]*\.\d+)/,
      /归属于上市公司股东的净利润[^0-9]{0,60}([+-]?\d[\d,]*\.\d+)/,
    ],
    attribution: "parent",
  },
  {
    concept: "balance.assets",
    statement: "balance",
    rawField: "合并资产负债表.资产总计",
    patterns: [/资产总计[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/],
  },
  {
    concept: "balance.liabilities",
    statement: "balance",
    rawField: "合并资产负债表.负债合计",
    patterns: [
      /(?<!流动)(?<!非流动)负债合计[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/,
    ],
  },
  {
    concept: "balance.equity",
    statement: "balance",
    rawField: "合并资产负债表.所有者权益合计",
    patterns: [
      /所有者权益(?:\(或股东权益\))?合计[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/,
    ],
    attribution: "all-shareholders",
  },
  {
    concept: "balance.cash",
    statement: "balance",
    rawField: "合并资产负债表.货币资金",
    patterns: [
      /货币资金\s+(?:\d{1,3}\s+)?([+-]?\d[\d,]*\.\d+)/,
    ],
  },
  {
    concept: "cashFlow.operatingCashFlow",
    statement: "cashFlow",
    rawField: "合并现金流量表.经营活动产生的现金流量净额",
    patterns: [
      /经营活动产生的现金流量净额[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/,
    ],
  },
  {
    concept: "cashFlow.capex",
    statement: "cashFlow",
    rawField:
      "合并现金流量表.购建固定资产、无形资产和其他长期资产支付的现金",
    patterns: [
      /购建固定资产、?无形资产和其他长期资产支付的现金[^0-9]{0,20}([+-]?\d[\d,]*\.\d+)/,
    ],
  },
] as const;

export const CNINFO_FIELD_MAPPINGS: readonly SourceFieldMapping[] = [
  {
    upstreamSchema: "p_sysapi1139",
    rawField: "records[].F012N",
    conceptId: "distribution.dividendPerShare",
    unit: "currency-per-share",
    scale: "0.1",
    transformIds: [
      "per-ten-shares",
      "aggregate-annual-cash-dividends",
      "implementation-date-end-of-day",
    ],
  },
  ...fieldDefinitions.map((field) => ({
    upstreamSchema: "cninfo.periodic-report.pdf",
    rawField: field.rawField,
    conceptId: field.concept,
    unit: "currency",
    scale: "1",
    transformIds: ["pdf-text-extract", "consolidated-statement-label-match"],
  })),
];

const definitionsByConcept = new Map(
  fieldDefinitions.map((field) => [field.concept, field]),
);

const statementBoundaries: Record<
  StatementKind,
  { start: string; end: string }
> = {
  balance: {
    start: "合并资产负债表",
    end: "母公司资产负债表",
  },
  income: {
    start: "合并利润表",
    end: "母公司利润表",
  },
  cashFlow: {
    start: "合并现金流量表",
    end: "母公司现金流量表",
  },
};

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function asObject(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function exactDecimal(value: unknown): string | undefined {
  if (
    typeof value === "number"
    && Number.isFinite(value)
  ) {
    return String(value);
  }
  if (
    typeof value === "string"
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

function parseSearchResults(value: unknown): SearchResult[] {
  if (!Array.isArray(value)) throw new Error("CNINFO search result is invalid");
  return value.flatMap((item) => {
    const candidate = asObject(item, "CNINFO search item is invalid");
    const code = asString(candidate["code"]);
    const orgId = asString(candidate["orgId"]);
    const zwjc = asString(candidate["zwjc"]);
    const category = asString(candidate["category"]);
    const delisted = asString(candidate["delisted"]);
    if (code === undefined || orgId === undefined || zwjc === undefined) {
      return [];
    }
    return [{
      code,
      orgId,
      zwjc,
      ...(category === undefined ? {} : { category }),
      ...(delisted === undefined ? {} : { delisted }),
    }];
  });
}

function parseAnnouncements(value: unknown): Announcement[] {
  const object = asObject(value, "CNINFO announcement response is invalid");
  const announcements = object["announcements"];
  if (!Array.isArray(announcements)) return [];
  return announcements.flatMap((item) => {
    const candidate = asObject(item, "CNINFO announcement item is invalid");
    const secCode = asString(candidate["secCode"]);
    const secName = asString(candidate["secName"]);
    const orgId = asString(candidate["orgId"]);
    const announcementId = asString(candidate["announcementId"]);
    const announcementTitle = asString(candidate["announcementTitle"]);
    const announcementTime = asNumber(candidate["announcementTime"]);
    const adjunctUrl = asString(candidate["adjunctUrl"]);
    const adjunctType = asString(candidate["adjunctType"]);
    if (
      secCode === undefined
      || secName === undefined
      || orgId === undefined
      || announcementId === undefined
      || announcementTitle === undefined
      || announcementTime === undefined
      || adjunctUrl === undefined
      || adjunctType === undefined
    ) {
      return [];
    }
    return [{
      secCode,
      secName,
      orgId,
      announcementId,
      announcementTitle,
      announcementTime,
      adjunctUrl,
      adjunctType,
    }];
  });
}

function chinaDate(value: string | number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function publishedAtEndOfDay(announcementTime: number): string {
  return `${chinaDate(announcementTime)}T23:59:59+08:00`;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.slice(0, 10).replaceAll("/", "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : undefined;
}

function dividendFiscalYear(reportLabel: unknown): number | undefined {
  if (typeof reportLabel !== "string") return undefined;
  const match =
    /^(\d{4})(?:年报|三季报|中报|半年报|一季报|一季度报|半年度报告|年度报告)$/
      .exec(reportLabel.trim());
  if (match?.[1] === undefined) return undefined;
  const fiscalYear = Number(match[1]);
  return Number.isInteger(fiscalYear) ? fiscalYear : undefined;
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

function parseDividendComponents(value: unknown): DividendComponent[] {
  const object = asObject(value, "CNINFO dividend response is invalid");
  if (object["resultcode"] !== 200) {
    throw new Error(
      asString(object["resultmsg"]) ?? "CNINFO dividend request failed",
    );
  }
  const records = object["records"];
  if (!Array.isArray(records)) {
    throw new Error("CNINFO dividend records are invalid");
  }
  return records.flatMap((item): DividendComponent[] => {
    const record = asObject(item, "CNINFO dividend record is invalid");
    const fiscalYear = dividendFiscalYear(record["F001V"]);
    const value = exactDecimal(record["F012N"]);
    const availableDate = isoDate(record["F006D"]);
    const lifecycleDates = [
      isoDate(record["F018D"]),
      isoDate(record["F020D"]),
      isoDate(record["F023D"]),
    ];
    if (
      fiscalYear === undefined
      || value === undefined
      || availableDate === undefined
      || lifecycleDates.every((date) => date === undefined)
      || new Decimal(value).lte(0)
    ) {
      return [];
    }
    return [{
      fiscalYear,
      value,
      availableDate,
      identity: JSON.stringify({
        reportLabel: record["F001V"],
        dividendType: record["F044V"],
      }),
    }];
  });
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
  const groups = new Map<number, DividendComponent[]>();
  for (const component of unique.values()) {
    const group = groups.get(component.fiscalYear) ?? [];
    group.push(component);
    groups.set(component.fiscalYear, group);
  }
  return [...groups.entries()].map(([fiscalYear, group]) => ({
    fiscalYear,
    value: group.reduce(
      (total, component) => total.plus(component.value),
      new Decimal(0),
    ).toString(),
    availableDate: group
      .map((component) => component.availableDate)
      .sort()
      .at(-1)!,
    identities: group.map((component) => component.identity).sort(),
  })).sort((left, right) => right.fiscalYear - left.fiscalYear);
}

function acceptEnckey(now: string): string {
  const key = Buffer.from(WEBAPI_CIPHER_KEY, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([
    cipher.update(
      String(Math.floor(Date.parse(now) / 1000)),
      "utf8",
    ),
    cipher.final(),
  ]).toString("base64");
}

function reportQuery(
  requirement: FactRequirement,
): Omit<FilingQuery, "requirements"> | undefined {
  const period = requirement.period;
  if (
    period === undefined
    || (period.presentation !== "annual" && period.presentation !== "ytd")
  ) {
    return undefined;
  }
  if (period.presentation === "annual") {
    return {
      fiscalYear: period.fiscalYear,
      presentation: "annual",
      category: "category_ndbg_szsh",
      reportLabel: `${period.fiscalYear}年年度报告`,
    };
  }
  const quarter = period.fiscalQuarter;
  if (quarter === undefined) return undefined;
  const details = {
    1: ["category_yjdbg_szsh", "第一季度报告"],
    2: ["category_bndbg_szsh", "半年度报告"],
    3: ["category_sjdbg_szsh", "第三季度报告"],
    4: ["category_ndbg_szsh", "年度报告"],
  } as const;
  const [category, label] = details[quarter];
  return {
    fiscalYear: period.fiscalYear,
    fiscalQuarter: quarter,
    presentation: "ytd",
    category,
    reportLabel: `${period.fiscalYear}年${label}`,
  };
}

function groupRequirements(
  requirements: readonly FactRequirement[],
): FilingQuery[] {
  const groups = new Map<string, FilingQuery>();
  for (const requirement of requirements) {
    if (!definitionsByConcept.has(requirement.conceptId)) continue;
    const query = reportQuery(requirement);
    if (query === undefined) continue;
    const key = JSON.stringify(query);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { ...query, requirements: [requirement] });
    } else {
      group.requirements.push(requirement);
    }
  }
  return [...groups.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function normalizePdfText(value: string): string {
  return value.normalize("NFKC")
    .replace(/[−–—]/g, "-")
    .replace(/(?<=[\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "")
    .replace(/\s+/g, " ");
}

function extractStatement(
  pages: readonly string[],
  statement: StatementKind,
): string | undefined {
  const boundary = statementBoundaries[statement];
  const joined = pages.join("\n");
  const start = joined.indexOf(boundary.start);
  if (start < 0) return undefined;
  const end = joined.indexOf(boundary.end, start + boundary.start.length);
  return normalizePdfText(
    joined.slice(start, end < 0 ? joined.length : end),
  );
}

export function extractFinancialValues(
  pages: readonly string[],
): Partial<Record<ConceptId, string>> {
  const sections = new Map<StatementKind, string | undefined>();
  const values: Partial<Record<ConceptId, string>> = {};
  for (const field of fieldDefinitions) {
    if (!sections.has(field.statement)) {
      sections.set(
        field.statement,
        extractStatement(pages, field.statement),
      );
    }
    const section = sections.get(field.statement);
    if (section === undefined) continue;
    for (const pattern of field.patterns) {
      const match = pattern.exec(section);
      if (match?.[1] !== undefined) {
        values[field.concept] = match[1].replaceAll(",", "");
        break;
      }
    }
  }
  return values;
}

function statementPeriod(
  query: FilingQuery,
  kind: "instant" | "duration",
): ReportingPeriod {
  const monthDay = query.presentation === "annual"
    ? "12-31"
    : {
        1: "03-31",
        2: "06-30",
        3: "09-30",
        4: "12-31",
      }[query.fiscalQuarter!];
  return {
    kind,
    ...(kind === "duration"
      ? { startDate: `${query.fiscalYear}-01-01` }
      : {}),
    endDate: `${query.fiscalYear}-${monthDay}`,
    fiscalYear: query.fiscalYear,
    ...(query.fiscalQuarter === undefined
      ? {}
      : { fiscalQuarter: query.fiscalQuarter }),
    presentation: query.presentation,
  };
}

function isFullReport(
  announcement: Announcement,
  query: FilingQuery,
  asOf: string,
): boolean {
  return announcement.adjunctType.toUpperCase() === "PDF"
    && announcement.announcementTitle.includes(query.reportLabel)
    && !/摘要|英文|取消|更正公告|提示性公告/.test(
      announcement.announcementTitle,
    )
    && Date.parse(publishedAtEndOfDay(announcement.announcementTime))
      <= Date.parse(asOf);
}

async function defaultExtractText(
  data: Uint8Array<ArrayBuffer>,
): Promise<string[]> {
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  const result = await extractText(pdf, { mergePages: false });
  return result.text;
}

export class CninfoProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["financials", "filings", "dividends"] as const;
  private readonly options: CninfoProviderOptions;

  constructor(options: CninfoProviderOptions = {}) {
    this.options = options;
  }

  supportsInstrument(instrument: ProviderRequest["instrument"]): boolean {
    return instrument.exchangeMic === "XSHG"
      || instrument.exchangeMic === "XSHE";
  }

  private apiUrl(path: string): string {
    return new URL(path, this.options.apiBase ?? API_BASE).toString();
  }

  private pdfUrl(path: string): string {
    return new URL(path, this.options.pdfBase ?? PDF_BASE).toString();
  }

  private webapiUrl(path: string): string {
    return new URL(path, this.options.webapiBase ?? WEBAPI_BASE).toString();
  }

  private async requestJson(
    path: string,
    form: URLSearchParams,
    context: ProviderContext,
  ): Promise<{ parsed: unknown; snapshot: StoredSnapshotRef }> {
    const sourceUrl = this.apiUrl(path);
    const bytes = await fetchBytes(sourceUrl, {
      providerId: this.providerId,
      signal: context.signal,
      ...(this.options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.options.fetchImplementation }),
      body: form,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: new URL(sourceUrl).origin,
        Referer: new URL("/", sourceUrl).toString(),
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
      method: "POST",
      retries: this.options.retries ?? 2,
      timeoutMs: this.options.timeoutMs ?? 10_000,
    });
    const text = new TextDecoder().decode(bytes);
    const snapshot = await context.snapshots.put({
      providerId: this.providerId,
      sourceUrl,
      mediaType: "json",
      fetchedAt: context.now,
      body: bytes,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderFailure({
        providerId: this.providerId,
        code: "UPSTREAM_SCHEMA_CHANGED",
        message: error instanceof Error
          ? `CNINFO returned invalid JSON: ${error.message}`
          : "CNINFO returned invalid JSON",
        retryable: false,
      });
    }
    return { parsed, snapshot };
  }

  private async resolveCompany(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<{ result: SearchResult; snapshot: StoredSnapshotRef }> {
    const { parsed, snapshot } = await this.requestJson(
      "information/topSearch/query",
      new URLSearchParams({
        keyWord: request.instrument.symbol,
        maxNum: "10",
        plate: "szsh",
      }),
      context,
    );
    const result = parseSearchResults(parsed).find(
      (candidate) => candidate.code === request.instrument.symbol,
    );
    if (result === undefined) {
      throw new ProviderFailure({
        providerId: this.providerId,
        code: "UNSUPPORTED_INSTRUMENT",
        message: `CNINFO did not resolve ${request.instrument.symbol}`,
        retryable: false,
      });
    }
    return { result, snapshot };
  }

  private async requestDividends(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<{ parsed: unknown; snapshot: StoredSnapshotRef; sourceUrl: string }> {
    const sourceUrl = this.webapiUrl(
      `api/sysapi/p_sysapi1139?scode=${encodeURIComponent(request.instrument.symbol)}`,
    );
    const bytes = await fetchBytes(sourceUrl, {
      providerId: this.providerId,
      signal: context.signal,
      ...(this.options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.options.fetchImplementation }),
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Enckey": acceptEnckey(context.now),
        Origin: new URL(sourceUrl).origin,
        Referer: new URL("/", sourceUrl).toString(),
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
      method: "POST",
      retries: this.options.retries ?? 2,
      timeoutMs: this.options.timeoutMs ?? 10_000,
    });
    const snapshot = await context.snapshots.put({
      providerId: this.providerId,
      sourceUrl,
      mediaType: "json",
      fetchedAt: context.now,
      body: bytes,
    });
    try {
      return {
        parsed: JSON.parse(new TextDecoder().decode(bytes)),
        snapshot,
        sourceUrl,
      };
    } catch (error) {
      throw new ProviderFailure({
        providerId: this.providerId,
        code: "UPSTREAM_SCHEMA_CHANGED",
        message: error instanceof Error
          ? `CNINFO returned invalid dividend JSON: ${error.message}`
          : "CNINFO returned invalid dividend JSON",
        retryable: false,
      });
    }
  }

  private async findAnnouncement(
    request: ProviderRequest,
    orgId: string,
    query: FilingQuery,
    context: ProviderContext,
  ): Promise<{
    announcement?: Announcement;
    snapshot: StoredSnapshotRef;
  }> {
    const { parsed, snapshot } = await this.requestJson(
      "hisAnnouncement/query",
      new URLSearchParams({
        pageNum: "1",
        pageSize: "30",
        column: "szse",
        tabName: "fulltext",
        plate: "",
        stock: `${request.instrument.symbol},${orgId}`,
        searchkey: "",
        secid: "",
        category: query.category,
        trade: "",
        seDate: `${query.fiscalYear}-01-01~${chinaDate(request.asOf)}`,
        sortName: "",
        sortType: "",
        isHLtitle: "true",
      }),
      context,
    );
    const announcement = parseAnnouncements(parsed)
      .filter((candidate) => isFullReport(candidate, query, request.asOf))
      .sort((left, right) =>
        right.announcementTime - left.announcementTime
        || right.announcementId.localeCompare(left.announcementId)
      )[0];
    return {
      ...(announcement === undefined ? {} : { announcement }),
      snapshot,
    };
  }

  private async readFiling(
    announcement: Announcement,
    context: ProviderContext,
  ): Promise<{
    pages?: string[];
    issue?: ProviderIssue;
    snapshot: StoredSnapshotRef;
    sourceUrl: string;
  }> {
    const sourceUrl = this.pdfUrl(announcement.adjunctUrl);
    const bytes = await fetchBytes(sourceUrl, {
      providerId: this.providerId,
      signal: context.signal,
      ...(this.options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.options.fetchImplementation }),
      headers: { "User-Agent": USER_AGENT },
      retries: this.options.retries ?? 2,
      timeoutMs: this.options.timeoutMs ?? 20_000,
    });
    const snapshot = await context.snapshots.put({
      providerId: this.providerId,
      sourceUrl,
      mediaType: "pdf",
      fetchedAt: context.now,
      body: bytes,
    });
    const extractor = this.options.extractTextImplementation
      ?? defaultExtractText;
    try {
      return {
        pages: await extractor(bytes),
        snapshot,
        sourceUrl,
      };
    } catch (error) {
      return {
        issue: {
          providerId: this.providerId,
          code: "OFFICIAL_DOCUMENT_UNREADABLE",
          message: error instanceof Error
            ? `Failed to read CNINFO PDF: ${error.message}`
            : "Failed to read CNINFO PDF",
          retryable: false,
        },
        snapshot,
        sourceUrl,
      };
    }
  }

  async fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch> {
    const observations: Observation[] = [];
    const unmapped: UnmappedObservation[] = [];
    const rawSnapshots: StoredSnapshotRef[] = [];
    const issues: ProviderIssue[] = [];
    let legalName = request.instrument.instrumentId;

    const buildBatch = (): ProviderBatch => ({
      providerId: this.providerId,
      upstreamSourceId: this.upstreamSourceId,
      company: {
        companyId: request.instrument.companyId,
        legalName,
        jurisdiction: "CN",
      },
      instruments: [request.instrument],
      observations,
      unmapped,
      rawSnapshots,
      mappingVersions: [MAPPING_VERSION],
      issues,
    });

    if (request.offline) {
      issues.push({
        providerId: this.providerId,
        code: "EMPTY_RESPONSE",
        message: "Offline mode does not access CNINFO",
        retryable: false,
      });
      return buildBatch();
    }
    if (
      request.instrument.exchangeMic !== "XSHG"
      && request.instrument.exchangeMic !== "XSHE"
    ) {
      issues.push({
        providerId: this.providerId,
        code: "UNSUPPORTED_INSTRUMENT",
        message: `CNINFO Provider supports XSHG and XSHE, not ${request.instrument.exchangeMic}`,
        retryable: false,
      });
      return buildBatch();
    }

    const queries = groupRequirements(request.requirements);
    const requestsDividends = request.requirements.some((requirement) =>
      requirement.conceptId === "distribution.dividendPerShare"
    );
    if (queries.length === 0 && !requestsDividends) {
      issues.push({
        providerId: this.providerId,
        code: "EMPTY_RESPONSE",
        message: "CNINFO supports explicit annual and YTD financial periods",
        retryable: false,
      });
      return buildBatch();
    }

    let resolved: Awaited<ReturnType<CninfoProvider["resolveCompany"]>>;
    try {
      resolved = await this.resolveCompany(request, context);
      legalName = resolved.result.zwjc;
      rawSnapshots.push(resolved.snapshot);
    } catch (error) {
      issues.push(error instanceof ProviderFailure
        ? error.issue
        : {
            providerId: this.providerId,
            code: "PARSE_FAILED",
            message: error instanceof Error
              ? error.message
              : "Failed to resolve CNINFO company",
            retryable: false,
          });
      return buildBatch();
    }

    if (requestsDividends) {
      try {
        const response = await this.requestDividends(request, context);
        rawSnapshots.push(response.snapshot);
        const requestedYears = requestedDividendYears(request.requirements);
        const dividends = aggregateAnnualDividends(
          parseDividendComponents(response.parsed),
        ).filter((dividend) =>
          requestedYears === undefined
          || requestedYears.has(dividend.fiscalYear)
        );
        if (dividends.length === 0) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message:
              "CNINFO has no implemented annual cash dividend for the request",
            retryable: false,
          });
        }
        for (const dividend of dividends) {
          const period = dividendPeriod(dividend.fiscalYear);
          const publishedAt = `${dividend.availableDate}T23:59:59+08:00`;
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              snapshotId: response.snapshot.snapshotId,
              rawField: "records[].F012N",
              concept: "distribution.dividendPerShare",
              period,
              identities: dividend.identities,
            }),
            companyId: request.instrument.companyId,
            instrumentId: request.instrument.instrumentId,
            concept: "distribution.dividendPerShare",
            value: dividend.value,
            unit: "CNY-per-share",
            scale: "0.1",
            period,
            basis: {
              standard: "OTHER",
              scope: "standalone",
              presentation: "reported",
              attribution: "all-shareholders",
              currency: "CNY",
            },
            availability: {
              filingDate: dividend.availableDate,
              publishedAt,
              sourceAsOf: publishedAt,
              fetchedAt: context.now,
            },
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "official",
              sourceUrl: response.sourceUrl,
              rawSnapshotId: response.snapshot.snapshotId,
              rawField: "records[].F012N",
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: [
                {
                  transformId: "per-ten-shares",
                  version: "1.0.0",
                  detail:
                    "Scale F012N from cash per 10 shares to cash per share",
                },
                {
                  transformId: "aggregate-annual-cash-dividends",
                  version: "1.0.0",
                  detail:
                    `Sum ${dividend.identities.length} implemented cash distribution(s) assigned to fiscal year ${dividend.fiscalYear}`,
                },
                {
                  transformId: "implementation-date-end-of-day",
                  version: "1.0.0",
                  detail:
                    "Treat the latest implementation announcement date F006D as available at end of day",
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
                : "Failed to parse CNINFO dividends",
              retryable: false,
            });
      }
    }

    for (const query of queries) {
      try {
        const found = await this.findAnnouncement(
          request,
          resolved.result.orgId,
          query,
          context,
        );
        rawSnapshots.push(found.snapshot);
        if (found.announcement === undefined) {
          issues.push({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message: `CNINFO has no ${query.reportLabel} available as of ${request.asOf}`,
            retryable: false,
          });
          continue;
        }
        const filing = await this.readFiling(found.announcement, context);
        rawSnapshots.push(filing.snapshot);
        if (filing.issue !== undefined || filing.pages === undefined) {
          issues.push(filing.issue ?? {
            providerId: this.providerId,
            code: "OFFICIAL_DOCUMENT_UNREADABLE",
            message: "CNINFO PDF text was unavailable",
            retryable: false,
          });
          continue;
        }
        const values = extractFinancialValues(filing.pages);
        const filingDate = chinaDate(found.announcement.announcementTime);
        const publishedAt = publishedAtEndOfDay(
          found.announcement.announcementTime,
        );
        for (const requirement of query.requirements) {
          const field = definitionsByConcept.get(requirement.conceptId)!;
          const value = values[requirement.conceptId];
          if (value === undefined) {
            unmapped.push(UnmappedObservationSchema.parse({
              unmappedId: stableId("unmapped", {
                documentId: found.announcement.announcementId,
                rawField: field.rawField,
                requirement,
              }),
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              rawSnapshotId: filing.snapshot.snapshotId,
              rawField: field.rawField,
              rawValue: null,
              reasonCode: "UNMAPPED_SOURCE_FIELD",
            }));
            continue;
          }
          const period = statementPeriod(
            query,
            field.statement === "balance" ? "instant" : "duration",
          );
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              documentId: found.announcement.announcementId,
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
            availability: {
              filingDate,
              publishedAt,
              sourceAsOf: publishedAt,
              fetchedAt: context.now,
            },
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "official",
              documentId: found.announcement.announcementId,
              sourceUrl: filing.sourceUrl,
              rawSnapshotId: filing.snapshot.snapshotId,
              rawField: field.rawField,
              extractionMethod: "pdf",
              fetchedAt: context.now,
              transformations: [
                {
                  transformId: "pdf-text-extract",
                  version: "1.0.0",
                  detail: "Extract text with unpdf using bundled CJK maps",
                },
                {
                  transformId: "consolidated-statement-label-match",
                  version: "1.0.0",
                  detail: "Read the first reported value from the consolidated statement section",
                },
                {
                  transformId: "announcement-date-end-of-day",
                  version: "1.0.0",
                  detail: "Treat a date-only CNINFO announcement timestamp as available at end of day",
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
                : `Failed to parse CNINFO ${query.reportLabel}`,
              retryable: false,
            });
      }
    }

    return buildBatch();
  }
}
