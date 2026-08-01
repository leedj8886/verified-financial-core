import { z } from "zod";
import {
  AccountingBasisSchema,
  type AccountingBasis,
} from "./accounting.js";
import {
  ConceptIdSchema,
  getConceptDefinition,
  type ConceptId,
} from "./concepts.js";
import { CompanySchema, InstrumentSchema } from "./identity.js";
import {
  AvailabilitySchema,
  ReportingPeriodSchema,
  type ReportingPeriod,
} from "./period.js";
import { ProvenanceSchema } from "./provenance.js";
import { DecimalStringSchema } from "./value.js";

export const VERIFIED_FACT_SET_SCHEMA_VERSION = "1.1.0" as const;
export const SUPPORTED_VERIFIED_FACT_SET_SCHEMA_VERSIONS = [
  "1.0.0",
  VERIFIED_FACT_SET_SCHEMA_VERSION,
] as const;
export type VerifiedFactSetSchemaVersion =
  (typeof SUPPORTED_VERIFIED_FACT_SET_SCHEMA_VERSIONS)[number];

export function isSupportedVerifiedFactSetSchemaVersion(
  value: unknown,
): value is VerifiedFactSetSchemaVersion {
  return typeof value === "string"
    && SUPPORTED_VERIFIED_FACT_SET_SCHEMA_VERSIONS.includes(
      value as VerifiedFactSetSchemaVersion,
    );
}

export const FactStatusSchema = z.enum(["verified", "warning", "failed"]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const FactPeriodSelectorSchema = z.object({
  fiscalYear: z.number().int(),
  fiscalQuarter: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]).optional(),
  presentation: z.enum(["quarter", "ytd", "annual", "ttm"]),
}).superRefine((period, context) => {
  const quarterRequired = period.presentation === "quarter"
    || period.presentation === "ytd";
  if (quarterRequired && period.fiscalQuarter === undefined) {
    context.addIssue({
      code: "custom",
      message: "Quarter and YTD requirements need fiscalQuarter",
    });
  }
  if (
    period.presentation === "annual"
    && period.fiscalQuarter !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Annual requirements cannot specify fiscalQuarter",
    });
  }
});
export type FactPeriodSelector = z.infer<typeof FactPeriodSelectorSchema>;

export const FactRequirementSchema = z.object({
  conceptId: ConceptIdSchema,
  required: z.boolean(),
  period: FactPeriodSelectorSchema.optional(),
}).superRefine((requirement, context) => {
  if (requirement.period === undefined) return;
  const definition = getConceptDefinition(requirement.conceptId);
  if (!definition.allowedPresentations.includes(
    requirement.period.presentation,
  )) {
    context.addIssue({
      code: "custom",
      message: `Presentation ${requirement.period.presentation} is not allowed for ${requirement.conceptId}`,
    });
  }
});
export type FactRequirement = z.infer<typeof FactRequirementSchema>;

export const FactRequestSchema = z.object({
  instrument: z.string().min(1),
  requirements: z.array(FactRequirementSchema).min(1),
  asOf: z.string().datetime({ offset: true }),
  knowledgeAsOf: z.string().datetime({ offset: true }).optional(),
  freshness: z.object({
    maxAgeSeconds: z.number().int().nonnegative(),
    allowStaleOnProviderFailure: z.boolean(),
    offline: z.boolean().optional(),
  }).optional(),
}).superRefine((request, context) => {
  if (
    request.knowledgeAsOf !== undefined
    && Date.parse(request.knowledgeAsOf) < Date.parse(request.asOf)
  ) {
    context.addIssue({
      code: "custom",
      path: ["knowledgeAsOf"],
      message: "knowledgeAsOf cannot be earlier than asOf",
    });
  }
});
export type FactRequest = z.infer<typeof FactRequestSchema>;

export const ReportingVersionSchema = z.object({
  kind: z.enum([
    "original-filing",
    "later-comparative",
    "explicit-restatement",
  ]),
  sourcePeriodEndDate: z.string().date().optional(),
}).strict();
export type ReportingVersion = z.infer<typeof ReportingVersionSchema>;

export const FactTemporalEvidenceSchema = z.object({
  factId: z.string().min(1),
  evidenceAvailableAt: z.string().datetime({ offset: true }),
  knownAtEffectiveAsOf: z.boolean(),
  postEffectiveDateObservationIds: z.array(z.string().min(1)),
}).strict();
export type FactTemporalEvidence = z.infer<
  typeof FactTemporalEvidenceSchema
>;

export const FactSetTemporalContextSchema = z.object({
  effectiveAsOf: z.string().datetime({ offset: true }),
  knowledgeAsOf: z.string().datetime({ offset: true }),
  mode: z.enum(["point-in-time", "post-disclosure"]),
  facts: z.array(FactTemporalEvidenceSchema),
}).strict();
export type FactSetTemporalContext = z.infer<
  typeof FactSetTemporalContextSchema
>;

interface ConceptSemanticCandidate {
  concept: ConceptId;
  instrumentId?: string | undefined;
  unit: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
}

