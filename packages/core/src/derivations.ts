import { createHash } from "node:crypto";
import {
  CanonicalFactSchema,
  type AccountingBasis,
  type CanonicalFact,
  type ConceptId,
  type Derivation,
  type ReportingPeriod,
} from "@verified-financial/schema";
import { Decimal } from "decimal.js";

export const FORMULAS = {
  ttmFlow: {
    formulaId: "ttm.flow.v1", formulaVersion: "1.0.0",
    expression: "currentYtd + previousAnnual - previousYtd",
  },
  freeCashFlow: {
    formulaId: "fcf.ocf-minus-capex.v1", formulaVersion: "1.0.0",
    expression: "operatingCashFlow - capex",
  },
  roe: {
    formulaId: "roe.average-equity.v1", formulaVersion: "1.0.0",
    expression: "netProfit / ((openingEquity + closingEquity) / 2)",
  },
  marketCap: {
    formulaId: "market-cap.price-times-shares.v1", formulaVersion: "1.0.0",
    expression: "price * shares",
  },
  pe: {
    formulaId: "pe.price-divided-by-eps.v1", formulaVersion: "1.0.0",
    expression: "price / eps",
  },
} as const;

function sameBasis(left: AccountingBasis, right: AccountingBasis): boolean {
  return left.standard === right.standard
    && left.scope === right.scope
    && left.presentation === right.presentation
    && left.attribution === right.attribution
    && left.currency === right.currency;
}

function samePeriod(left: ReportingPeriod, right: ReportingPeriod): boolean {
  return left.kind === right.kind
    && left.startDate === right.startDate
    && left.endDate === right.endDate
    && left.fiscalYear === right.fiscalYear
    && left.fiscalQuarter === right.fiscalQuarter
    && left.presentation === right.presentation;
}

function assertCompatible(inputs: CanonicalFact[]): void {
  const first = inputs[0];
  if (first === undefined || inputs.some((fact) => !fact.usable)) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  if (inputs.some((fact) =>
    fact.companyId !== first.companyId
    || fact.instrumentId !== first.instrumentId
    || !sameBasis(fact.basis, first.basis))) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
}

function derivedFact(input: {
  concept: ConceptId;
  value: Decimal;
  unit: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
  inputs: CanonicalFact[];
  formula: (typeof FORMULAS)[keyof typeof FORMULAS];
}): CanonicalFact {
  assertCompatible(input.inputs);
  const first = input.inputs[0]!;
  const inputFactIds = input.inputs.map((fact) => fact.factId);
  const observationIds = [...new Set(input.inputs.flatMap(
    (fact) => fact.observationIds,
  ))].sort();
  const upstreams = [...new Set(input.inputs.flatMap(
    (fact) => fact.verification.independentUpstreamSourceIds,
  ))].sort();
  const status = input.inputs.some((fact) => fact.status === "warning")
    ? "warning"
    : "verified";
  const reasonCodes = status === "warning"
    ? ["DERIVED_FROM_WARNING_INPUT"]
    : [];
  const derivation: Derivation = {
    formulaId: input.formula.formulaId,
    formulaVersion: input.formula.formulaVersion,
    inputFactIds,
    expression: input.formula.expression,
  };
  const reportingVersionKinds = input.inputs.flatMap((fact) =>
    fact.reportingVersion === undefined ? [] : [fact.reportingVersion.kind]
  );
  const reportingVersion = reportingVersionKinds.includes(
      "explicit-restatement",
    )
    ? { kind: "explicit-restatement" as const }
    : reportingVersionKinds.includes("later-comparative")
      ? { kind: "later-comparative" as const }
      : reportingVersionKinds.length > 0
        ? { kind: "original-filing" as const }
        : undefined;
  const digest = createHash("sha256").update(JSON.stringify({
    concept: input.concept, value: input.value.toString(),
    unit: input.unit, period: input.period, basis: input.basis,
    reportingVersion, derivation,
  })).digest("hex");
  return CanonicalFactSchema.parse({
    factId: `fact:${digest}`,
    companyId: first.companyId,
    ...(first.instrumentId === undefined
      ? {}
      : { instrumentId: first.instrumentId }),
    concept: input.concept,
    value: input.value.toString(),
    unit: input.unit,
    period: input.period,
    basis: input.basis,
    ...(reportingVersion === undefined ? {} : { reportingVersion }),
    status,
    usable: true,
    reasonCodes,
    observationIds,
    verification: {
      verificationId: `vr:derived:${digest}`,
      status, usable: true, observationIds,
      independentUpstreamSourceIds: upstreams, reasonCodes,
    },
    derivation,
  });
}

