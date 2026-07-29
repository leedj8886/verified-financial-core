import { createHash } from "node:crypto";
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

const PROVIDER_ID = "hkex-direct";
const UPSTREAM_SOURCE_ID = "hkex";
const MAPPING_VERSION = "hkex@1.1.0";
const BASE_URL = "https://www1.hkexnews.hk/";
const USER_AGENT =
  "verified-financial-core/0.1 (+https://github.com/leedj8886/verified-financial-core)";

type JsonObject = Record<string, unknown>;
type StatementKind = "income" | "balance" | "cashFlow";

interface StockSearchResult {
  stockId: number;
  code: string;
  name: string;
}

interface Filing {
  fileInfo: string;
  newsId: string;
  stockName: string;
  title: string;
  fileType: string;
  dateTime: string;
  longText: string;
  stockCode: string;
  fileLink: string;
}

interface FilingQuery {
  fiscalYear: number;
  fiscalQuarter?: 2;
  presentation: "annual" | "ytd";
  reportKeyword: string;
  resultKeyword: string;
  reportLabel: string;
  requirements: FactRequirement[];
}

interface DividendComponent {
  fiscalYear: number;
  currency: string;
  value: string;
  availableAt: string;
  filing: Filing;
  snapshot: StoredSnapshotRef;
  sourceUrl: string;
}

interface AnnualDividend {
  fiscalYear: number;
  currency: string;
  value: string;
  availableAt: string;
  components: DividendComponent[];
}

interface FieldDefinition {
  concept: ConceptId;
  statement: StatementKind;
  rawField: string;
  attribution?: AccountingBasis["attribution"];
}

interface StatementUnit {
  currency: string;
  scale: string;
}

export interface HkexFinancialExtraction {
  values: Partial<Record<ConceptId, string>>;
  currency?: string;
  scale?: string;
  standard: AccountingBasis["standard"];
}

export type PdfTextExtractor = (
  data: Uint8Array<ArrayBuffer>,
) => Promise<string[]>;

export interface HkexProviderOptions {
  fetchImplementation?: FetchImplementation;
  extractTextImplementation?: PdfTextExtractor;
  retries?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

const fieldDefinitions: readonly FieldDefinition[] = [
  {
    concept: "income.revenue",
    statement: "income",
    rawField: "Consolidated income statement.Revenue",
  },
  {
    concept: "income.operatingProfit",
    statement: "income",
    rawField: "Consolidated income statement.Operating profit",
  },
  {
    concept: "income.netProfit",
    statement: "income",
    rawField: "Consolidated income statement.Profit for the year/period",
  },
  {
    concept: "income.netProfitParent",
    statement: "income",
    rawField:
      "Consolidated income statement.Profit attributable to equity holders/owners of the company",
    attribution: "parent",
  },
  {
    concept: "balance.assets",
    statement: "balance",
    rawField: "Consolidated statement of financial position.Total assets",
  },
  {
    concept: "balance.liabilities",
    statement: "balance",
    rawField:
      "Consolidated statement of financial position.Total liabilities",
  },
  {
    concept: "balance.equity",
    statement: "balance",
    rawField: "Consolidated statement of financial position.Total equity",
    attribution: "all-shareholders",
  },
  {
    concept: "balance.cash",
    statement: "balance",
    rawField:
      "Consolidated statement of financial position.Cash and cash equivalents",
  },
  {
    concept: "cashFlow.operatingCashFlow",
    statement: "cashFlow",
    rawField:
      "Consolidated statement of cash flows.Net cash generated from operating activities",
  },
  {
    concept: "cashFlow.capex",
    statement: "cashFlow",
    rawField:
      "Consolidated statement of cash flows.Purchases/prepayments for property, plant, equipment, intangible assets and other long-term assets",
  },
] as const;

export const HKEX_FIELD_MAPPINGS: readonly SourceFieldMapping[] = [
  {
    upstreamSchema: "hkex.cash-dividend-announcement.pdf",
    rawField: "Dividend declared",
    conceptId: "distribution.dividendPerShare",
    unit: "currency-per-share",
    scale: "1",
    transformIds: [
      "pdf-text-extract",
      "parse-cash-dividend-per-share",
      "aggregate-annual-cash-dividends",
      "shareholder-approval-availability",
    ],
  },
  ...fieldDefinitions.map((field) => ({
    upstreamSchema: "hkex.periodic-report.pdf",
    rawField: field.rawField,
    conceptId: field.concept,
    unit: "currency",
    scale: "1",
    transformIds: [
      "pdf-text-extract",
      "consolidated-statement-label-match",
      "statement-header-scale",
      ...(field.concept === "cashFlow.capex"
        ? ["sum-capex-components"]
        : []),
    ],
  })),
];

const definitionsByConcept = new Map(
  fieldDefinitions.map((field) => [field.concept, field]),
);

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
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function stripMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x2f;/gi, "/")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseStockSearch(value: string): StockSearchResult[] {
  const match = /^\s*callback\(([\s\S]*)\);?\s*$/.exec(value);
  if (match?.[1] === undefined) {
    throw new Error("HKEX stock search returned invalid JSONP");
  }
  const object = asObject(
    JSON.parse(match[1]) as unknown,
    "HKEX stock search response is invalid",
  );
  const stockInfo = object["stockInfo"];
  if (!Array.isArray(stockInfo)) return [];
  return stockInfo.flatMap((item) => {
    const candidate = asObject(item, "HKEX stock search item is invalid");
    const stockId = asNumber(candidate["stockId"]);
    const code = asString(candidate["code"]);
    const name = asString(candidate["name"]);
    return stockId === undefined || code === undefined || name === undefined
      ? []
      : [{ stockId, code, name }];
  });
}