function validateConceptSemantics(
  candidate: ConceptSemanticCandidate,
  context: z.RefinementCtx,
): void {
  const definition = getConceptDefinition(candidate.concept);
  if (definition.scope === "instrument" && candidate.instrumentId === undefined) {
    context.addIssue({
      code: "custom",
      message: "Instrument-scoped concepts require instrumentId",
    });
  }
  if (definition.scope === "company" && candidate.instrumentId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Company-scoped concepts cannot have instrumentId",
    });
  }
  if (candidate.period.kind !== definition.periodKind) {
    context.addIssue({
      code: "custom",
      message: `Expected ${definition.periodKind} period`,
    });
  }
  if (!definition.allowedPresentations.includes(candidate.period.presentation)) {
    context.addIssue({
      code: "custom",
      message: `Presentation ${candidate.period.presentation} is not allowed for ${candidate.concept}`,
    });
  }
  const expectedUnit = definition.canonicalUnit === "currency"
    ? candidate.basis.currency
    : definition.canonicalUnit === "currency-per-share"
      ? `${candidate.basis.currency}-per-share`
      : definition.canonicalUnit;
  if (candidate.unit !== expectedUnit) {
    context.addIssue({
      code: "custom",
      message: `Expected canonical unit ${expectedUnit}`,
    });
  }
}

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  companyId: z.string().min(1),
  instrumentId: z.string().min(1).optional(),
  concept: ConceptIdSchema,
  value: DecimalStringSchema,
  unit: z.string().min(1),
  scale: DecimalStringSchema,
  period: ReportingPeriodSchema,
  basis: AccountingBasisSchema,
  reportingVersion: ReportingVersionSchema.optional(),
  availability: AvailabilitySchema,
  provenance: ProvenanceSchema,
}).superRefine(validateConceptSemantics);
export type Observation = z.infer<typeof ObservationSchema>;

export const UnmappedObservationSchema = z.object({
  unmappedId: z.string().min(1),
  providerId: z.string().min(1),
  upstreamSourceId: z.string().min(1),
  rawSnapshotId: z.string().min(1),
  rawField: z.string().min(1),
  rawValue: z.unknown(),
  reasonCode: z.literal("UNMAPPED_SOURCE_FIELD"),
  intendedConceptId: ConceptIdSchema.optional(),
  intendedPeriod: ReportingPeriodSchema.optional(),
});
export type UnmappedObservation = z.infer<typeof UnmappedObservationSchema>;

