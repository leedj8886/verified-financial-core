import {
  CONCEPT_REGISTRY_VERSION,
  VerifiedFactSetSchema,
  type CanonicalFact,
  type Company,
  type FactRequirement,
  type FactRequest,
  type Instrument,
  type UnmappedObservation,
  type VerificationResult,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import { FORMULAS } from "./derivations.js";
import { canonicalJson, stableId } from "./ids.js";

export interface BuildFactSetInput {
  schemaVersion: string;
  request: FactRequest;
  generatedAt: string;
  company: Company;
  instruments: Instrument[];
  facts: CanonicalFact[];
  unmapped: UnmappedObservation[];
  validations: VerificationResult[];
  rawSnapshotIds: string[];
  mappingVersions: string[];
  validationRulesVersion: string;
  reasonCodes?: string[];
}

function matchesRequirement(
  fact: CanonicalFact,
  requirement: FactRequirement,
): boolean {
  if (fact.concept !== requirement.conceptId) return false;
  if (requirement.period === undefined) return true;
  return fact.period.fiscalYear === requirement.period.fiscalYear
    && fact.period.presentation === requirement.period.presentation
    && fact.period.fiscalQuarter === requirement.period.fiscalQuarter;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildFactSet(input: BuildFactSetInput): VerifiedFactSet {
  const normalizedRequest: FactRequest = {
    ...input.request,
    requirements: [...input.request.requirements].sort(
      (left, right) => canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  };
  const facts = [...input.facts].sort(
    (left, right) => left.factId.localeCompare(right.factId),
  );
  const unmapped = [...input.unmapped].sort(
    (left, right) => left.unmappedId.localeCompare(right.unmappedId),
  );
  const validations = [...input.validations].sort(
    (left, right) =>
      left.verificationId.localeCompare(right.verificationId),
  );
  const instruments = [...input.instruments].sort(
    (left, right) => left.instrumentId.localeCompare(right.instrumentId),
  );
  const rawSnapshotIds = sortedUnique(input.rawSnapshotIds);
  const mappingVersions = sortedUnique(input.mappingVersions);
  const inputReasonCodes = sortedUnique(input.reasonCodes ?? []);
  const missingRequired = normalizedRequest.requirements.filter(
    (requirement) => requirement.required
      && !facts.some(
        (fact) => fact.usable && matchesRequirement(fact, requirement),
      ),
  );
  const verified = facts.filter((fact) => fact.status === "verified").length;
  const warnings = facts.filter((fact) => fact.status === "warning").length;
  const failedFacts = facts.filter((fact) => fact.status === "failed").length;
  const missingWithoutFact = missingRequired.filter(
    (requirement) => !facts.some(
      (fact) => matchesRequirement(fact, requirement),
    ),
  ).length;
  const failed = failedFacts + missingWithoutFact;
  const hasOptionalGap = unmapped.length > 0
    || normalizedRequest.requirements.some(
      (requirement) => !requirement.required
        && !facts.some(
          (fact) => fact.usable && matchesRequirement(fact, requirement),
        ),
    );
  const isEmpty = facts.length === 0;
  const overallStatus = isEmpty || missingRequired.length > 0
    ? "failed"
    : warnings > 0
        || failedFacts > 0
        || hasOptionalGap
        || inputReasonCodes.length > 0
      ? "warning"
      : "verified";
  const reasonCodes = isEmpty
    ? ["EMPTY_FACT_SET", ...inputReasonCodes.filter(
        (reasonCode) => reasonCode !== "EMPTY_FACT_SET",
      )]
    : inputReasonCodes;

  const identityPayload = {
    schemaVersion: input.schemaVersion,
    request: normalizedRequest,
    company: input.company,
    instruments,
    facts,
    unmapped,
    validations,
    rawSnapshotIds,
    conceptRegistryVersion: CONCEPT_REGISTRY_VERSION,
    mappingVersions,
    formulas: FORMULAS,
    validationRulesVersion: input.validationRulesVersion,
    reasonCodes,
  };

  return VerifiedFactSetSchema.parse({
    schemaVersion: input.schemaVersion,
    factSetId: stableId("fs", identityPayload),
    request: normalizedRequest,
    generatedAt: input.generatedAt,
    company: input.company,
    instruments,
    facts,
    unmapped,
    validations,
    rawSnapshotIds,
    reasonCodes,
    summary: {
      verified,
      warnings,
      failed,
      unmapped: unmapped.length,
      overallStatus,
    },
  });
}