function parseFilings(value: unknown): Filing[] {
  const object = asObject(value, "HKEX title search response is invalid");
  const encoded = asString(object["result"]);
  if (encoded === undefined) return [];
  const result = JSON.parse(encoded) as unknown;
  if (!Array.isArray(result)) {
    throw new Error("HKEX title search result is invalid");
  }
  return result.flatMap((item) => {
    const candidate = asObject(item, "HKEX filing item is invalid");
    const fileInfo = asString(candidate["FILE_INFO"]);
    const newsId = asString(candidate["NEWS_ID"]);
    const stockName = asString(candidate["STOCK_NAME"]);
    const title = asString(candidate["TITLE"]);
    const fileType = asString(candidate["FILE_TYPE"]);
    const dateTime = asString(candidate["DATE_TIME"]);
    const longText = asString(candidate["LONG_TEXT"]);
    const stockCode = asString(candidate["STOCK_CODE"]);
    const fileLink = asString(candidate["FILE_LINK"]);
    if (
      fileInfo === undefined
      || newsId === undefined
      || stockName === undefined
      || title === undefined
      || fileType === undefined
      || dateTime === undefined
      || longText === undefined
      || stockCode === undefined
      || fileLink === undefined
    ) {
      return [];
    }
    return [{
      fileInfo,
      newsId,
      stockName: stripMarkup(stockName),
      title: stripMarkup(title),
      fileType,
      dateTime,
      longText: stripMarkup(longText),
      stockCode: stripMarkup(stockCode),
      fileLink,
    }];
  });
}