export const VerificationResultSchema = z.object({
  verificationId: z.string().min(1),
  status: FactStatusSchema,
  usable: z.boolean(),
  observationIds: z.array(z.string().min(1)),
  independentUpstreamSourceIds: z.array(z.string().min(1)),
  discrepancyPercent: DecimalStringSchema.optional(),
  chosenObservationId: z.string().min(1).optional(),
  reasonCodes: z.array(z.string().min(1)),
}).superRefine((result, context) => {
  if (result.status === "failed" && result.usable) {
    context.addIssue({
      code: "custom",
      message: "Failed verification cannot be usable",
    });
  }
  if (result.status !== "failed" && !result.usable) {
    context.addIssue({
      code: "custom",
      message: "Verified or warning verification must be usable",
    });
  }
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const DerivationSchema = z.object({
  formulaId: z.string().min(1),
  formulaVersion: z.string().min(1),
  inputFactIds: z.array(z.string().min(1)).min(1),
  expression: z.string().min(1),
  rounding: z.string().min(1).optional(),
});
export type Derivation = z.infer<typeof DerivationSchema>;

export const CanonicalFactSchema = z.object({
  factId: z.string().min(1),
  companyId: z.string().min(1),
  instrumentId: z.string().min(1).optional(),
  concept: ConceptIdSchema,
  value: DecimalStringSchema,
  unit: z.string().min(1),
  period: ReportingPeriodSchema,
  basis: AccountingBasisSchema,
  reportingVersion: ReportingVersionSchema.optional(),
  status: FactStatusSchema,
  usable: z.boolean(),
  reasonCodes: z.array(z.string().min(1)),
  observationIds: z.array(z.string().min(1)).min(1),
  verification: VerificationResultSchema,
  derivation: DerivationSchema.optional(),
}).superRefine(validateConceptSemantics).superRefine((fact, context) => {
  if (
    fact.status !== fact.verification.status
    || fact.usable !== fact.verification.usable
  ) {
    context.addIssue({
      code: "custom",
      message: "Fact status and usability must match verification",
    });
  }
});
export type CanonicalFact = z.infer<typeof CanonicalFactSchema>;

export const FactSetLineageVersionsSchema = z.object({
  conceptRegistryVersion: z.string().min(1),
  validationRulesVersion: z.string().min(1),
  mappingVersions: z.array(z.string().min(1)),
  formulaVersions: z.record(
    z.string().min(1),
    z.string().min(1),
  ),
}).strict();
export type FactSetLineageVersions =
  z.infer<typeof FactSetLineageVersionsSchema>;

export const VerifiedFactSetSchema = z.object({
  schemaVersion: z.enum(SUPPORTED_VERIFIED_FACT_SET_SCHEMA_VERSIONS),
  factSetId: z.string().min(1),
  request: FactRequestSchema,
  temporalContext: FactSetTemporalContextSchema.optional(),
  generatedAt: z.string().datetime({ offset: true }),
  company: CompanySchema,
  instruments: z.array(InstrumentSchema),
  facts: z.array(CanonicalFactSchema),
  unmapped: z.array(UnmappedObservationSchema),
  validations: z.array(VerificationResultSchema),
  rawSnapshotIds: z.array(z.string().min(1)),
  lineageVersions: FactSetLineageVersionsSchema.optional(),
  reasonCodes: z.array(z.string().min(1)),
  summary: z.object({
    verified: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unmapped: z.number().int().nonnegative(),
    overallStatus: FactStatusSchema,
  }),
}).strict().superRefine((factSet, context) => {
  if (factSet.schemaVersion !== VERIFIED_FACT_SET_SCHEMA_VERSION) {
    if (
      factSet.request.knowledgeAsOf !== undefined
      || factSet.temporalContext !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "VerifiedFactSet 1.0.0 cannot contain 1.1.0 temporal fields",
      });
    }
    return;
  }
  if (factSet.request.knowledgeAsOf === undefined) {
    context.addIssue({
      code: "custom",
      path: ["request", "knowledgeAsOf"],
      message: "VerifiedFactSet 1.1.0 requires request.knowledgeAsOf",
    });
  }
  if (factSet.temporalContext === undefined) {
    context.addIssue({
      code: "custom",
      path: ["temporalContext"],
      message: "VerifiedFactSet 1.1.0 requires temporalContext",
    });
    return;
  }
  const temporal = factSet.temporalContext;
  const knowledgeAsOf = factSet.request.knowledgeAsOf;
  if (
    Date.parse(temporal.effectiveAsOf) !== Date.parse(factSet.request.asOf)
  ) {
    context.addIssue({
      code: "custom",
      path: ["temporalContext", "effectiveAsOf"],
      message: "temporalContext.effectiveAsOf must equal request.asOf",
    });
  }
  if (
    knowledgeAsOf !== undefined
    && Date.parse(temporal.knowledgeAsOf) !== Date.parse(knowledgeAsOf)
  ) {
    context.addIssue({
      code: "custom",
      path: ["temporalContext", "knowledgeAsOf"],
      message:
        "temporalContext.knowledgeAsOf must equal request.knowledgeAsOf",
    });
  }
  const expectedMode = Date.parse(temporal.knowledgeAsOf)
      === Date.parse(temporal.effectiveAsOf)
    ? "point-in-time"
    : "post-disclosure";
  if (temporal.mode !== expectedMode) {
    context.addIssue({
      code: "custom",
      path: ["temporalContext", "mode"],
      message: `temporalContext.mode must be ${expectedMode}`,
    });
  }
  const factsById = new Map(factSet.facts.map((fact) => [fact.factId, fact]));
  const evidenceFactIds = temporal.facts.map((fact) => fact.factId);
  if (
    new Set(evidenceFactIds).size !== evidenceFactIds.length
    || evidenceFactIds.length !== factsById.size
    || evidenceFactIds.some((factId) => !factsById.has(factId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["temporalContext", "facts"],
      message: "temporalContext.facts must cover every Fact exactly once",
    });
  }
  temporal.facts.forEach((evidence, index) => {
    const fact = factsById.get(evidence.factId);
    if (
      Date.parse(evidence.evidenceAvailableAt)
        > Date.parse(temporal.knowledgeAsOf)
    ) {
      context.addIssue({
        code: "custom",
        path: ["temporalContext", "facts", index, "evidenceAvailableAt"],
        message: "Fact evidence cannot be later than knowledgeAsOf",
      });
    }
    if (
      evidence.knownAtEffectiveAsOf
        !== (evidence.postEffectiveDateObservationIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["temporalContext", "facts", index, "knownAtEffectiveAsOf"],
        message:
          "knownAtEffectiveAsOf must match post-effective-date evidence",
      });
    }
    if (
      fact !== undefined
      && evidence.postEffectiveDateObservationIds.some(
        (observationId) => !fact.observationIds.includes(observationId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: [
          "temporalContext",
          "facts",
          index,
          "postEffectiveDateObservationIds",
        ],
        message: "Post-date evidence must belong to the referenced Fact",
      });
    }
  });
}).meta({
  id: `verified-fact-set-${VERIFIED_FACT_SET_SCHEMA_VERSION}`,
  title: "VerifiedFactSet",
  description:
    "Frozen, traceable financial fact package consumed by Gateway clients and Research CI.",
});
export type VerifiedFactSet = z.infer<typeof VerifiedFactSetSchema>;

export function parseVerifiedFactSet(value: unknown): VerifiedFactSet {
  return VerifiedFactSetSchema.parse(value);
}
