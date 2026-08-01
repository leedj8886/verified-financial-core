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
const MAPPING_VERSION = "cninfo@1.9.0";
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

interface ShareChange {
  disclosureDate: string;
  effectiveDate: string;
  reason?: string;
  totalShares: string;
}

type StatementKind = "balance" | "income" | "cashFlow";

interface FieldDefinition {
  concept: ConceptId;
  statement: StatementKind;
  rawField: string;
  labels: RegExp[];
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

export interface PdfOcrMetadata {
  engine: string;
  version: string;
  language: string;
  pageNumbers: number[];
}

export interface PdfTextExtractionResult {
  pages: string[];
  ocr?: PdfOcrMetadata;
}

export type PdfTextExtractor = (
  data: Uint8Array<ArrayBuffer>,
) => Promise<string[] | PdfTextExtractionResult>;

export interface CninfoProviderOptions {
  fetchImplementation?: FetchImplementation;
  extractTextImplementation?: PdfTextExtractor;
  retries?: number;
  timeoutMs?: number;
  apiBase?: string;
  webapiBase?: string;
  pdfBase?: string;
}

export interface FinancialExtractionPeriod {
  fiscalYear: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  presentation: "annual" | "ytd";
}

export interface FinancialExtractionEvidence {
  pageNumber: number;
  rawSnippet: string;
  scale: string;
}

export type FinancialExtractionFailure =
  | "STATEMENT_NOT_FOUND"
  | "STATEMENT_IMAGE_ONLY"
  | "TEXT_ENCODING_UNUSABLE"
  | "OCR_TEXT_UNUSABLE"
  | "COLUMN_LAYOUT_AMBIGUOUS"
  | "LABEL_NOT_FOUND";

export interface FinancialColumnExtraction {
  current: Partial<Record<ConceptId, string>>;
  comparative: Partial<Record<ConceptId, string>>;
  currentEvidence: Partial<Record<ConceptId, FinancialExtractionEvidence>>;
  comparativeEvidence: Partial<
    Record<ConceptId, FinancialExtractionEvidence>
  >;
  failures: Partial<Record<ConceptId, FinancialExtractionFailure>>;
}

const fieldDefinitions: readonly FieldDefinition[] = [
  {
    concept: "income.revenue",
    statement: "income",
    rawField: "合并利润表.营业总收入",
    labels: [
      /一、?营业总收入/,
      /营业总收入/,
      /一、?营业收入/,
      /营业收入/,
    ],
  },
  {
    concept: "income.operatingProfit",
    statement: "income",
    rawField: "合并利润表.营业利润",
    labels: [
      /三、?营业利润/,
      /营业利润/,
    ],
  },
  {
    concept: "income.netProfit",
    statement: "income",
    rawField: "合并利润表.净利润",
    labels: [
      /五、?净利润/,
      /净利润/,
    ],
  },
  {
    concept: "income.netProfitParent",
    statement: "income",
    rawField: "合并利润表.归属于母公司股东的净利润",
    labels: [
      /归属于母公司(?:股东|所有者(?:\s*(?:[（(]或股东[）)]|\/股东))?)的净(?:利润|亏损)/,
      /归属于上市公司股东的(?:净)?(?:利润|亏损)/,
    ],
    attribution: "parent",
  },
  {
    concept: "balance.assets",
    statement: "balance",
    rawField: "合并资产负债表.资产总计",
    labels: [/资产总计/],
  },
  {
    concept: "balance.liabilities",
    statement: "balance",
    rawField: "合并资产负债表.负债合计",
    labels: [
      /(?<!流动)(?<!非流动)负债合计/,
    ],
  },
  {
    concept: "balance.equity",
    statement: "balance",
    rawField: "合并资产负债表.所有者权益合计",
    labels: [
      /所有者权益(?:\(或股东权益\))?合计/,
    ],
    attribution: "all-shareholders",
  },
  {
    concept: "balance.cash",
    statement: "balance",
    rawField: "合并资产负债表.货币资金",
    labels: [/货币资金/],
  },
  {
    concept: "cashFlow.operatingCashFlow",
    statement: "cashFlow",
    rawField: "合并现金流量表.经营活动产生的现金流量净额",
    labels: [/经营活动产生的现金流量净额/],
  },
  {
    concept: "cashFlow.capex",
    statement: "cashFlow",
    rawField:
      "合并现金流量表.购建固定资产、无形资产和其他长期资产支付的现金",
    labels: [/购建固定资产、?无形资产和其他长期资产支付的现金/],
  },
] as const;

export const CNINFO_FIELD_MAPPINGS: readonly SourceFieldMapping[] = [
  {
    upstreamSchema: "p_stock2215",
    rawField: "records[].F003N",
    conceptId: "market.shares.outstanding",
    unit: "shares",
    scale: "10000",
    transformIds: [
      "point-in-time-share-ledger",
      "ten-thousand-shares",
      "announcement-date-end-of-day",
    ],
  },
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
    transformIds: [
      "pdf-text-extract",
      "consolidated-statement-column-match",
    ],
  })),
];