function hongKongDate(value: string | number | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function publishedAt(dateTime: string): string {
  const match =
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(dateTime);
  if (match === null) throw new Error(`Invalid HKEX release time: ${dateTime}`);
  return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+08:00`;
}

function englishDate(
  day: string,
  monthName: string,
  year: string,
): string | undefined {
  const month = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  }[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  const normalizedDay = day.padStart(2, "0");
  return /^\d{4}$/.test(year) && /^(?:0[1-9]|[12]\d|3[01])$/.test(normalizedDay)
    ? `${year}-${month}-${normalizedDay}`
    : undefined;
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

function dividendPeriod(fiscalYear: number): ReportingPeriod {
  return {
    kind: "duration",
    startDate: `${fiscalYear}-01-01`,
    endDate: `${fiscalYear}-12-31`,
    fiscalYear,
    presentation: "annual",
  };
}

function extractDividend(
  pages: readonly string[],
  filing: Filing,
  snapshot: StoredSnapshotRef,
  sourceUrl: string,
): DividendComponent | undefined {
  const text = normalizeLine(pages.join(" "));
  if (!/Cash Dividend Announcement for Equity Issuer/i.test(text)) {
    return undefined;
  }
  const fiscalEnd =
    /For the financial year end\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i
      .exec(text);
  const declared =
    /Dividend declared\s+([A-Z]{3})\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+per share/i
      .exec(text);
  if (
    fiscalEnd?.[1] === undefined
    || fiscalEnd[2] === undefined
    || fiscalEnd[3] === undefined
    || declared?.[1] === undefined
    || declared[2] === undefined
  ) {
    return undefined;
  }
  const fiscalEndDate = englishDate(
    fiscalEnd[1],
    fiscalEnd[2],
    fiscalEnd[3],
  );
  if (fiscalEndDate !== `${fiscalEnd[3]}-12-31`) {
    return undefined;
  }
  const approval =
    /Date of shareholders?' approval\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i
      .exec(text);
  const approvalDate = approval?.[1] !== undefined
      && approval[2] !== undefined
      && approval[3] !== undefined
    ? englishDate(approval[1], approval[2], approval[3])
    : undefined;
  const releasedAt = publishedAt(filing.dateTime);
  const approvedAt = approvalDate === undefined
    ? undefined
    : `${approvalDate}T23:59:59+08:00`;
  const availableAt = approvedAt !== undefined && approvedAt > releasedAt
    ? approvedAt
    : releasedAt;
  return {
    fiscalYear: Number(fiscalEnd[3]),
    currency: declared[1].toUpperCase(),
    value: declared[2],
    availableAt,
    filing,
    snapshot,
    sourceUrl,
  };
}

function aggregateAnnualDividends(
  components: readonly DividendComponent[],
): AnnualDividend[] {
  const unique = new Map<string, DividendComponent>();
  for (const component of components) {
    unique.set(component.filing.newsId, component);
  }
  const groups = new Map<string, DividendComponent[]>();
  for (const component of unique.values()) {
    const key = `${component.fiscalYear}:${component.currency}`;
    const group = groups.get(key) ?? [];
    group.push(component);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = group.sort((left, right) =>
      left.availableAt.localeCompare(right.availableAt)
      || left.filing.newsId.localeCompare(right.filing.newsId)
    );
    const first = ordered[0]!;
    return {
      fiscalYear: first.fiscalYear,
      currency: first.currency,
      value: ordered.reduce(
        (total, component) => total.plus(component.value),
        new Decimal(0),
      ).toString(),
      availableAt: ordered.at(-1)!.availableAt,
      components: ordered,
    };
  }).sort((left, right) =>
    right.fiscalYear - left.fiscalYear
    || left.currency.localeCompare(right.currency)
  );
}

function reportQuery(
  requirement: FactRequirement,
): Omit<FilingQuery, "requirements"> | undefined {
  const period = requirement.period;
  if (period?.presentation === "annual") {
    return {
      fiscalYear: period.fiscalYear,
      presentation: "annual",
      reportKeyword: "annual report",
      resultKeyword: "annual results",
      reportLabel: `${period.fiscalYear} annual report/results`,
    };
  }
  if (
    period?.presentation === "ytd"
    && period.fiscalQuarter === 2
  ) {
    return {
      fiscalYear: period.fiscalYear,
      fiscalQuarter: 2,
      presentation: "ytd",
      reportKeyword: "interim report",
      resultKeyword: "interim results",
      reportLabel: `${period.fiscalYear} interim report/results`,
    };
  }
  return undefined;
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

function normalizeLine(value: string): string {
  return value.normalize("NFKC")
    .replace(/[−–—]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function statementSections(pages: readonly string[]): Record<
  StatementKind,
  string[]
> {
  const lines = pages.flatMap((page) => page.split(/\r?\n/))
    .map(normalizeLine);
  const slice = (
    starts: readonly RegExp[],
    ends: readonly RegExp[],
  ): string[] => {
    const start = lines.findIndex((line) =>
      starts.some((pattern) => pattern.test(line))
    );
    if (start < 0) return [];
    const relativeEnd = lines.slice(start + 1).findIndex((line) =>
      ends.some((pattern) => pattern.test(line))
    );
    return lines.slice(
      start,
      relativeEnd < 0 ? lines.length : start + 1 + relativeEnd,
    );
  };
  return {
    income: slice(
      [
        /^(?:CONDENSED )?CONSOLIDATED INCOME STATEMENT$/i,
        /^(?:CONDENSED )?CONSOLIDATED STATEMENT OF PROFIT OR LOSS$/i,
      ],
      [
        /^CONSOLIDATED STATEMENT OF COMPREHENSIVE INCOME$/i,
        /^CONSOLIDATED STATEMENT OF FINANCIAL POSITION$/i,
      ],
    ),
    balance: slice(
      [
        /^(?:CONDENSED )?CONSOLIDATED STATEMENT OF FINANCIAL POSITION$/i,
        /^(?:CONDENSED )?CONSOLIDATED BALANCE SHEET$/i,
      ],
      [
        /^CONSOLIDATED STATEMENT OF CHANGES IN EQUITY$/i,
        /^(?:CONDENSED )?CONSOLIDATED STATEMENT OF CASH FLOWS$/i,
      ],
    ),
    cashFlow: slice(
      [
        /^(?:CONDENSED )?CONSOLIDATED STATEMENT OF CASH FLOWS$/i,
        /^(?:CONDENSED )?CONSOLIDATED CASH FLOW STATEMENT$/i,
      ],
      [/^NOTES TO THE CONSOLIDATED FINANCIAL STATEMENTS$/i],
    ),
  };
}

const numericPattern = /\(?-?\d[\d,]*(?:\.\d+)?\)?/g;

function normalizeNumeric(value: string): string {
  const parenthesized = value.startsWith("(") && value.endsWith(")");
  const normalized = value.replace(/[(),]/g, "");
  return parenthesized ? `-${normalized}` : normalized;
}

function currentValue(tokens: readonly string[]): string | undefined {
  if (tokens.length === 0) return undefined;
  if (
    tokens.length >= 3
    && /^\d{1,3}$/.test(tokens[0]!)
  ) {
    return normalizeNumeric(tokens[1]!);
  }
  return normalizeNumeric(tokens[0]!);
}

function rowValue(
  lines: readonly string[],
  labels: readonly RegExp[],
): string | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const label = labels.find((pattern) => pattern.test(line));
    if (label === undefined) continue;
    const afterLabel = line.slice(line.search(label) + line.match(label)![0].length);
    const sameLine = afterLabel.match(numericPattern) ?? [];
    if (sameLine.length > 0) return currentValue(sameLine);
    const nextLine = lines[index + 1]?.match(numericPattern) ?? [];
    if (nextLine.length > 0) return currentValue(nextLine);
  }
  return undefined;
}

function revenueValue(lines: readonly string[]): string | undefined {
  const start = lines.findIndex((line) =>
    /^(?:Revenue|Revenues|Turnover)(?:\s|$)/i.test(line)
  );
  if (start < 0) return undefined;
  const direct = lines[start]!.replace(
    /^(?:Revenue|Revenues|Turnover)\s*/i,
    "",
  ).match(numericPattern) ?? [];
  if (direct.length > 0) return currentValue(direct);
  const endRelative = lines.slice(start + 1).findIndex((line) =>
    /^Cost of (?:revenue|revenues|sales)(?:\s|$)/i.test(line)
  );
  const candidates = lines.slice(
    start + 1,
    endRelative < 0 ? start + 12 : start + 1 + endRelative,
  ).flatMap((line) => {
    const tokens = line.match(numericPattern) ?? [];
    return tokens.length >= 2 ? [tokens] : [];
  });
  return candidates.length === 0
    ? undefined
    : currentValue(candidates.at(-1)!);
}

function capexValue(lines: readonly string[]): string | undefined {
  const joined = lines.join(" ");
  const component = (
    start: RegExp,
    end: RegExp,
  ): string | undefined => {
    const startMatch = start.exec(joined);
    if (startMatch === null) return undefined;
    const tail = joined.slice(startMatch.index + startMatch[0].length);
    const endMatch = end.exec(tail);
    const row = tail.slice(0, endMatch?.index ?? 220);
    return currentValue(row.match(numericPattern) ?? []);
  };
  const combined = component(
    /Purchase(?:s)?(?: of)?(?:\/prepayments for)? property, plant and equipment,? (?:and )?intangible assets/i,
    /Proceeds|Payments|Purchase|Refund|Net cash/i,
  );
  if (combined !== undefined) return new Decimal(combined).abs().toString();
  const property = component(
    /Purchase(?:s)?(?: of)?(?:\/prepayments for)? property, plant and equipment/i,
    /Proceeds|Purchase|Refund|Payments|Net cash/i,
  );
  const intangible = component(
    /Purchase(?:s)?(?: of)?(?:\/prepayments for)? intangible assets/i,
    /Proceeds|Purchase|Refund|Payments|Net cash/i,
  );
  if (property === undefined || intangible === undefined) return undefined;
  return new Decimal(property).abs().plus(
    new Decimal(intangible).abs(),
  ).toString();
}

function detectUnit(lines: readonly string[]): StatementUnit | undefined {
  const header = lines.slice(0, 25).join(" ");
  const match =
    /(RMB|CNY|HKD|HK\$|US\$|USD)\s*'?\s*(Million|Billion|Thousand|000)?/i
      .exec(header);
  if (match?.[1] === undefined) return undefined;
  const currency = /^(?:RMB|CNY)$/i.test(match[1])
    ? "CNY"
    : /^(?:HKD|HK\$)$/i.test(match[1])
      ? "HKD"
      : "USD";
  const magnitude = match[2]?.toLowerCase();
  const scale = magnitude === "billion"
    ? "1000000000"
    : magnitude === "million"
      ? "1000000"
      : magnitude === "thousand" || magnitude === "000"
        ? "1000"
        : "1";
  return { currency, scale };
}

export function extractFinancialValues(
  pages: readonly string[],
): HkexFinancialExtraction {
  const sections = statementSections(pages);
  const unit = detectUnit(
    sections.income.length > 0 ? sections.income : sections.balance,
  );
  const values: Partial<Record<ConceptId, string>> = {};
  const assign = (concept: ConceptId, value: string | undefined): void => {
    if (value !== undefined) values[concept] = value;
  };
  assign("income.revenue", revenueValue(sections.income));
  assign("income.operatingProfit", rowValue(sections.income, [
      /^Operating profit(?:\s|$)/i,
      /^Profit from operations(?:\s|$)/i,
  ]));
  assign("income.netProfit", rowValue(sections.income, [
      /^Profit for the (?:year|period)(?:\s|$)/i,
  ]));
  assign("income.netProfitParent", rowValue(sections.income, [
      /^Equity holders of the Company(?:\s|$)/i,
      /^Owners of the Company(?:\s|$)/i,
  ]));
  assign("balance.assets", rowValue(sections.balance, [
      /^Total assets(?:\s|$)/i,
  ]));
  assign("balance.liabilities", rowValue(sections.balance, [
      /^Total liabilities(?! and equity)(?:\s|$)/i,
  ]));
  assign("balance.equity", rowValue(sections.balance, [
      /^Total equity(?! and liabilities)(?:\s|$)/i,
  ]));
  assign("balance.cash", rowValue(sections.balance, [
      /^Cash and cash equivalents(?:\s|$)/i,
  ]));
  assign("cashFlow.operatingCashFlow", rowValue(sections.cashFlow, [
      /^Net cash (?:flows )?generated from operating activities(?:\s|$)/i,
      /^Net cash (?:flows )?from operating activities(?:\s|$)/i,
  ]));
  assign("cashFlow.capex", capexValue(sections.cashFlow));
  const allText = pages.join("\n");
  const standard: AccountingBasis["standard"] =
    /\bIFRS\b|International Financial Reporting Standards/i.test(allText)
      ? "IFRS"
      : "OTHER";
  return {
    values,
    ...(unit === undefined ? {} : unit),
    standard,
  };
}

function statementPeriod(
  query: FilingQuery,
  kind: "instant" | "duration",
): ReportingPeriod {
  const endDate = query.presentation === "annual"
    ? `${query.fiscalYear}-12-31`
    : `${query.fiscalYear}-06-30`;
  return {
    kind,
    ...(kind === "duration"
      ? { startDate: `${query.fiscalYear}-01-01` }
      : {}),
    endDate,
    fiscalYear: query.fiscalYear,
    ...(query.fiscalQuarter === undefined
      ? {}
      : { fiscalQuarter: query.fiscalQuarter }),
    presentation: query.presentation,
  };
}

function isFullFiling(
  filing: Filing,
  request: ProviderRequest,
  query: FilingQuery,
): boolean {
  const title = filing.title.toUpperCase();
  const stockCodes = filing.stockCode.split(/\s+/);
  return filing.fileType.toUpperCase() === "PDF"
    && stockCodes.includes(request.instrument.symbol)
    && title.includes(String(query.fiscalYear))
    && !/SUPPLEMENT|CLARIFICATION|NOTICE|NOTIFICATION|CANCEL/.test(title)
    && Date.parse(publishedAt(filing.dateTime)) <= Date.parse(request.asOf);
}

async function defaultExtractText(
  data: Uint8Array<ArrayBuffer>,
): Promise<string[]> {
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  const result = await extractText(pdf, { mergePages: false });
  return result.text;
}

export class HkexProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["financials", "filings", "dividends"] as const;
  private readonly options: HkexProviderOptions;

  constructor(options: HkexProviderOptions = {}) {
    this.options = options;
  }

  supportsInstrument(instrument: ProviderRequest["instrument"]): boolean {
    return instrument.exchangeMic === "XHKG";
  }

  private url(path: string, parameters?: URLSearchParams): string {
    const url = new URL(path, this.options.baseUrl ?? BASE_URL);
    if (parameters !== undefined) url.search = parameters.toString();
    return url.toString();
  }

  private async requestText(
    sourceUrl: string,
    mediaType: "json" | "text",
    context: ProviderContext,
  ): Promise<{ text: string; snapshot: StoredSnapshotRef }> {
    const bytes = await fetchBytes(sourceUrl, {
      providerId: this.providerId,
      signal: context.signal,
      ...(this.options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.options.fetchImplementation }),
      headers: {
        Accept: "application/json,text/javascript,*/*;q=0.1",
        Referer: this.url("search/titlesearch.xhtml?lang=en"),
        "User-Agent": USER_AGENT,
      },
      retries: this.options.retries ?? 2,
      timeoutMs: this.options.timeoutMs ?? 10_000,
    });
    const snapshot = await context.snapshots.put({
      providerId: this.providerId,
      sourceUrl,
      mediaType,
      fetchedAt: context.now,
      body: bytes,
    });
    return { text: new TextDecoder().decode(bytes), snapshot };
  }

  private async resolveCompany(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<{ result: StockSearchResult; snapshot: StoredSnapshotRef }> {
    const sourceUrl = this.url("search/prefix.do", new URLSearchParams({
      lang: "EN",
      type: "A",
      name: request.instrument.symbol,
      market: "SEHK",
      callback: "callback",
    }));
    const { text, snapshot } = await this.requestText(
      sourceUrl,
      "text",
      context,
    );
    const result = parseStockSearch(text).find(
      (candidate) => candidate.code === request.instrument.symbol,
    );
    if (result === undefined) {
      throw new ProviderFailure({
        providerId: this.providerId,
        code: "UNSUPPORTED_INSTRUMENT",
        message: `HKEX did not resolve ${request.instrument.symbol}`,
        retryable: false,
      });
    }
    return { result, snapshot };
  }

  private async searchFiling(
    request: ProviderRequest,
    stockId: number,
    query: FilingQuery,
    title: string,
    context: ProviderContext,
  ): Promise<{ filing?: Filing; snapshot: StoredSnapshotRef }> {
    const sourceUrl = this.url(
      "search/titleSearchServlet.do",
      new URLSearchParams({
        sortDir: "0",
        sortByOptions: "DateTime",
        category: "0",
        market: "SEHK",
        stockId: String(stockId),
        documentType: "-1",
        fromDate: `${query.fiscalYear}0101`,
        toDate: compactDate(hongKongDate(request.asOf)),
        title,
        searchType: "0",
        t1code: "-2",
        t2Gcode: "-2",
        t2code: "-2",
        rowRange: "100",
        lang: "EN",
      }),
    );
    const { text, snapshot } = await this.requestText(
      sourceUrl,
      "json",
      context,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderFailure({
        providerId: this.providerId,
        code: "UPSTREAM_SCHEMA_CHANGED",
        message: error instanceof Error
          ? `HKEX returned invalid JSON: ${error.message}`
          : "HKEX returned invalid JSON",
        retryable: false,
      });
    }
    const filing = parseFilings(parsed)
      .filter((candidate) =>
        candidate.title.toLowerCase().includes(title.toLowerCase())
        && isFullFiling(candidate, request, query)
      )
      .sort((left, right) =>
        Date.parse(publishedAt(right.dateTime))
          - Date.parse(publishedAt(left.dateTime))
        || right.newsId.localeCompare(left.newsId)
      )[0];
    return { ...(filing === undefined ? {} : { filing }), snapshot };
  }

  private async findFiling(
    request: ProviderRequest,
    stockId: number,
    query: FilingQuery,
    context: ProviderContext,
  ): Promise<{ filing?: Filing; snapshots: StoredSnapshotRef[] }> {
    const report = await this.searchFiling(
      request,
      stockId,
      query,
      query.reportKeyword,
      context,
    );
    if (report.filing !== undefined) {
      return { filing: report.filing, snapshots: [report.snapshot] };
    }
    const result = await this.searchFiling(
      request,
      stockId,
      query,
      query.resultKeyword,
      context,
    );
    return {
      ...(result.filing === undefined ? {} : { filing: result.filing }),
      snapshots: [report.snapshot, result.snapshot],
    };
  }

  private async findDividendFilings(
    request: ProviderRequest,
    stockId: number,
    context: ProviderContext,
  ): Promise<{ filings: Filing[]; snapshot: StoredSnapshotRef }> {
    const requestedYears = requestedDividendYears(request.requirements);
    const asOfYear = Number(hongKongDate(request.asOf).slice(0, 4));
    const fromYear = requestedYears === undefined
      ? Math.max(1990, asOfYear - 10)
      : Math.min(...requestedYears);
    const sourceUrl = this.url(
      "search/titleSearchServlet.do",
      new URLSearchParams({
        sortDir: "0",
        sortByOptions: "DateTime",
        category: "0",
        market: "SEHK",
        stockId: String(stockId),
        documentType: "-1",
        fromDate: `${fromYear}0101`,
        toDate: compactDate(hongKongDate(request.asOf)),
        title: "dividend",
        searchType: "0",
        t1code: "-2",
        t2Gcode: "-2",
        t2code: "-2",
        rowRange: "100",
        lang: "EN",
      }),
    );
    const { text, snapshot } = await this.requestText(
      sourceUrl,
      "json",
      context,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderFailure({
        providerId: this.providerId,
        code: "UPSTREAM_SCHEMA_CHANGED",
        message: error instanceof Error
          ? `HKEX returned invalid dividend JSON: ${error.message}`
          : "HKEX returned invalid dividend JSON",
        retryable: false,
      });
    }
    const filings = parseFilings(parsed).filter((filing) => {
      const stockCodes = filing.stockCode.split(/\s+/);
      return filing.fileType.toUpperCase() === "PDF"
        && stockCodes.includes(request.instrument.symbol)
        && /(?:FINAL|INTERIM|SPECIAL)\s+DIVIDEND\s+FOR\b/.test(
          filing.title.toUpperCase(),
        )
        && !/SUPPLEMENT|CLARIFICATION|NOTICE|NOTIFICATION|CANCEL/.test(
          filing.title.toUpperCase(),
        )
        && Date.parse(publishedAt(filing.dateTime)) <= Date.parse(request.asOf)
        && (
          requestedYears === undefined
          || [...requestedYears].some((year) =>
            filing.title.includes(String(year))
          )
        );
    });
    return { filings, snapshot };
  }

  private async readFiling(
    filing: Filing,
    context: ProviderContext,
  ): Promise<{
    pages?: string[];
    issue?: ProviderIssue;
    snapshot: StoredSnapshotRef;
    sourceUrl: string;
  }> {
    const sourceUrl = this.url(filing.fileLink);
    const bytes = await fetchBytes(sourceUrl, {
      providerId: this.providerId,
      signal: context.signal,
      ...(this.options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.options.fetchImplementation }),
      headers: {
        Referer: this.url("search/titlesearch.xhtml?lang=en"),
        "User-Agent": USER_AGENT,
      },
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
    try {
      return {
        pages: await (
          this.options.extractTextImplementation ?? defaultExtractText
        )(bytes),
        snapshot,
        sourceUrl,
      };
    } catch (error) {
      return {
        issue: {
          providerId: this.providerId,
          code: "OFFICIAL_DOCUMENT_UNREADABLE",
          message: error instanceof Error
            ? `Failed to read HKEX PDF: ${error.message}`
            : "Failed to read HKEX PDF",
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
        jurisdiction: "HK",
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
        message: "Offline mode does not access HKEX",
        retryable: false,
      });
      return buildBatch();
    }
    if (request.instrument.exchangeMic !== "XHKG") {
      issues.push({
        providerId: this.providerId,
        code: "UNSUPPORTED_INSTRUMENT",
        message:
          `HKEX Provider supports XHKG, not ${request.instrument.exchangeMic}`,
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
        message:
          "HKEX supports calendar-year annual and first-half YTD financial periods",
        retryable: false,
      });
      return buildBatch();
    }

    let resolved: Awaited<ReturnType<HkexProvider["resolveCompany"]>>;
    try {
      resolved = await this.resolveCompany(request, context);
      legalName = resolved.result.name;
      rawSnapshots.push(resolved.snapshot);
    } catch (error) {
      issues.push(error instanceof ProviderFailure
        ? error.issue
        : {
            providerId: this.providerId,
            code: "PARSE_FAILED",
            message: error instanceof Error
              ? error.message
              : "Failed to resolve HKEX company",
            retryable: false,
          });
      return buildBatch();
    }

    if (requestsDividends) {
      try {
        const found = await this.findDividendFilings(
          request,
          resolved.result.stockId,
          context,
        );
        rawSnapshots.push(found.snapshot);
        if (found.filings.length === 0) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message:
              "HKEX has no official cash dividend announcement for the request",
            retryable: false,
          });
        }
        const components: DividendComponent[] = [];
        for (const candidate of found.filings) {
          const filing = await this.readFiling(candidate, context);
          rawSnapshots.push(filing.snapshot);
          if (filing.issue !== undefined || filing.pages === undefined) {
            throw new ProviderFailure(filing.issue ?? {
              providerId: this.providerId,
              code: "OFFICIAL_DOCUMENT_UNREADABLE",
              message: "HKEX dividend PDF text was unavailable",
              retryable: false,
            });
          }
          const component = extractDividend(
            filing.pages,
            candidate,
            filing.snapshot,
            filing.sourceUrl,
          );
          if (component === undefined) {
            throw new ProviderFailure({
              providerId: this.providerId,
              code: "UPSTREAM_SCHEMA_CHANGED",
              message:
                `HKEX dividend announcement ${candidate.newsId} did not expose a supported calendar-year cash amount`,
              retryable: false,
            });
          }
          components.push(component);
        }
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
              "HKEX has no supported annual cash dividend for the request",
            retryable: false,
          });
        }
        for (const dividend of dividends) {
          const latest = dividend.components.at(-1)!;
          const period = dividendPeriod(dividend.fiscalYear);
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              newsIds: dividend.components.map((component) =>
                component.filing.newsId
              ),
              rawField: "Dividend declared",
              concept: "distribution.dividendPerShare",
              period,
              currency: dividend.currency,
            }),
            companyId: request.instrument.companyId,
            instrumentId: request.instrument.instrumentId,
            concept: "distribution.dividendPerShare",
            value: dividend.value,
            unit: `${dividend.currency}-per-share`,
            scale: "1",
            period,
            basis: {
              standard: "OTHER",
              scope: "standalone",
              presentation: "reported",
              attribution: "all-shareholders",
              currency: dividend.currency,
            },
            availability: {
              filingDate: dividend.availableAt.slice(0, 10),
              publishedAt: dividend.availableAt,
              sourceAsOf: dividend.availableAt,
              fetchedAt: context.now,
            },
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "official",
              documentId: latest.filing.newsId,
              sourceUrl: latest.sourceUrl,
              rawSnapshotId: latest.snapshot.snapshotId,
              rawField: "Dividend declared",
              extractionMethod: "pdf",
              fetchedAt: context.now,
              transformations: [
                {
                  transformId: "pdf-text-extract",
                  version: "1.0.0",
                  detail: "Extract text from official HKEX EF001 PDFs",
                },
                {
                  transformId: "parse-cash-dividend-per-share",
                  version: "1.0.0",
                  detail:
                    "Read the explicit currency and per-share amount from Dividend declared",
                },
                {
                  transformId: "aggregate-annual-cash-dividends",
                  version: "1.0.0",
                  detail:
                    `Sum ${dividend.components.length} official cash distribution(s) from HKEX document(s) ${dividend.components.map((component) => component.filing.newsId).join(", ")} assigned to fiscal year ${dividend.fiscalYear}`,
                },
                {
                  transformId: "shareholder-approval-availability",
                  version: "1.0.0",
                  detail:
                    "Use the later of the exact HKEX release time and date-only shareholder approval at end of day",
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
                : "Failed to parse HKEX dividends",
              retryable: false,
            });
      }
    }

    for (const query of queries) {
      try {
        const found = await this.findFiling(
          request,
          resolved.result.stockId,
          query,
          context,
        );
        rawSnapshots.push(...found.snapshots);
        if (found.filing === undefined) {
          issues.push({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message:
              `HKEX has no ${query.reportLabel} available as of ${request.asOf}`,
            retryable: false,
          });
          continue;
        }
        const filing = await this.readFiling(found.filing, context);
        rawSnapshots.push(filing.snapshot);
        if (filing.issue !== undefined || filing.pages === undefined) {
          issues.push(filing.issue ?? {
            providerId: this.providerId,
            code: "OFFICIAL_DOCUMENT_UNREADABLE",
            message: "HKEX PDF text was unavailable",
            retryable: false,
          });
          continue;
        }
        const extraction = extractFinancialValues(filing.pages);
        const releasedAt = publishedAt(found.filing.dateTime);
        for (const requirement of query.requirements) {
          const field = definitionsByConcept.get(requirement.conceptId)!;
          const value = extraction.values[requirement.conceptId];
          if (
            value === undefined
            || extraction.currency === undefined
            || extraction.scale === undefined
          ) {
            unmapped.push(UnmappedObservationSchema.parse({
              unmappedId: stableId("unmapped", {
                documentId: found.filing.newsId,
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
              documentId: found.filing.newsId,
              rawField: field.rawField,
              concept: field.concept,
              period,
            }),
            companyId: request.instrument.companyId,
            concept: field.concept,
            value,
            unit: extraction.currency,
            scale: extraction.scale,
            period,
            basis: {
              standard: extraction.standard,
              scope: "consolidated",
              presentation: "reported",
              ...(field.attribution === undefined
                ? {}
                : { attribution: field.attribution }),
              currency: extraction.currency,
            },
            availability: {
              filingDate: releasedAt.slice(0, 10),
              publishedAt: releasedAt,
              sourceAsOf: releasedAt,
              fetchedAt: context.now,
            },
            provenance: {
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              sourceType: "official",
              documentId: found.filing.newsId,
              sourceUrl: filing.sourceUrl,
              rawSnapshotId: filing.snapshot.snapshotId,
              rawField: field.rawField,
              extractionMethod: "pdf",
              fetchedAt: context.now,
              transformations: [
                {
                  transformId: "pdf-text-extract",
                  version: "1.0.0",
                  detail: "Extract text from the official HKEX PDF with unpdf",
                },
                {
                  transformId: "consolidated-statement-label-match",
                  version: "1.0.0",
                  detail:
                    "Read the current-period value only inside consolidated statement boundaries",
                },
                {
                  transformId: "statement-header-scale",
                  version: "1.0.0",
                  detail:
                    `Preserve the reported ${extraction.currency} scale ${extraction.scale}`,
                },
                ...(field.concept === "cashFlow.capex"
                  ? [{
                      transformId: "sum-capex-components",
                      version: "1.0.0",
                      detail:
                        "Sum reported property/equipment and intangible-asset cash outflows when presented separately",
                    }]
                  : []),
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
                : `Failed to parse HKEX ${query.reportLabel}`,
              retryable: false,
            });
      }
    }
    return buildBatch();
  }
}
