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

const PROVIDER_ID = "baidu-hk-financial-direct";
const UPSTREAM_SOURCE_ID = "baidu";
const MAPPING_VERSION = "baidu-hk-financial@1.0.0";
const FINANCE_ENDPOINT = "https://finance.pae.baidu.com/api/stockwidget";

type JsonObject = Record<string, unknown>;
type SheetName =
  | "profitSheetV2"
  | "balanceSheetV2"
  | "cashFlowSheetV2";

interface FieldDefinition {
  sheet: SheetName;
  rawField: string;
  concept: ConceptId;
  attribution?: AccountingBasis["attribution"];
}

interface ParsedUnit {
  currency: string;
  scale: string;
}

interface SheetRow {
  sheet: SheetName;
  label: string;
  headers: string[];
  values: unknown[];
  unit: ParsedUnit;
}

export interface BaiduHkFinancialProviderOptions {
  fetchImplementation?: FetchImplementation;
  retries?: number;
  timeoutMs?: number;
  endpoint?: string;
}

const fieldDefinitions: readonly FieldDefinition[] = [
  { sheet: "profitSheetV2", rawField: "总营收", concept: "income.revenue" },
  {
    sheet: "profitSheetV2",
    rawField: "经营溢利",
    concept: "income.operatingProfit",
  },
  {
    sheet: "profitSheetV2",
    rawField: "除税后溢利",
    concept: "income.netProfit",
    attribution: "all-shareholders",
  },
  {
    sheet: "profitSheetV2",
    rawField: "股东应占溢利",
    concept: "income.netProfitParent",
    attribution: "parent",
  },
  { sheet: "balanceSheetV2", rawField: "总资产", concept: "balance.assets" },
  {
    sheet: "balanceSheetV2",
    rawField: "总负债",
    concept: "balance.liabilities",
  },
  {
    sheet: "balanceSheetV2",
    rawField: "总权益",
    concept: "balance.equity",
    attribution: "all-shareholders",
  },
  {
    sheet: "balanceSheetV2",
    rawField: "现金及等价物",
    concept: "balance.cash",
  },
  {
    sheet: "cashFlowSheetV2",
    rawField: "经营现金流",
    concept: "cashFlow.operatingCashFlow",
  },
] as const;

export const BAIDU_HK_FINANCIAL_FIELD_MAPPINGS:
  readonly SourceFieldMapping[] = fieldDefinitions.map((field) => ({
    upstreamSchema: `baidu.stockwidget.${field.sheet}`,
    rawField: field.rawField,
    conceptId: field.concept,
    unit: "reporting-currency",
    scale: "1",
    transformIds: ["display-unit-scale", "current-view-no-filing-date"],
  }));

const definitionByConcept = new Map(
  fieldDefinitions.map((field) => [field.concept, field] as const),
);

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function exactDecimal(value: unknown): string | undefined {
  return typeof value === "string"
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
    ? value
    : undefined;
}

