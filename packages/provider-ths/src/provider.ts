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
  type AccountingBasis,
  type ConceptId,
  type FactRequirement,
  type Observation,
  type ReportingPeriod,
} from "@verified-financial/schema";

const PROVIDER_ID = "ths-financial-direct";
const UPSTREAM_SOURCE_ID = "ths";
const MAPPING_VERSION = "ths-financial@1.0.1";
const FINANCE_ENDPOINT =
  "https://basic.10jqka.com.cn/basicapi/finance/index/v1/app_data/";

type JsonObject = Record<string, unknown>;
type StatementId =
  | "client_stock_benefit"
  | "client_stock_debt"
  | "client_stock_cash";

interface FieldDefinition {
  statement: StatementId;
  rawField: string;
  concept: ConceptId;
  attribution?: AccountingBasis["attribution"];
}

interface ThsReport {
  report: string;
  reportName: string;
  date: string;
  indexList: JsonObject;
  snapshotId: string;
  sourceUrl: string;
}

export interface ThsFinancialProviderOptions {
  fetchImplementation?: FetchImplementation;
  retries?: number;
  timeoutMs?: number;
  endpoint?: string;
  pageSize?: number;
}

const fieldDefinitions: readonly FieldDefinition[] = [
  {
    statement: "client_stock_benefit",
    rawField: "operating_income_total",
    concept: "income.revenue",
  },
  {
    statement: "client_stock_benefit",
    rawField: "operating_profit",
    concept: "income.operatingProfit",
  },
  {
    statement: "client_stock_benefit",
    rawField: "net_profit",
    concept: "income.netProfit",
    attribution: "all-shareholders",
  },
  {
    statement: "client_stock_benefit",
    rawField: "parent_holder_net_profit",
    concept: "income.netProfitParent",
    attribution: "parent",
  },
  {
    statement: "client_stock_debt",
    rawField: "assets_total",
    concept: "balance.assets",
  },
  {
    statement: "client_stock_debt",
    rawField: "total_debt",
    concept: "balance.liabilities",
  },
  {
    statement: "client_stock_debt",
    rawField: "holder_equity_total",
    concept: "balance.equity",
    attribution: "all-shareholders",
  },
  {
    statement: "client_stock_debt",
    rawField: "cash",
    concept: "balance.cash",
  },
  {
    statement: "client_stock_cash",
    rawField: "act_cash_flow_net",
    concept: "cashFlow.operatingCashFlow",
  },
  {
    statement: "client_stock_cash",
    rawField: "pay_fixed_assets_etc_cash",
    concept: "cashFlow.capex",
  },
] as const;

export const THS_FINANCIAL_FIELD_MAPPINGS: readonly SourceFieldMapping[] =
  fieldDefinitions.map((field) => ({
    upstreamSchema: `10jqka.finance.${field.statement}`,
    rawField: field.rawField,
    conceptId: field.concept,
    unit: "CNY",
    scale: "1",
    transformIds: ["current-view-no-filing-date"],
  }));

const definitionByConcept = new Map(
  fieldDefinitions.map((field) => [field.concept, field] as const),
);

function asObject(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as JsonObject;
}

function exactDecimal(value: unknown): string | undefined {
  return typeof value === "string"
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
    ? value
    : undefined;
}

function integer(value: unknown, message: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(message);
  return number;
}

