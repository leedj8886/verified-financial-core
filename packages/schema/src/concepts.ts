import { z } from "zod";

export const CONCEPT_REGISTRY_VERSION = "1.0.0";

const conceptDefinitions = {
  "market.price.close": [
    "decimal",
    "instrument",
    "instant",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "market.shares.outstanding": [
    "decimal",
    "instrument",
    "instant",
    "shares",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "market.cap": [
    "decimal",
    "instrument",
    "instant",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "valuation.peTtm": [
    "decimal",
    "instrument",
    "instant",
    "ratio",
    ["ttm"],
  ],
  "valuation.pb": [
    "decimal",
    "instrument",
    "instant",
    "ratio",
    ["annual", "ttm"],
  ],
  "income.revenue": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "income.operatingProfit": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "income.netProfit": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "income.netProfitParent": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "income.epsBasic": [
    "decimal",
    "instrument",
    "duration",
    "currency-per-share",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "balance.assets": [
    "decimal",
    "company",
    "instant",
    "currency",
    ["quarter", "ytd", "annual"],
  ],
  "balance.liabilities": [
    "decimal",
    "company",
    "instant",
    "currency",
    ["quarter", "ytd", "annual"],
  ],
  "balance.equity": [
    "decimal",
    "company",
    "instant",
    "currency",
    ["quarter", "ytd", "annual"],
  ],
  "balance.cash": [
    "decimal",
    "company",
    "instant",
    "currency",
    ["quarter", "ytd", "annual"],
  ],
  "cashFlow.operatingCashFlow": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "cashFlow.capex": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "cashFlow.freeCashFlow": [
    "decimal",
    "company",
    "duration",
    "currency",
    ["quarter", "ytd", "annual", "ttm"],
  ],
  "profitability.roe": [
    "decimal",
    "company",
    "duration",
    "ratio",
    ["annual", "ttm"],
  ],
  "distribution.dividendPerShare": [
    "decimal",
    "instrument",
    "duration",
    "currency-per-share",
    ["annual"],
  ],
} as const;

export type ConceptId = keyof typeof conceptDefinitions;

export const ConceptIdSchema = z.enum(
  Object.keys(conceptDefinitions) as [ConceptId, ...ConceptId[]],
);

export interface ConceptDefinition {
  conceptId: ConceptId;
  valueType: "decimal" | "text" | "date" | "boolean";
  scope: "company" | "instrument";
  periodKind: "instant" | "duration";
  canonicalUnit: string;
  allowedPresentations: readonly (
    | "quarter"
    | "ytd"
    | "annual"
    | "ttm"
  )[];
}

function buildConceptRegistry(): Record<ConceptId, ConceptDefinition> {
  const registry = {} as Record<ConceptId, ConceptDefinition>;
  for (const conceptId of Object.keys(conceptDefinitions) as ConceptId[]) {
    const definition = conceptDefinitions[conceptId];
    registry[conceptId] = {
      conceptId,
      valueType: definition[0],
      scope: definition[1],
      periodKind: definition[2],
      canonicalUnit: definition[3],
      allowedPresentations: definition[4],
    };
  }
  return registry;
}

export const CONCEPT_REGISTRY = buildConceptRegistry();

export function getConceptDefinition(
  conceptId: ConceptId,
): ConceptDefinition {
  return CONCEPT_REGISTRY[conceptId];
}
