import {
  CanonicalFactSchema,
  FactRequestSchema,
  ObservationSchema,
  UnmappedObservationSchema,
  getConceptDefinition,
  type AccountingBasis,
  type Availability,
  type CanonicalFact,
  type ConceptId,
  type FactRequest,
  type Observation,
  type ReportingPeriod,
  type ReportingVersion,
  type UnmappedObservation,
} from "@verified-financial/schema";

interface ObservationOverrides {
  observationId?: string;
  companyId?: string;
  instrumentId?: string;
  concept?: ConceptId;
  value?: string;
  unit?: string;
  scale?: string;
  period?: Partial<ReportingPeriod>;
  basis?: Partial<AccountingBasis>;
  availability?: Partial<Availability>;
  providerId?: string;
  upstreamSourceId?: string;
  sourceType?: "official" | "first-party" | "aggregator";
  extractionMethod?: "api" | "pdf" | "ocr" | "html" | "manual";
  reportingVersion?: ReportingVersion;
}

export function makeObservation(
  overrides: ObservationOverrides = {},
): Observation {
  const concept = overrides.concept ?? "income.revenue";
  const definition = getConceptDefinition(concept);
  const periodKind = overrides.period?.kind ?? definition.periodKind;
  const instrumentId = overrides.instrumentId
    ?? (definition.scope === "instrument" ? "XSHG:600519" : undefined);
  const currency = overrides.basis?.currency ?? "CNY";
  const unit = definition.canonicalUnit === "currency"
    ? currency
    : definition.canonicalUnit === "currency-per-share"
      ? `${currency}-per-share`
      : definition.canonicalUnit;
  return ObservationSchema.parse({
    observationId: overrides.observationId ?? "obs:eastmoney",
    companyId: overrides.companyId ?? "company:600519",
    ...(instrumentId === undefined ? {} : { instrumentId }),
    concept,
    value: overrides.value ?? "100",
    unit: overrides.unit ?? unit,
    scale: overrides.scale ?? "1",
    period: {
      kind: periodKind,
      ...(periodKind === "duration" ? { startDate: "2025-01-01" } : {}),
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
      ...overrides.period,
    },
    basis: {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
      ...overrides.basis,
    },
    ...(overrides.reportingVersion === undefined
      ? {}
      : { reportingVersion: overrides.reportingVersion }),
    availability: {
      publishedAt: "2026-03-20T18:00:00+08:00",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      ...overrides.availability,
    },
    provenance: {
      providerId: overrides.providerId ?? "eastmoney-direct",
      upstreamSourceId: overrides.upstreamSourceId ?? "eastmoney",
      sourceType: overrides.sourceType ?? "aggregator",
      sourceUrl: `https://example.invalid/${overrides.providerId ?? "eastmoney-direct"}`,
      rawSnapshotId: `sha256:${overrides.providerId ?? "eastmoney-direct"}`,
      rawField: "RAW_FIELD",
      extractionMethod: overrides.extractionMethod ?? "api",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      transformations: [],
    },
  });
}

interface FactOverrides extends ObservationOverrides {
  factId?: string;
  status?: "verified" | "warning" | "failed";
  usable?: boolean;
  fiscalYear?: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  presentation?: "quarter" | "ytd" | "annual" | "ttm";
  currency?: string;
}

export function makeFact(overrides: FactOverrides = {}): CanonicalFact {
  const observation = makeObservation({
    ...overrides,
    basis: {
      ...overrides.basis,
      ...(overrides.currency === undefined
        ? {}
        : { currency: overrides.currency }),
    },
    period: {
      ...overrides.period,
      ...(overrides.fiscalYear === undefined
        ? {}
        : { fiscalYear: overrides.fiscalYear }),
      ...(overrides.fiscalQuarter === undefined
        ? {}
        : { fiscalQuarter: overrides.fiscalQuarter }),
      ...(overrides.presentation === undefined
        ? {}
        : { presentation: overrides.presentation }),
    },
  });
  const status = overrides.status ?? "verified";
  const usable = overrides.usable ?? status !== "failed";
  const factId = overrides.factId ?? `fact:${observation.observationId}`;
  return CanonicalFactSchema.parse({
    factId,
    companyId: observation.companyId,
    ...(observation.instrumentId === undefined
      ? {}
      : { instrumentId: observation.instrumentId }),
    concept: observation.concept,
    value: observation.value,
    unit: observation.unit,
    period: observation.period,
    basis: observation.basis,
    ...(observation.reportingVersion === undefined
      ? {}
      : { reportingVersion: observation.reportingVersion }),
    status,
    usable,
    reasonCodes: [],
    observationIds: [observation.observationId],
    verification: {
      verificationId: `vr:${factId}`,
      status,
      usable,
      observationIds: [observation.observationId],
      independentUpstreamSourceIds: [
        observation.provenance.upstreamSourceId,
      ],
      chosenObservationId: observation.observationId,
      reasonCodes: [],
    },
  });
}

export function makeRequest(
  requirements: FactRequest["requirements"] = [{
    conceptId: "income.revenue",
    required: true,
    period: { fiscalYear: 2025, presentation: "annual" },
  }],
): FactRequest {
  return FactRequestSchema.parse({
    instrument: "XSHG:600519",
    requirements,
    asOf: "2026-07-26T23:59:59+08:00",
  });
}

export function makeUnmapped(
  overrides: Partial<UnmappedObservation> = {},
): UnmappedObservation {
  return UnmappedObservationSchema.parse({
    unmappedId: "unmapped:1",
    providerId: "eastmoney-direct",
    upstreamSourceId: "eastmoney",
    rawSnapshotId: "sha256:eastmoney-direct",
    rawField: "UNKNOWN_FIELD",
    rawValue: "1",
    reasonCode: "UNMAPPED_SOURCE_FIELD",
    ...overrides,
  });
}
