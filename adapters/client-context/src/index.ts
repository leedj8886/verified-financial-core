import {
  parseVerifiedFactSet,
  type CanonicalFact,
  type FactTemporalEvidence,
  type FactStatus,
  type ReportingPeriod,
  type VerifiedFactSetSchemaVersion,
} from "@verified-financial/schema";

export const CLIENT_CONTEXT_VERSION = "1.1.0" as const;
export type ClientContextVersion = typeof CLIENT_CONTEXT_VERSION;

const statusRank: Record<FactStatus, number> = {
  failed: 0,
  warning: 1,
  verified: 2,
};

export interface ClientContextOptions {
  minimumStatus?: FactStatus;
}

export interface ClientContextFactBase {
  factId: string;
  concept: CanonicalFact["concept"];
  periodLabel: string;
  period: ReportingPeriod;
  unit: string;
  currency: string;
  status: FactStatus;
  usable: boolean;
  sourceIds: string[];
  reasonCodes: string[];
  observationIds: string[];
  reportingVersion?: CanonicalFact["reportingVersion"];
  temporalEvidence?: FactTemporalEvidence;
  derivation?: CanonicalFact["derivation"];
}

export interface AcceptedClientContextFact extends ClientContextFactBase {
  disposition: "accepted";
  value: string;
}

export interface BlockedClientContextFact extends ClientContextFactBase {
  disposition: "blocked";
}

export interface ClientFinancialContext {
  contextVersion: ClientContextVersion;
  factSet: {
    factSetId: string;
    schemaVersion: VerifiedFactSetSchemaVersion;
    generatedAt: string;
    asOf: string;
    knowledgeAsOf: string;
    temporalMode: "point-in-time" | "post-disclosure";
  };
  company: {
    companyId: string;
    legalName: string;
    jurisdiction: string;
  };
  instruments: {
    instrumentId: string;
    exchangeMic: string;
    symbol: string;
    shareClass: string;
    tradingCurrency: string;
  }[];
  gate: {
    minimumStatus: FactStatus;
    actualStatus: FactStatus;
    passed: boolean;
  };
  acceptedFacts: AcceptedClientContextFact[];
  blockedFacts: BlockedClientContextFact[];
  issues: string[];
  audit: {
    rawSnapshotIds: string[];
    lineageVersions?: {
      conceptRegistryVersion: string;
      validationRulesVersion: string;
      mappingVersions: string[];
      formulaVersions: Record<string, string>;
    };
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sortedRecord(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
}

function periodLabel(period: ReportingPeriod): string {
  const quarter = period.fiscalQuarter === undefined
    ? ""
    : `Q${period.fiscalQuarter}`;
  switch (period.presentation) {
    case "annual":
      return `${period.fiscalYear}FY`;
    case "quarter":
      return `${period.fiscalYear}${quarter}`;
    case "ytd":
      return `${period.fiscalYear}${quarter}YTD`;
    case "ttm":
      return `${period.fiscalYear}${quarter}TTM`;
  }
}

function contextFactBase(
  fact: CanonicalFact,
  temporalEvidence?: FactTemporalEvidence,
): ClientContextFactBase {
  return {
    factId: fact.factId,
    concept: fact.concept,
    periodLabel: periodLabel(fact.period),
    period: fact.period,
    unit: fact.unit,
    currency: fact.basis.currency,
    status: fact.status,
    usable: fact.usable,
    sourceIds: sortedUnique(
      fact.verification.independentUpstreamSourceIds,
    ),
    reasonCodes: sortedUnique(fact.reasonCodes),
    observationIds: sortedUnique(fact.observationIds),
    ...(fact.reportingVersion === undefined
      ? {}
      : { reportingVersion: fact.reportingVersion }),
    ...(temporalEvidence === undefined ? {} : { temporalEvidence }),
    ...(fact.derivation === undefined
      ? {}
      : { derivation: fact.derivation }),
  };
}

function meetsMinimumStatus(
  status: FactStatus,
  minimumStatus: FactStatus,
): boolean {
  return statusRank[status] >= statusRank[minimumStatus];
}

export function buildClientFinancialContext(
  input: unknown,
  options: ClientContextOptions = {},
): ClientFinancialContext {
  const factSet = parseVerifiedFactSet(input);
  const minimumStatus = options.minimumStatus ?? "verified";
  const gatePassed = meetsMinimumStatus(
    factSet.summary.overallStatus,
    minimumStatus,
  );
  const acceptedFacts: AcceptedClientContextFact[] = [];
  const blockedFacts: BlockedClientContextFact[] = [];
  const temporalEvidenceByFactId = new Map(
    (factSet.temporalContext?.facts ?? []).map((evidence) => [
      evidence.factId,
      evidence,
    ]),
  );

  for (
    const fact of [...factSet.facts].sort(
      (left, right) => left.factId.localeCompare(right.factId),
    )
  ) {
    const base = contextFactBase(
      fact,
      temporalEvidenceByFactId.get(fact.factId),
    );
    if (fact.usable && meetsMinimumStatus(fact.status, minimumStatus)) {
      acceptedFacts.push({
        ...base,
        disposition: "accepted",
        value: fact.value,
      });
    } else {
      blockedFacts.push({
        ...base,
        disposition: "blocked",
      });
    }
  }

  const issues = sortedUnique([
    ...factSet.reasonCodes,
    ...factSet.facts.flatMap((fact) => fact.reasonCodes),
    ...factSet.facts.flatMap((fact) => fact.verification.reasonCodes),
    ...factSet.unmapped.map((unmapped) => unmapped.reasonCode),
    ...(factSet.temporalContext?.mode === "post-disclosure"
      ? ["POST_DISCLOSURE_CONTEXT"]
      : []),
    ...(gatePassed ? [] : ["FACT_SET_BELOW_MINIMUM_STATUS"]),
  ]);

  return {
    contextVersion: CLIENT_CONTEXT_VERSION,
    factSet: {
      factSetId: factSet.factSetId,
      schemaVersion: factSet.schemaVersion,
      generatedAt: factSet.generatedAt,
      asOf: factSet.request.asOf,
      knowledgeAsOf: factSet.request.knowledgeAsOf ?? factSet.request.asOf,
      temporalMode: factSet.temporalContext?.mode ?? "point-in-time",
    },
    company: factSet.company,
    instruments: [...factSet.instruments]
      .sort((left, right) =>
        left.instrumentId.localeCompare(right.instrumentId)
      )
      .map((instrument) => ({
        instrumentId: instrument.instrumentId,
        exchangeMic: instrument.exchangeMic,
        symbol: instrument.symbol,
        shareClass: instrument.shareClass,
        tradingCurrency: instrument.tradingCurrency,
      })),
    gate: {
      minimumStatus,
      actualStatus: factSet.summary.overallStatus,
      passed: gatePassed,
    },
    acceptedFacts,
    blockedFacts,
    issues,
    audit: {
      rawSnapshotIds: sortedUnique(factSet.rawSnapshotIds),
      ...(factSet.lineageVersions === undefined
        ? {}
        : {
          lineageVersions: {
            conceptRegistryVersion:
              factSet.lineageVersions.conceptRegistryVersion,
            validationRulesVersion:
              factSet.lineageVersions.validationRulesVersion,
            mappingVersions: sortedUnique(
              factSet.lineageVersions.mappingVersions,
            ),
            formulaVersions: sortedRecord(
              factSet.lineageVersions.formulaVersions,
            ),
          },
        }),
    },
  };
}

export function formatClientFinancialContext(
  input: unknown,
  options: ClientContextOptions = {},
): string {
  return JSON.stringify(buildClientFinancialContext(input, options));
}