const definitionsByConcept = new Map(
  fieldDefinitions.map((field) => [field.concept, field]),
);

const statementBoundaries: Record<
  StatementKind,
  { starts: readonly string[]; ends: readonly string[] }
> = {
  balance: {
    starts: [
      "合并资产负债表",
      "合并及公司资产负债表",
      "合并及母公司资产负债表",
    ],
    ends: [
      "母公司资产负债表",
      "合并利润表",
      "合并及公司利润表",
      "合并及母公司利润表",
    ],
  },
  income: {
    starts: [
      "合并利润表",
      "合并及公司利润表",
      "合并及母公司利润表",
    ],
    ends: [
      "母公司利润表",
      "合并现金流量表",
      "合并及公司现金流量表",
      "合并及母公司现金流量表",
    ],
  },
  cashFlow: {
    starts: [
      "合并现金流量表",
      "合并及公司现金流量表",
      "合并及母公司现金流量表",
    ],
    ends: [
      "母公司现金流量表",
      "合并所有者权益变动表",
      "合并及公司所有者权益变动表",
      "合并及母公司所有者权益变动表",
    ],
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

function parseShareChanges(value: unknown): ShareChange[] {
  const object = asObject(value, "CNINFO share-change response is invalid");
  if (Number(object["resultcode"]) !== 200) {
    throw new Error(
      asString(object["resultmsg"]) ?? "CNINFO share-change request failed",
    );
  }
  const records = object["records"];
  if (!Array.isArray(records)) {
    throw new Error("CNINFO share-change records are invalid");
  }
  return records.flatMap((item): ShareChange[] => {
    const record = asObject(item, "CNINFO share-change record is invalid");
    const disclosureDate = isoDate(record["DECLAREDATE"]);
    const effectiveDate = isoDate(record["VARYDATE"]);
    const totalShares = exactDecimal(record["F003N"]);
    const reason = asString(record["F002V"]);
    if (
      disclosureDate === undefined
      || effectiveDate === undefined
      || totalShares === undefined
      || new Decimal(totalShares).lte(0)
    ) {
      return [];
    }
    return [{
      disclosureDate,
      effectiveDate,
      totalShares,
      ...(reason === undefined ? {} : { reason }),
    }];
  });
}

function selectPointInTimeShares(
  changes: readonly ShareChange[],
  asOf: string,
): ShareChange | undefined {
  const targetDate = chinaDate(asOf);
  return changes
    .filter((change) =>
      change.effectiveDate <= targetDate
      && change.disclosureDate <= targetDate
    )
    .sort((left, right) =>
      right.effectiveDate.localeCompare(left.effectiveDate)
      || right.disclosureDate.localeCompare(left.disclosureDate)
    )[0];
}

function marketInstantPeriod(
  requirement: FactRequirement,
  asOf: string,
): ReportingPeriod {
  const endDate = chinaDate(asOf);
  const selector = requirement.period;
  return {
    kind: "instant",
    endDate,
    fiscalYear: selector?.fiscalYear ?? Number(endDate.slice(0, 4)),
    ...(selector?.fiscalQuarter === undefined
      ? {}
      : { fiscalQuarter: selector.fiscalQuarter }),
    presentation: selector?.presentation ?? "annual",
  };
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

function comparativeRequirements(
  requirements: readonly FactRequirement[],
  query: FilingQuery,
): FactRequirement[] {
  return requirements.filter((requirement) => {
    const period = requirement.period;
    return definitionsByConcept.has(requirement.conceptId)
      && period !== undefined
      && period.fiscalYear === query.fiscalYear - 1
      && period.fiscalQuarter === query.fiscalQuarter
      && period.presentation === query.presentation;
  });
}

function normalizePdfText(value: string): string {
  return value.normalize("NFKC")
    .replace(/[−–—－]/g, "-")
    .replace(/\r\n?/g, "\n")
    .replace(
      /(?<=[\p{Script=Han}])[^\S\n]+(?=[\p{Script=Han}])/gu,
      "",
    )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface StatementCandidate {
  pageNumber: number;
  text: string;
  labelText: string;
  labelOffsets: number[];
  financialColumnCount: 2 | 4;
  pageOffsets: Array<{ offset: number; pageNumber: number }>;
}

const DECIMAL_TOKEN =
  /(?:\(\s*\+?\s*\d[\d,]*(?:\.\d+)?\s*\)|[+-]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactHeadingPattern(headings: readonly string[]): RegExp {
  return new RegExp(
    `^\\s*(?:[一二三四五六七八九十\\d]+[、.．]\\s*)?`
    + `(?:截至[^\\n]{0,80}?期间\\s*)?`
    + `(${headings.map(escapeRegExp).join("|")})`
    + `(?:\\s*[（(][^\\n]*[）)])?\\s*$`,
    "m",
  );
}

function labelProjection(text: string): {
  labelText: string;
  labelOffsets: number[];
} {
  let labelText = "";
  const labelOffsets: number[] = [];
  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset]!;
    if (character === "\n") continue;
    labelText += character;
    labelOffsets.push(offset);
  }
  return { labelText, labelOffsets };
}

function statementCandidates(
  pages: readonly string[],
  statement: StatementKind,
): StatementCandidate[] {
  const boundary = statementBoundaries[statement];
  const startPattern = exactHeadingPattern(boundary.starts);
  const endPattern = exactHeadingPattern(boundary.ends);
  const candidates: StatementCandidate[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!.normalize("NFKC");
    const start = startPattern.exec(page);
    if (start === null) continue;
    const sectionPages: string[] = [page.slice(start.index)];
    for (
      let nextPageIndex = pageIndex + 1;
      nextPageIndex < pages.length
        && nextPageIndex <= pageIndex + 12;
      nextPageIndex += 1
    ) {
      const nextPage = pages[nextPageIndex]!.normalize("NFKC");
      const end = endPattern.exec(nextPage);
      if (end !== null) {
        sectionPages.push(nextPage.slice(0, end.index));
        break;
      }
      sectionPages.push(nextPage);
    }
    const firstPageEnd = endPattern.exec(sectionPages[0]!);
    if (firstPageEnd !== null) {
      sectionPages[0] = sectionPages[0]!.slice(0, firstPageEnd.index);
    }
    const normalizedPages = sectionPages.map(normalizePdfText);
    const pageOffsets: StatementCandidate["pageOffsets"] = [];
    let text = "";
    for (const [offset, normalizedPage] of normalizedPages.entries()) {
      if (text.length > 0) text += "\n";
      pageOffsets.push({
        offset: text.length,
        pageNumber: pageIndex + offset + 1,
      });
      text += normalizedPage;
    }
    candidates.push({
      pageNumber: pageIndex + 1,
      text,
      ...labelProjection(text),
      financialColumnCount: /合并及(?:母)?公司/.test(start[1] ?? "")
        ? 4
        : 2,
      pageOffsets,
    });
  }
  return candidates;
}

function hasImageOnlyFinancialStatements(
  pages: readonly string[],
  expectedPeriod: FinancialExtractionPeriod | undefined,
): boolean {
  const backupIndex = pages.findIndex((page) =>
    /备查文件目录/.test(page.normalize("NFKC"))
  );
  if (backupIndex >= 0) {
    const notesOffset = pages.slice(backupIndex + 1).findIndex((page) =>
      /年度财务报表附注/.test(page.normalize("NFKC"))
    );
    if (notesOffset >= 0) {
      const notesIndex = backupIndex + notesOffset + 1;
      const blankPages = pages.slice(backupIndex + 1, notesIndex)
        .filter((page) => normalizePdfText(page).length === 0)
        .length;
      if (blankPages >= 3) return true;
    }
  }
  if (expectedPeriod?.presentation !== "annual") return false;
  const annualHeading = new RegExp(
    `${expectedPeriod.fiscalYear}\\s*年(?:年)?度?报告`,
  );
  if (!pages.some((page) => annualHeading.test(page.normalize("NFKC")))) {
    return false;
  }
  let longestBlankRun = 0;
  let currentBlankRun = 0;
  for (const page of pages) {
    if (normalizePdfText(page).length === 0) {
      currentBlankRun += 1;
      longestBlankRun = Math.max(longestBlankRun, currentBlankRun);
    } else {
      currentBlankRun = 0;
    }
  }
  return longestBlankRun >= 6;
}

function parseDecimalToken(raw: string): string {
  const normalized = raw.normalize("NFKC").replace(/[−–—－]/g, "-").trim();
  const parenthesized = normalized.startsWith("(")
    && normalized.endsWith(")");
  const unsigned = normalized
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .replaceAll(",", "")
    .replace(/\s+/g, "")
    .replace(/^\+/, "");
  return parenthesized && !unsigned.startsWith("-")
    ? `-${unsigned}`
    : unsigned;
}

function statementScale(text: string): string {
  const unit =
    /(?:金额)?单位(?:\s*[:：]\s*|\s*为\s*)(?:人民币)?\s*(百万元|万元|千元|元)/
      .exec(text.slice(0, 1200))?.[1];
  return {
    元: "1",
    千元: "1000",
    万元: "10000",
    百万元: "1000000",
  }[unit ?? "元"] ?? "1";
}

function startsNewStatementRow(line: string): boolean {
  return /^\s*(?:[一二三四五六七八九十]+[、.．]|\d+[.、．])/.test(line);
}

function numericLineAfterLabel(
  text: string,
  labelEnd: number,
): { line: string; end: number; tokens: RegExpMatchArray[] } | undefined {
  let cursor = labelEnd;
  for (let lineOffset = 0; lineOffset < 4; lineOffset += 1) {
    const lineEnd = text.indexOf("\n", cursor);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(cursor, end).trim();
    if (lineOffset > 0 && startsNewStatementRow(line)) return undefined;
    const tokens = [...line.matchAll(DECIMAL_TOKEN)];
    if (tokens.length > 0) return { line, end, tokens };
    if (lineEnd === -1) return undefined;
    cursor = lineEnd + 1;
  }
  return undefined;
}

function financialValueTokens(
  line: string,
  tokens: RegExpMatchArray[],
  financialColumnCount: 2 | 4,
): RegExpMatchArray[] {
  if (financialColumnCount === 4) {
    if (tokens.length >= financialColumnCount) {
      return tokens.slice(-financialColumnCount, -financialColumnCount + 2);
    }
    // Ownership-attribution rows can legitimately omit standalone-company
    // values even in a combined consolidated/company statement.
    return financialValueTokens(line, tokens, 2);
  }
  const first = tokens[0];
  if (first === undefined) return [];
  const prefix = line.slice(0, first.index ?? 0);
  const explicitNoteReference =
    /[一二三四五六七八九十]\s*$/.test(prefix)
    && /^\(\s*\d{1,3}\s*\)$/.test(first[0]);
  const plainNoteReference = tokens.length === 3
    && /^\d{1,3}$/.test(first[0])
    && !/^\s*\//.test(
      line.slice((tokens[2]!.index ?? 0) + tokens[2]![0].length),
    );
  return tokens.slice(
    explicitNoteReference || plainNoteReference ? 1 : 0,
    explicitNoteReference || plainNoteReference ? 3 : 2,
  );
}

function extractRow(
  section: StatementCandidate,
  field: FieldDefinition,
): {
  current?: string;
  comparative?: string;
  currentEvidence?: FinancialExtractionEvidence;
  comparativeEvidence?: FinancialExtractionEvidence;
  detailReasonCode?: FinancialExtractionFailure;
} {
  let matchedLabel = false;
  for (const label of field.labels) {
    const match = label.exec(section.labelText);
    if (match === null) continue;
    matchedLabel = true;
    const matchStart = section.labelOffsets[match.index];
    const matchEnd = section.labelOffsets[
      match.index + match[0].length - 1
    ];
    if (matchStart === undefined || matchEnd === undefined) continue;
    const numericLine = numericLineAfterLabel(
      section.text,
      matchEnd + 1,
    );
    if (numericLine === undefined) continue;
    // Some issuers render the statement note as `四 (41)` while others render
    // it as a plain `39`. Keep that column out of the two financial columns
    // without treating a trailing PDF page counter as an inline note.
    const tokens = financialValueTokens(
      numericLine.line,
      numericLine.tokens,
      section.financialColumnCount,
    );
    const current = tokens[0];
    if (current === undefined) continue;
    const rawSnippet = section.text.slice(matchStart, numericLine.end).trim();
    const pageNumber = [...section.pageOffsets]
      .reverse()
      .find((item) => item.offset <= matchStart)?.pageNumber
      ?? section.pageNumber;
    const scale = statementScale(section.text);
    return {
      current: parseDecimalToken(current[0]),
      currentEvidence: {
        pageNumber,
        rawSnippet,
        scale,
      },
      ...(tokens[1] === undefined
        ? {}
        : {
            comparative: parseDecimalToken(tokens[1]![0]),
            comparativeEvidence: {
              pageNumber,
              rawSnippet,
              scale,
            },
          }),
    };
  }
  return {
    detailReasonCode: matchedLabel
      ? "COLUMN_LAYOUT_AMBIGUOUS"
      : "LABEL_NOT_FOUND",
  };
}

function expectedPeriodTokens(period: FinancialExtractionPeriod): string[] {
  if (period.presentation === "annual") {
    return [
      `${period.fiscalYear}年度`,
      `${period.fiscalYear}年1-12月`,
      `${period.fiscalYear}年1—12月`,
      `${period.fiscalYear}年12月31日`,
    ];
  }
  const quarter = period.fiscalQuarter;
  if (quarter === undefined) return [`${period.fiscalYear}年`];
  const quarterTokens = {
    1: ["第一季度", "1-3月", "1—3月", "3月31日"],
    2: ["半年度", "1-6月", "1—6月", "6月30日"],
    3: ["第三季度", "1-9月", "1—9月", "9月30日"],
    4: ["年度", "1-12月", "1—12月", "12月31日"],
  }[quarter];
  return quarterTokens.map((token) => `${period.fiscalYear}年${token}`);
}

function selectStatement(
  pages: readonly string[],
  statement: StatementKind,
  expectedPeriod: FinancialExtractionPeriod | undefined,
): StatementCandidate | undefined {
  const fields = fieldDefinitions.filter((field) =>
    field.statement === statement
  );
  return statementCandidates(pages, statement)
    .map((candidate) => {
      const coverage = fields.filter((field) =>
        extractRow(candidate, field).current !== undefined
      ).length;
      const periodScore = expectedPeriod === undefined
        ? 0
        : expectedPeriodTokens(expectedPeriod).some((token) =>
            candidate.text.includes(token)
          )
          ? 100
          : 0;
      const correctionPenalty =
        /更正前\s+更正金额\s+更正后/.test(candidate.text.slice(0, 800))
          ? 200
          : 0;
      return {
        candidate,
        score: periodScore + coverage * 10 - correctionPenalty,
      };
    })
    .sort((left, right) =>
      right.score - left.score
      || left.candidate.pageNumber - right.candidate.pageNumber
    )[0]?.candidate;
}

export function extractFinancialColumns(
  pages: readonly string[],
  expectedPeriod?: FinancialExtractionPeriod,
): FinancialColumnExtraction {
  const sections = new Map<StatementKind, StatementCandidate | undefined>();
  const result: FinancialColumnExtraction = {
    current: {},
    comparative: {},
    currentEvidence: {},
    comparativeEvidence: {},
    failures: {},
  };
  const imageOnlyStatements = hasImageOnlyFinancialStatements(
    pages,
    expectedPeriod,
  );
  for (const field of fieldDefinitions) {
    if (!sections.has(field.statement)) {
      sections.set(
        field.statement,
        selectStatement(pages, field.statement, expectedPeriod),
      );
    }
    const section = sections.get(field.statement);
    if (section === undefined) {
      result.failures[field.concept] = imageOnlyStatements
        ? "STATEMENT_IMAGE_ONLY"
        : "STATEMENT_NOT_FOUND";
      continue;
    }
    const extracted = extractRow(section, field);
    if (extracted.current !== undefined) {
      result.current[field.concept] = extracted.current;
      if (extracted.currentEvidence !== undefined) {
        result.currentEvidence[field.concept] = extracted.currentEvidence;
      }
    }
    if (extracted.comparative !== undefined) {
      result.comparative[field.concept] = extracted.comparative;
      if (extracted.comparativeEvidence !== undefined) {
        result.comparativeEvidence[field.concept] =
          extracted.comparativeEvidence;
      }
    }
    if (
      extracted.current === undefined
      && extracted.detailReasonCode !== undefined
    ) {
      result.failures[field.concept] = extracted.detailReasonCode;
    }
  }
  return result;
}

export function extractFinancialValues(
  pages: readonly string[],
  expectedPeriod?: FinancialExtractionPeriod,
): Partial<Record<ConceptId, string>> {
  return extractFinancialColumns(pages, expectedPeriod).current;
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
  const matchesReportLabel = query.presentation === "annual"
    ? (
        announcement.announcementTitle.includes(
          `${query.fiscalYear}年度报告`,
        )
        || announcement.announcementTitle.includes(
          `${query.fiscalYear}年年度报告`,
        )
      )
    : announcement.announcementTitle.includes(query.reportLabel);
  return announcement.adjunctType.toUpperCase() === "PDF"
    && matchesReportLabel
    && !/摘要|英文|取消|更正公告|提示性公告/.test(
      announcement.announcementTitle,
    )
    && Date.parse(publishedAtEndOfDay(announcement.announcementTime))
      <= Date.parse(asOf);
}

function mainlandReportPreference(announcement: Announcement): number {
  // CNINFO can return a later H-share/overseas filing beside the primary
  // A-share report. Prefer the mainland filing while retaining the overseas
  // document as a fail-closed fallback when it is the only available report.
  return /H股公告|海外监管公告|境外监管公告/.test(
      announcement.announcementTitle,
    )
    ? 0
    : 1;
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
  readonly capabilities = [
    "financials",
    "filings",
    "dividends",
    "market",
  ] as const;
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

  private async requestShareChanges(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<{ parsed: unknown; snapshot: StoredSnapshotRef; sourceUrl: string }> {
    const sourceUrl = this.webapiUrl(
      "api/stock/p_stock2215"
      + `?scode=${encodeURIComponent(request.instrument.symbol)}`
      + `&sdate=1990-01-01&edate=${chinaDate(request.asOf)}`,
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
          ? `CNINFO returned invalid share-change JSON: ${error.message}`
          : "CNINFO returned invalid share-change JSON",
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
        mainlandReportPreference(right) - mainlandReportPreference(left)
        || right.announcementTime - left.announcementTime
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
    ocr?: {
      metadata: PdfOcrMetadata;
      snapshot: StoredSnapshotRef;
    };
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
      const extracted = await extractor(bytes);
      const result = Array.isArray(extracted)
        ? { pages: extracted }
        : extracted;
      const pageNumbers = result.ocr === undefined
        ? []
        : [...new Set(result.ocr.pageNumbers)]
          .filter((pageNumber) =>
            Number.isInteger(pageNumber)
            && pageNumber >= 1
            && pageNumber <= result.pages.length
          )
          .sort((left, right) => left - right);
      const ocr = result.ocr === undefined || pageNumbers.length === 0
        ? undefined
        : {
            ...result.ocr,
            pageNumbers,
          };
      const ocrSnapshot = ocr === undefined
        ? undefined
        : await context.snapshots.put({
            providerId: this.providerId,
            sourceUrl: `${sourceUrl}#ocr-text`,
            mediaType: "text",
            fetchedAt: context.now,
            body: JSON.stringify({
              format: "verified-financial-cninfo-ocr/v1",
              sourceSnapshotId: snapshot.snapshotId,
              ...ocr,
              pages: pageNumbers.map((pageNumber) => ({
                pageNumber,
                text: result.pages[pageNumber - 1]!,
              })),
            }),
          });
      return {
        pages: result.pages,
        ...(ocr === undefined || ocrSnapshot === undefined
          ? {}
          : {
              ocr: {
                metadata: ocr,
                snapshot: ocrSnapshot,
              },
            }),
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
    const shareRequirements = [...new Map(
      request.requirements
        .filter((requirement) =>
          requirement.conceptId === "market.shares.outstanding"
        )
        .map((requirement) => [
          JSON.stringify(requirement.period ?? null),
          requirement,
        ]),
    ).values()];
    if (
      queries.length === 0
      && !requestsDividends
      && shareRequirements.length === 0
    ) {
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

    if (shareRequirements.length > 0) {
      try {
        const response = await this.requestShareChanges(request, context);
        rawSnapshots.push(response.snapshot);
        const shares = selectPointInTimeShares(
          parseShareChanges(response.parsed),
          request.asOf,
        );
        if (shares === undefined) {
          throw new ProviderFailure({
            providerId: this.providerId,
            code: "EMPTY_RESPONSE",
            message:
              `CNINFO has no disclosed effective share count as of ${request.asOf}`,
            retryable: false,
          });
        }
        for (const requirement of shareRequirements) {
          const period = marketInstantPeriod(requirement, request.asOf);
          const publishedAt = `${shares.disclosureDate}T23:59:59+08:00`;
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              snapshotId: response.snapshot.snapshotId,
              rawField: "records[].F003N",
              concept: "market.shares.outstanding",
              period,
              effectiveDate: shares.effectiveDate,
              disclosureDate: shares.disclosureDate,
            }),
            companyId: request.instrument.companyId,
            instrumentId: request.instrument.instrumentId,
            concept: "market.shares.outstanding",
            value: shares.totalShares,
            unit: "shares",
            scale: "10000",
            period,
            basis: {
              standard: "OTHER",
              scope: "standalone",
              presentation: "reported",
              attribution: "all-shareholders",
              currency: request.instrument.tradingCurrency,
            },
            availability: {
              effectiveDate: shares.effectiveDate,
              filingDate: shares.disclosureDate,
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
              rawField: "records[].F003N",
              extractionMethod: "api",
              fetchedAt: context.now,
              transformations: [
                {
                  transformId: "point-in-time-share-ledger",
                  version: "1.0.0",
                  detail: [
                    `Select latest record effective by ${chinaDate(request.asOf)}`,
                    `and disclosed by ${chinaDate(request.asOf)}`,
                    shares.reason === undefined
                      ? undefined
                      : `change reason: ${shares.reason}`,
                  ].filter((item) => item !== undefined).join("; "),
                },
                {
                  transformId: "ten-thousand-shares",
                  version: "1.0.0",
                  detail: "CNINFO F003N is reported in ten thousand shares",
                },
                {
                  transformId: "announcement-date-end-of-day",
                  version: "1.0.0",
                  detail:
                    "Treat a date-only CNINFO disclosure date as available at end of day",
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
                : "Failed to parse CNINFO share changes",
              retryable: false,
            });
      }
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
            reasonCode: "REPORT_NOT_AVAILABLE_AS_OF",
            requirements: query.requirements,
          });
          continue;
        }
        const announcement = found.announcement;
        const filing = await this.readFiling(announcement, context);
        rawSnapshots.push(filing.snapshot);
        if (filing.ocr !== undefined) {
          rawSnapshots.push(filing.ocr.snapshot);
        }
        if (filing.issue !== undefined || filing.pages === undefined) {
          issues.push(filing.issue ?? {
            providerId: this.providerId,
            code: "OFFICIAL_DOCUMENT_UNREADABLE",
            message: "CNINFO PDF text was unavailable",
            retryable: false,
          });
          continue;
        }
        const extraction = extractFinancialColumns(filing.pages, query);
        const filingDate = chinaDate(announcement.announcementTime);
        const publishedAt = publishedAtEndOfDay(
          announcement.announcementTime,
        );
        const emitObservation = (
          requirement: FactRequirement,
          column: "current" | "comparative",
        ): void => {
          const field = definitionsByConcept.get(requirement.conceptId)!;
          const values = column === "current"
            ? extraction.current
            : extraction.comparative;
          const evidence = (
            column === "current"
              ? extraction.currentEvidence
              : extraction.comparativeEvidence
          )[requirement.conceptId];
          const value = values[requirement.conceptId];
          if (value === undefined) {
            if (column === "comparative") return;
            const extractionReasonCode = extraction.failures[
              requirement.conceptId
            ] ?? "LABEL_NOT_FOUND";
            const detailReasonCode: FinancialExtractionFailure =
              filing.ocr !== undefined
                && extractionReasonCode !== "STATEMENT_IMAGE_ONLY"
                ? "OCR_TEXT_UNUSABLE"
                : extractionReasonCode;
            unmapped.push(UnmappedObservationSchema.parse({
              unmappedId: stableId("unmapped", {
                documentId: announcement.announcementId,
                rawField: field.rawField,
                requirement,
              }),
              providerId: this.providerId,
              upstreamSourceId: this.upstreamSourceId,
              rawSnapshotId: filing.ocr?.snapshot.snapshotId
                ?? filing.snapshot.snapshotId,
              rawField: field.rawField,
              rawValue: null,
              reasonCode: "UNMAPPED_SOURCE_FIELD",
              intendedConceptId: requirement.conceptId,
              intendedPeriod: statementPeriod(
                column === "current"
                  ? query
                  : { ...query, fiscalYear: query.fiscalYear - 1 },
                field.statement === "balance" ? "instant" : "duration",
              ),
            }));
            issues.push({
              providerId: this.providerId,
              code: "PARSE_FAILED",
              message: `${detailReasonCode}: ${field.rawField}`,
              retryable: false,
              reasonCode: detailReasonCode,
              requirements: [requirement],
            });
            return;
          }
          const periodQuery = column === "current"
            ? query
            : { ...query, fiscalYear: query.fiscalYear - 1 };
          const period = statementPeriod(
            periodQuery,
            field.statement === "balance" ? "instant" : "duration",
          );
          const usesOcr = evidence !== undefined
            && filing.ocr?.metadata.pageNumbers.includes(
              evidence.pageNumber,
            ) === true;
          const evidenceSnapshot = usesOcr
            ? filing.ocr!.snapshot
            : filing.snapshot;
          observations.push(ObservationSchema.parse({
            observationId: stableId("obs", {
              providerId: this.providerId,
              documentId: announcement.announcementId,
              rawField: field.rawField,
              concept: field.concept,
              period,
              column,
            }),
            companyId: request.instrument.companyId,
            concept: field.concept,
            value,
            unit: "CNY",
            scale: evidence?.scale ?? "1",
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
              documentId: announcement.announcementId,
              sourceUrl: evidenceSnapshot.sourceUrl,
              rawSnapshotId: evidenceSnapshot.snapshotId,
              rawField: column === "current"
                ? field.rawField
                : `${field.rawField}.上年同期`,
              extractionMethod: "pdf",
              fetchedAt: context.now,
              transformations: [
                ...(usesOcr
                  ? [
                      {
                        transformId: "pdf-page-render",
                        version: "1.0.0",
                        detail:
                          `Render PDF page ${evidence!.pageNumber} from source snapshot ${filing.snapshot.snapshotId}`,
                      },
                      {
                        transformId: "tesseract-ocr",
                        version: filing.ocr!.metadata.version,
                        detail:
                          `Recognize PDF page ${evidence!.pageNumber} with ${filing.ocr!.metadata.engine} language ${filing.ocr!.metadata.language}`,
                      },
                      {
                        transformId: "ocr-spatial-line-reconstruction",
                        version: "1.0.0",
                        detail:
                          "Rebuild statement rows from OCR text boxes using vertical alignment and left-to-right column order",
                      },
                    ]
                  : [{
                      transformId: "pdf-text-extract",
                      version: "1.0.0",
                      detail:
                        "Extract text with unpdf using bundled CJK maps",
                    }]),
                {
                  transformId: "consolidated-statement-column-match",
                  version: "4.0.0",
                  detail: [
                    `Read the ${column} column from the selected consolidated statement`,
                    evidence === undefined
                      ? undefined
                      : `PDF page ${evidence.pageNumber}: ${evidence.rawSnippet}`,
                  ].filter((item) => item !== undefined).join("; "),
                },
                ...(evidence?.scale === undefined || evidence.scale === "1"
                  ? []
                  : [{
                      transformId: "statement-unit-scale",
                      version: "1.0.0",
                      detail:
                        `Apply the statement unit scale ${evidence.scale} to canonical CNY`,
                    }]),
                ...(column === "comparative"
                  ? [{
                      transformId: "latest-filing-comparative-period",
                      version: "1.0.0",
                      detail:
                        `Use the ${query.fiscalYear} filing's reported comparative column for fiscal year ${query.fiscalYear - 1}`,
                    }]
                  : []),
                {
                  transformId: "announcement-date-end-of-day",
                  version: "1.0.0",
                  detail: "Treat a date-only CNINFO announcement timestamp as available at end of day",
                },
              ],
            },
          }));
        };
        for (const requirement of query.requirements) {
          emitObservation(requirement, "current");
        }
        for (
          const requirement of comparativeRequirements(
            request.requirements,
            query,
          )
        ) {
          emitObservation(requirement, "comparative");
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