function stableId(value: unknown): string {
  return `obs:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function findFinancialContent(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFinancialContent(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = asObject(value);
  if (object === undefined) return undefined;
  if (
    asObject(object["profitSheetV2"]) !== undefined
    || asObject(object["balanceSheetV2"]) !== undefined
    || asObject(object["cashFlowSheetV2"]) !== undefined
  ) {
    return object;
  }
  for (const child of Object.values(object)) {
    const found = findFinancialContent(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseDisplayUnit(raw: unknown): ParsedUnit {
  if (typeof raw !== "string") throw new Error("Baidu finance unit is missing");
  const currency = raw.includes("人民币") || /CNY/i.test(raw)
    ? "CNY"
    : raw.includes("港元") || /HKD/i.test(raw)
      ? "HKD"
      : raw.includes("美元") || /USD/i.test(raw)
        ? "USD"
        : undefined;
  if (currency === undefined) {
    throw new Error(`Unsupported Baidu finance currency unit: ${raw}`);
  }
  const scale = raw.includes("万亿")
    ? "1000000000000"
    : raw.includes("亿")
      ? "100000000"
      : raw.includes("百万")
        ? "1000000"
        : raw.includes("万")
          ? "10000"
          : raw.includes("千")
            ? "1000"
            : "1";
  return { currency, scale };
}

function parsePeriodLabel(label: string, kind: "instant" | "duration"):
  ReportingPeriod | undefined {
  const match = /^(\d{4})(FY|H1|Q1|M9)$/.exec(label);
  if (match === null) return undefined;
  const fiscalYear = Number(match[1]);
  const suffix = match[2]!;
  const selector = {
    FY: { end: "12-31", presentation: "annual" as const },
    H1: { end: "06-30", quarter: 2 as const, presentation: "ytd" as const },
    Q1: { end: "03-31", quarter: 1 as const, presentation: "ytd" as const },
    M9: { end: "09-30", quarter: 3 as const, presentation: "ytd" as const },
  }[suffix];
  if (selector === undefined) return undefined;
  return {
    kind,
    ...(kind === "duration" ? { startDate: `${fiscalYear}-01-01` } : {}),
    endDate: `${fiscalYear}-${selector.end}`,
    fiscalYear,
    ...("quarter" in selector ? { fiscalQuarter: selector.quarter } : {}),
    presentation: selector.presentation,
  };
}

function matchesRequirement(period: ReportingPeriod, requirement: FactRequirement):
  boolean {
  const selector = requirement.period;
  return selector === undefined || (
    period.fiscalYear === selector.fiscalYear
    && period.fiscalQuarter === selector.fiscalQuarter
    && period.presentation === selector.presentation
  );
}

function parseSheetRows(content: JsonObject, sheetName: SheetName): SheetRow[] {
  const sheet = asObject(content[sheetName]);
  if (sheet === undefined) return [];
  const unit = parseDisplayUnit(sheet["unit"]);
  const chartInfo = sheet["chartInfo"];
  if (!Array.isArray(chartInfo)) {
    throw new Error(`Baidu ${sheetName}.chartInfo is missing`);
  }
  const all = chartInfo.find((candidate) => asObject(candidate)?.["type"] === "全部")
    ?? chartInfo[0];
  const chart = asObject(all);
  if (chart === undefined || !Array.isArray(chart["header"]) || !Array.isArray(chart["body"])) {
    throw new Error(`Baidu ${sheetName} table is invalid`);
  }
  const headers = chart["header"].map((header) => String(header));
  return chart["body"].flatMap((rawRow) => {
    if (!Array.isArray(rawRow) || typeof rawRow[0] !== "string") return [];
    return [{
      sheet: sheetName,
      label: rawRow[0],
      headers,
      values: rawRow,
      unit,
    }];
  });
}

function financeUrl(endpoint: string, symbol: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("code", symbol.padStart(5, "0"));
  url.searchParams.set("market", "hk");
  url.searchParams.set("type", "stock");
  url.searchParams.set("widgetType", "finance");
  url.searchParams.set("finClientType", "pc");
  return url.toString();
}

export class BaiduHkFinancialProvider implements SourceProvider {
  readonly providerId = PROVIDER_ID;
  readonly upstreamSourceId = UPSTREAM_SOURCE_ID;
  readonly capabilities = ["financials"] as const;

  constructor(private readonly options: BaiduHkFinancialProviderOptions = {}) {}

  supportsInstrument(instrument: ProviderRequest["instrument"]): boolean {
    return instrument.exchangeMic === "XHKG";
  }

  async fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch> {
    const observations: Observation[] = [];
    const rawSnapshots: ProviderBatch["rawSnapshots"] = [];
    const unmapped: ProviderBatch["unmapped"] = [];
    const issues: ProviderIssue[] = [];
    if (!this.supportsInstrument(request.instrument)) {
      issues.push({
        providerId: this.providerId,
        code: "UNSUPPORTED_INSTRUMENT",
        message: "Baidu V2 financial tables are enabled for H shares only",
        retryable: false,
        reasonCode: "BAIDU_FINANCIAL_H_SHARE_ONLY",
      });
    } else if (request.offline) {
      issues.push({
        providerId: this.providerId,
        code: "EMPTY_RESPONSE",
        message: "Offline mode does not access Baidu finance",
        retryable: false,
        reasonCode: "CURRENT_VIEW_SOURCE_OFFLINE",
      });
    } else {
      const requestedDefinitions = request.requirements.flatMap((requirement) => {
        const definition = definitionByConcept.get(requirement.conceptId);
        return definition === undefined ? [] : [{ definition, requirement }];
      });
      if (requestedDefinitions.length > 0) {
        const sourceUrl = financeUrl(
          this.options.endpoint ?? FINANCE_ENDPOINT,
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
          const content = findFinancialContent(payload);
          if (content === undefined) {
            throw new Error("Baidu V2 financial content is missing");
          }
          const rowsBySheet = new Map<SheetName, SheetRow[]>();
          for (const sheet of new Set(
            requestedDefinitions.map((item) => item.definition.sheet),
          )) {
            rowsBySheet.set(sheet, parseSheetRows(content, sheet));
          }
          for (const { definition, requirement } of requestedDefinitions) {
            const kind = definition.sheet === "balanceSheetV2"
              ? "instant"
              : "duration";
            for (const row of rowsBySheet.get(definition.sheet) ?? []) {
              const period = parsePeriodLabel(row.label, kind);
              if (period === undefined || !matchesRequirement(period, requirement)) {
                continue;
              }
              const fieldIndex = row.headers.indexOf(definition.rawField);
              const rawValue = fieldIndex < 0
                ? undefined
                : row.values[1 + fieldIndex * 2];
              const value = exactDecimal(rawValue);
              if (value === undefined) {
                unmapped.push({
                  unmappedId: stableId({
                    providerId: this.providerId,
                    snapshotId: snapshot.snapshotId,
                    sheet: definition.sheet,
                    field: definition.rawField,
                    period,
                  }),
                  providerId: this.providerId,
                  upstreamSourceId: this.upstreamSourceId,
                  rawSnapshotId: snapshot.snapshotId,
                  rawField: `${definition.sheet}.${definition.rawField}`,
                  rawValue,
                  reasonCode: "UNMAPPED_SOURCE_FIELD",
                  intendedConceptId: definition.concept,
                  intendedPeriod: period,
                });
                continue;
              }
              observations.push(ObservationSchema.parse({
                observationId: stableId({
                  providerId: this.providerId,
                  snapshotId: snapshot.snapshotId,
                  sheet: definition.sheet,
                  field: definition.rawField,
                  concept: definition.concept,
                  period,
                }),
                companyId: request.instrument.companyId,
                concept: definition.concept,
                value,
                unit: row.unit.currency,
                scale: row.unit.scale,
                period,
                basis: {
                  standard: "IFRS",
                  scope: "consolidated",
                  presentation: "reported",
                  ...(definition.attribution === undefined
                    ? {}
                    : { attribution: definition.attribution }),
                  currency: row.unit.currency,
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
                  sourceUrl,
                  rawSnapshotId: snapshot.snapshotId,
                  rawField: `${definition.sheet}.${definition.rawField}`,
                  extractionMethod: "api",
                  fetchedAt: context.now,
                  transformations: [
                    {
                      transformId: "display-unit-scale",
                      version: "1.0.0",
                      detail:
                        `Apply Baidu display unit scale ${row.unit.scale} ${row.unit.currency}`,
                    },
                    {
                      transformId: "current-view-no-filing-date",
                      version: "1.0.0",
                      detail:
                        "Treat Baidu V2 as a current-view value with no asserted filing date or reporting version",
                    },
                  ],
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
                  : "Failed to parse Baidu H-share financial tables",
                retryable: false,
                reasonCode: "BAIDU_HK_FINANCIAL_PARSE_FAILED",
              });
        }
      }
    }

    return {
      providerId: this.providerId,
      upstreamSourceId: this.upstreamSourceId,
      company: {
        companyId: request.instrument.companyId,
        legalName: request.instrument.instrumentId,
        jurisdiction: "HK",
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