function shiftDay(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function deriveTtmFlow(input: {
  currentYtd: CanonicalFact;
  previousAnnual: CanonicalFact;
  previousYtd: CanonicalFact;
}): CanonicalFact {
  const facts = [input.currentYtd, input.previousAnnual, input.previousYtd];
  assertCompatible(facts);
  const valid = facts.every((fact) => fact.concept === input.currentYtd.concept)
    && facts.every((fact) => fact.unit === input.currentYtd.unit)
    && input.currentYtd.period.presentation === "ytd"
    && input.previousAnnual.period.presentation === "annual"
    && input.previousYtd.period.presentation === "ytd"
    && input.currentYtd.period.fiscalYear
      === input.previousAnnual.period.fiscalYear + 1
    && input.previousAnnual.period.fiscalYear
      === input.previousYtd.period.fiscalYear
    && input.currentYtd.period.fiscalQuarter
      === input.previousYtd.period.fiscalQuarter;
  if (!valid) throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  return derivedFact({
    concept: input.currentYtd.concept,
    value: new Decimal(input.currentYtd.value)
      .plus(input.previousAnnual.value).minus(input.previousYtd.value),
    unit: input.currentYtd.unit,
    period: {
      kind: "duration",
      startDate: shiftDay(input.previousYtd.period.endDate, 1),
      endDate: input.currentYtd.period.endDate,
      fiscalYear: input.currentYtd.period.fiscalYear,
      ...(input.currentYtd.period.fiscalQuarter === undefined
        ? {}
        : { fiscalQuarter: input.currentYtd.period.fiscalQuarter }),
      presentation: "ttm",
    },
    basis: input.currentYtd.basis, inputs: facts, formula: FORMULAS.ttmFlow,
  });
}

export function deriveFreeCashFlow(
  operatingCashFlow: CanonicalFact,
  capex: CanonicalFact,
): CanonicalFact {
  const inputs = [operatingCashFlow, capex];
  assertCompatible(inputs);
  if (operatingCashFlow.concept !== "cashFlow.operatingCashFlow"
      || capex.concept !== "cashFlow.capex"
      || operatingCashFlow.unit !== capex.unit
      || !samePeriod(operatingCashFlow.period, capex.period)) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  return derivedFact({
    concept: "cashFlow.freeCashFlow",
    value: new Decimal(operatingCashFlow.value).minus(capex.value),
    unit: operatingCashFlow.unit, period: operatingCashFlow.period,
    basis: operatingCashFlow.basis, inputs, formula: FORMULAS.freeCashFlow,
  });
}

export function deriveRoe(input: {
  netProfit: CanonicalFact;
  openingEquity: CanonicalFact;
  closingEquity: CanonicalFact;
}): CanonicalFact {
  const inputs = [input.netProfit, input.openingEquity, input.closingEquity];
  assertCompatible(inputs);
  const start = input.netProfit.period.startDate;
  if (!["income.netProfit", "income.netProfitParent"].includes(
    input.netProfit.concept,
  ) || input.openingEquity.concept !== "balance.equity"
      || input.closingEquity.concept !== "balance.equity"
      || inputs.some((fact) => fact.unit !== input.netProfit.unit)
      || start === undefined
      || input.openingEquity.period.endDate !== shiftDay(start, -1)
      || input.closingEquity.period.endDate !== input.netProfit.period.endDate) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  const average = new Decimal(input.openingEquity.value)
    .plus(input.closingEquity.value).div(2);
  if (average.isZero()) throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  return derivedFact({
    concept: "profitability.roe",
    value: new Decimal(input.netProfit.value).div(average),
    unit: "ratio", period: input.netProfit.period, basis: input.netProfit.basis,
    inputs, formula: FORMULAS.roe,
  });
}

export function deriveMarketCap(
  price: CanonicalFact,
  shares: CanonicalFact,
): CanonicalFact {
  const inputs = [price, shares];
  assertCompatible(inputs);
  if (price.concept !== "market.price.close"
      || shares.concept !== "market.shares.outstanding"
      || shares.unit !== "shares" || price.unit !== price.basis.currency
      || !samePeriod(price.period, shares.period)) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  return derivedFact({
    concept: "market.cap",
    value: new Decimal(price.value).mul(shares.value),
    unit: price.unit, period: price.period, basis: price.basis,
    inputs, formula: FORMULAS.marketCap,
  });
}

export function derivePe(
  price: CanonicalFact,
  eps: CanonicalFact,
): CanonicalFact {
  const inputs = [price, eps];
  assertCompatible(inputs);
  const denominator = new Decimal(eps.value);
  if (price.concept !== "market.price.close"
      || eps.concept !== "income.epsBasic"
      || eps.period.presentation !== "ttm"
      || eps.unit !== `${price.unit}-per-share`
      || eps.period.endDate !== price.period.endDate
      || denominator.isZero()) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  return derivedFact({
    concept: "valuation.peTtm",
    value: new Decimal(price.value).div(denominator),
    unit: "ratio", period: { ...price.period, presentation: "ttm" },
    basis: price.basis, inputs, formula: FORMULAS.pe,
  });
}
