import type { Observation } from "@verified-financial/schema";

export interface CompatibilityResult {
  compatible: boolean;
  reasonCodes: string[];
}

export function compareCompatibility(
  left: Observation,
  right: Observation,
): CompatibilityResult {
  const reasonCodes: string[] = [];
  if (left.concept !== right.concept) reasonCodes.push("CONCEPT_MISMATCH");
  if (left.companyId !== right.companyId) reasonCodes.push("COMPANY_MISMATCH");
  if (left.instrumentId !== right.instrumentId) {
    reasonCodes.push("INSTRUMENT_MISMATCH");
  }
  if (left.unit !== right.unit || left.scale !== right.scale) {
    reasonCodes.push("UNIT_MISMATCH");
  }
  if (
    left.period.kind !== right.period.kind
    || left.period.startDate !== right.period.startDate
    || left.period.endDate !== right.period.endDate
    || left.period.presentation !== right.period.presentation
  ) {
    reasonCodes.push("PERIOD_MISMATCH");
  }
  if (left.basis.standard !== right.basis.standard) {
    reasonCodes.push("ACCOUNTING_STANDARD_MISMATCH");
  }
  if (left.basis.scope !== right.basis.scope) {
    reasonCodes.push("ACCOUNTING_SCOPE_MISMATCH");
  }
  if (left.basis.presentation !== right.basis.presentation) {
    reasonCodes.push("ACCOUNTING_PRESENTATION_MISMATCH");
  }
  if (left.basis.attribution !== right.basis.attribution) {
    reasonCodes.push("ATTRIBUTION_MISMATCH");
  }
  if (left.basis.currency !== right.basis.currency) {
    reasonCodes.push("CURRENCY_MISMATCH");
  }
  return { compatible: reasonCodes.length === 0, reasonCodes };
}