function stableId(value: unknown): string {
  return `obs:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function marketCode(exchangeMic: ProviderRequest["instrument"]["exchangeMic"]):
  string | undefined {
  return {
    XSHG: "17",
    XSHE: "33",
    XBSE: "151",
    XHKG: undefined,
  }[exchangeMic];
}

function statementUrl(
  endpoint: string,
  request: ProviderRequest,
  statement: StatementId,
  page: number,
  pageSize: number,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("code", request.instrument.symbol);
  url.searchParams.set("id", statement);
  url.searchParams.set("market", marketCode(request.instrument.exchangeMic)!);
  url.searchParams.set("type", "stock");
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(pageSize));
  url.searchParams.set("period", "0");
  return url.toString();
}

function matchesRequirement(report: ThsReport, requirement: FactRequirement): boolean {
  const selector = requirement.period;
  if (selector === undefined) return true;
  if (Number(report.date.slice(0, 4)) !== selector.fiscalYear) return false;
  if (selector.presentation === "annual") return report.date.endsWith("12-31");
  const quarter = Number(report.report.split("-")[1]);
  return quarter === selector.fiscalQuarter;
}

function reportingPeriod(
  report: ThsReport,
  requirement: FactRequirement,
  statement: StatementId,
): ReportingPeriod {
  const year = Number(report.date.slice(0, 4));
  const quarter = Number(report.report.split("-")[1]) as 1 | 2 | 3 | 4;
  const presentation = requirement.period?.presentation
    ?? (quarter === 4 ? "annual" : "ytd");
  if (statement === "client_stock_debt") {
    return {
      kind: "instant",
      endDate: report.date,
      fiscalYear: year,
      ...(presentation === "annual" ? {} : { fiscalQuarter: quarter }),
      presentation,
    };
  }
  const startMonth = String((quarter - 1) * 3 + 1).padStart(2, "0");
  return {
    kind: "duration",
    startDate: presentation === "quarter"
      ? `${year}-${startMonth}-01`
      : `${year}-01-01`,
    endDate: report.date,
    fiscalYear: year,
    ...(presentation === "annual" ? {} : { fiscalQuarter: quarter }),
    presentation,
  };
}

function parseReports(
  payload: unknown,
  snapshotId: string,
  sourceUrl: string,
): { reports: ThsReport[]; page: number; size: number; total: number } {
  const root = asObject(payload, "THS response is not an object");
  if (root["status_code"] !== 0) {
    throw new Error(`THS returned status_code ${String(root["status_code"])}`);
  }
  const data = asObject(root["data"], "THS response data is missing");
  if (!Array.isArray(data["data"])) {
    throw new Error("THS report list is missing");
  }
  const reports = data["data"].map((value) => {
    const report = asObject(value, "THS report is not an object");
    const reportId = report["report"];
    const reportName = report["report_name"];
    const date = report["date"];
    if (
      typeof reportId !== "string"
      || typeof reportName !== "string"
      || typeof date !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      throw new Error("THS report metadata is invalid");
    }
    return {
      report: reportId,
      reportName,
      date,
      indexList: asObject(report["index_list"], "THS index_list is missing"),
      snapshotId,
      sourceUrl,
    };
  });
  return {
    reports,
    page: integer(data["page"], "THS page is invalid"),
    size: integer(data["size"], "THS page size is invalid"),
    total: integer(data["total"], "THS total is invalid"),
  };
}

export class ThsFinancialProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["financials"] as const;

  constructor(private readonly options: ThsFinancialProviderOptions = {}) {}

  supportsInstrument(
    instrument: ProviderRequest["instrument"],
  ): boolean {
    return marketCode(instrument.exchangeMic) !== undefined;
  }

  async fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch> {
    const observations: Observation[] = [];
    const rawSnapshots: ProviderBatch["rawSnapshots"] = [];
    const issues: ProviderIssue[] = [];
    const unmapped: ProviderBatch["unmapped"] = [];
    if (!this.supportsInstrument(request.instrument)) {
      issues.push({
        providerId: this.providerId,
        code: "UNSUPPORTED_INSTRUMENT",
        message: "THS financial tables support mainland A shares only",
        retryable: false,
        reasonCode: "THS_A_SHARE_ONLY",
      });
    } else if (request.offline) {
      issues.push({
        providerId: this.providerId,
        code: "EMPTY_RESPONSE",
        message: "Offline mode does not access THS",
        retryable: false,
        reasonCode: "CURRENT_VIEW_SOURCE_OFFLINE",
      });
    } else {
      const requestedDefinitions = request.requirements.flatMap((requirement) => {
        if (requirement.period?.presentation === "ttm") return [];
        const definition = definitionByConcept.get(requirement.conceptId);
        return definition === undefined ? [] : [{ definition, requirement }];
      });
      const statements = [...new Set(
        requestedDefinitions.map((item) => item.definition.statement),
      )];
      const reportsByStatement = new Map<StatementId, ThsReport[]>();
      try {
        for (const statement of statements) {
          const pageSize = this.options.pageSize ?? 50;
          const reports: ThsReport[] = [];
          let page = 1;
          let pageCount = 1;
          do {
            const sourceUrl = statementUrl(
              this.options.endpoint ?? FINANCE_ENDPOINT,
              request,
              statement,
              page,
              pageSize,
            );
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
                Referer: "https://basic.10jqka.com.cn/",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  + "AppleWebKit/537.36 (KHTML, like Gecko) "
                  + "Chrome/138.0.0.0 Safari/537.36",
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
            const parsed = parseReports(
              payload,
              snapshot.snapshotId,
              sourceUrl,
            );
            reports.push(...parsed.reports);
            pageCount = parsed.size === 0
              ? 1
              : Math.max(1, Math.ceil(parsed.total / parsed.size));
            page += 1;
          } while (page <= pageCount);
          reportsByStatement.set(statement, reports);
        }

        for (const { definition, requirement } of requestedDefinitions) {
          const matching = (reportsByStatement.get(definition.statement) ?? [])
            .filter((report) => matchesRequirement(report, requirement));
          for (const report of matching) {
            const rawFieldValue = report.indexList[definition.rawField];
            const field = typeof rawFieldValue === "object"
                && rawFieldValue !== null
                && !Array.isArray(rawFieldValue)
              ? rawFieldValue as JsonObject
              : undefined;
            const valueField = requirement.period?.presentation === "quarter"
              ? "single"
              : "value";
            const value = exactDecimal(field?.[valueField]);
            if (value === undefined) {
              unmapped.push({
                unmappedId: stableId({
                  providerId: this.providerId,
                  snapshotId: report.snapshotId,
                  field: definition.rawField,
                  requirement,
                }),
                providerId: this.providerId,
                upstreamSourceId: this.upstreamSourceId,
                rawSnapshotId: report.snapshotId,
                rawField: `${definition.rawField}.${valueField}`,
                rawValue: field?.[valueField] ?? rawFieldValue,
                reasonCode: "UNMAPPED_SOURCE_FIELD",
                intendedConceptId: definition.concept,
                ...(requirement.period === undefined
                  ? {}
                  : { intendedPeriod: reportingPeriod(
                      report,
                      requirement,
                      definition.statement,
                    ) }),
              });
              continue;
            }
            const period = reportingPeriod(
              report,
              requirement,
              definition.statement,
            );
            observations.push(ObservationSchema.parse({
              observationId: stableId({
                providerId: this.providerId,
                snapshotId: report.snapshotId,
                field: definition.rawField,
                valueField,
                concept: definition.concept,
                period,
              }),
              companyId: request.instrument.companyId,
              concept: definition.concept,
              value,
              unit: "CNY",
              scale: "1",
              period,
              basis: {
                standard: "CAS",
                scope: "consolidated",
                presentation: "reported",
                ...(definition.attribution === undefined
                  ? {}
                  : { attribution: definition.attribution }),
                currency: "CNY",
              },
              availability: {
                publishedAt: context.now,
                sourceAsOf: context.now,
                fetchedAt: context.now,
              },
              provenance: {
                providerId: this.providerId,
                upstreamSourceId: this.upstreamSourceId,
                sourceType: "aggregator",
                sourceUrl: report.sourceUrl,
                rawSnapshotId: report.snapshotId,
                rawField: `${definition.rawField}.${valueField}`,
                extractionMethod: "api",
                fetchedAt: context.now,
                transformations: [{
                  transformId: "current-view-no-filing-date",
                  version: "1.0.0",
                  detail:
                    "Treat THS as a current-view value with no asserted filing date or reporting version",
                }],
              },
            }));
          }
        }
      } catch (error) {
        issues.push(error instanceof ProviderFailure
          ? error.issue
          : {
              providerId: this.providerId,
              code: "PARSE_FAILED",
              message: error instanceof Error
                ? error.message
                : "Failed to parse THS financial tables",
              retryable: false,
              reasonCode: "THS_FINANCIAL_PARSE_FAILED",
            });
      }
    }

    return {
      providerId: this.providerId,
      upstreamSourceId: this.upstreamSourceId,
      company: {
        companyId: request.instrument.companyId,
        legalName: request.instrument.instrumentId,
        jurisdiction: "CN",
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
