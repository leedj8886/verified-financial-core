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
  freshness: z.object({
    maxAgeSeconds: z.number().int().nonnegative(),
    allowStaleOnProviderFailure: z.boolean(),
    offline: z.boolean().optional(),
  }).optional(),
});
export type FactRequest = z.infer<typeof FactRequestSchema>;

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

export const VerifiedFactSetSchema = z.object({
  schemaVersion: z.string().min(1),
  factSetId: z.string().min(1),
  request: FactRequestSchema,
  generatedAt: z.string().datetime({ offset: true }),
  company: CompanySchema,
  instruments: z.array(InstrumentSchema),
  facts: z.array(CanonicalFactSchema),
  unmapped: z.array(UnmappedObservationSchema),
  validations: z.array(VerificationResultSchema),
  rawSnapshotIds: z.array(z.string().min(1)),
  reasonCodes: z.array(z.string().min(1)),
  summary: z.object({
    verified: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unmapped: z.number().int().nonnegative(),
    overallStatus: FactStatusSchema,
  }),
});
export type VerifiedFactSet = z.infer<typeof VerifiedFactSetSchema>;
