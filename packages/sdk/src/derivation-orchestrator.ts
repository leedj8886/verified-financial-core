import {
  canonicalJson,
  deriveFreeCashFlow,
  deriveMarketCap,
  deriveTtmFlow,
} from "@verified-financial/core";
import {
  type CanonicalFact,
  type ConceptId,
  type FactPeriodSelector,
  type FactRequirement,
} from "@verified-financial/schema";

const FREE_CASH_FLOW = "cashFlow.freeCashFlow";
const MARKET_CAP = "market.cap";
const TTM_FLOW_CONCEPTS = new Set<ConceptId>([
  "income.revenue",
  "income.operatingProfit",
  "income.netProfit",
  "income.netProfitParent",
  "cashFlow.operatingCashFlow",
  "cashFlow.capex",
]);

interface MaterializedFacts {
  facts: CanonicalFact[];
  reasonCodes: string[];
}

function matchesRequirement(
  fact: CanonicalFact,
  requirement: FactRequirement,
): boolean {
  if (fact.concept !== requirement.conceptId) return false;
  if (requirement.period === undefined) return true;
  return fact.period.fiscalYear === requirement.period.fiscalYear
    && fact.period.fiscalQuarter === requirement.period.fiscalQuarter
    && fact.period.presentation === requirement.period.presentation;
}

function sortedFacts(facts: readonly CanonicalFact[]): CanonicalFact[] {
  return [...facts].sort((left, right) => left.factId.localeCompare(right.factId));
}

function usableMatches(
  facts: readonly CanonicalFact[],
  requirement: FactRequirement,
): CanonicalFact[] {
  return sortedFacts(
    facts.filter((fact) => fact.usable && matchesRequirement(fact, requirement)),
  );
}

function periodRequirement(
  conceptId: FactRequirement["conceptId"],
  required: boolean,
  period: FactPeriodSelector | undefined,
): FactRequirement {
  return {
    conceptId,
    required,
    ...(period === undefined ? {} : { period }),
  };
}

function dependencyRequirements(
  requirement: FactRequirement,
): FactRequirement[] {
  const dependencies: FactRequirement[] = [];
  if (requirement.conceptId === FREE_CASH_FLOW) {
    dependencies.push(
      periodRequirement(
        "cashFlow.operatingCashFlow",
        false,
        requirement.period,
      ),
      periodRequirement("cashFlow.capex", false, requirement.period),
    );
  }
  if (requirement.conceptId === MARKET_CAP) {
    dependencies.push(
      periodRequirement("market.price.close", false, requirement.period),
      periodRequirement(
        "market.shares.outstanding",
        false,
        requirement.period,
      ),
    );
  }
  const period = requirement.period;
  if (
    TTM_FLOW_CONCEPTS.has(requirement.conceptId)
    && period?.presentation === "ttm"
    && period.fiscalQuarter !== undefined
  ) {
    dependencies.push(
      periodRequirement(requirement.conceptId, false, {
        fiscalYear: period.fiscalYear,
        fiscalQuarter: period.fiscalQuarter,
        presentation: "ytd",
      }),
      periodRequirement(requirement.conceptId, false, {
        fiscalYear: period.fiscalYear - 1,
        presentation: "annual",
      }),
      periodRequirement(requirement.conceptId, false, {
        fiscalYear: period.fiscalYear - 1,
        fiscalQuarter: period.fiscalQuarter,
        presentation: "ytd",
      }),
    );
  }
  return dependencies;
}

export function expandDerivationRequirements(
  requirements: readonly FactRequirement[],
): FactRequirement[] {
  const expanded = new Map<string, FactRequirement>();
  const pending = [...requirements];
  while (pending.length > 0) {
    const requirement = pending.shift()!;
    const key = canonicalJson(requirement);
    if (expanded.has(key)) continue;
    expanded.set(key, requirement);
    pending.push(...dependencyRequirements(requirement));
  }
  return [...expanded.values()].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))
  );
}

function firstSuccessfulDerivation(
  candidateGroups: readonly CanonicalFact[][],
  derive: (inputs: CanonicalFact[]) => CanonicalFact,
): CanonicalFact | undefined {
  const visit = (
    groupIndex: number,
    inputs: CanonicalFact[],
  ): CanonicalFact | undefined => {
    if (groupIndex === candidateGroups.length) {
      try {
        return derive(inputs);
      } catch {
        return undefined;
      }
    }
    for (const candidate of candidateGroups[groupIndex] ?? []) {
      const result = visit(groupIndex + 1, [...inputs, candidate]);
      if (result !== undefined) return result;
    }
    return undefined;
  };
  return visit(0, []);
}

function materializeTtmFacts(
  baseFacts: readonly CanonicalFact[],
  expandedRequirements: readonly FactRequirement[],
): CanonicalFact[] {
  const available = [...baseFacts];
  for (const requirement of expandedRequirements) {
    const period = requirement.period;
    if (
      requirement.conceptId === FREE_CASH_FLOW
      || period?.presentation !== "ttm"
      || period.fiscalQuarter === undefined
      || usableMatches(available, requirement).length > 0
    ) {
      continue;
    }
    const currentYtd = usableMatches(available, {
      conceptId: requirement.conceptId,
      required: false,
      period: {
        fiscalYear: period.fiscalYear,
        fiscalQuarter: period.fiscalQuarter,
        presentation: "ytd",
      },
    });
    const previousAnnual = usableMatches(available, {
      conceptId: requirement.conceptId,
      required: false,
      period: {
        fiscalYear: period.fiscalYear - 1,
        presentation: "annual",
      },
    });
    const previousYtd = usableMatches(available, {
      conceptId: requirement.conceptId,
      required: false,
      period: {
        fiscalYear: period.fiscalYear - 1,
        fiscalQuarter: period.fiscalQuarter,
        presentation: "ytd",
      },
    });
    const derived = firstSuccessfulDerivation(
      [currentYtd, previousAnnual, previousYtd],
      ([current, annual, previous]) =>
        deriveTtmFlow({
          currentYtd: current!,
          previousAnnual: annual!,
          previousYtd: previous!,
        }),
    );
    if (derived !== undefined) available.push(derived);
  }
  return available;
}

function materializeFreeCashFlow(
  facts: readonly CanonicalFact[],
  requirement: FactRequirement,
): CanonicalFact | undefined {
  const operatingCashFlow = usableMatches(facts, periodRequirement(
    "cashFlow.operatingCashFlow",
    false,
    requirement.period,
  ));
  const capex = usableMatches(facts, periodRequirement(
    "cashFlow.capex",
    false,
    requirement.period,
  ));
  return firstSuccessfulDerivation(
    [operatingCashFlow, capex],
    ([operating, expenditure]) =>
      deriveFreeCashFlow(operating!, expenditure!),
  );
}

function materializeMarketCap(
  facts: readonly CanonicalFact[],
  requirement: FactRequirement,
): CanonicalFact | undefined {
  const prices = usableMatches(facts, periodRequirement(
    "market.price.close",
    false,
    requirement.period,
  ));
  const shares = usableMatches(facts, periodRequirement(
    "market.shares.outstanding",
    false,
    requirement.period,
  ));
  return firstSuccessfulDerivation(
    [prices, shares],
    ([price, outstanding]) => deriveMarketCap(price!, outstanding!),
  );
}

function supportsAutomaticDerivation(requirement: FactRequirement): boolean {
  if (
    requirement.conceptId === FREE_CASH_FLOW
    || requirement.conceptId === MARKET_CAP
  ) {
    return true;
  }
  return requirement.period?.presentation === "ttm"
    && TTM_FLOW_CONCEPTS.has(requirement.conceptId);
}

export function materializeRequestedFacts(
  baseFacts: readonly CanonicalFact[],
  originalRequirements: readonly FactRequirement[],
  expandedRequirements: readonly FactRequirement[],
): MaterializedFacts {
  const available = materializeTtmFacts(baseFacts, expandedRequirements);
  const selected = new Map<string, CanonicalFact>();
  const reasonCodes: string[] = [];

  for (const requirement of originalRequirements) {
    const direct = sortedFacts(
      baseFacts.filter((fact) => matchesRequirement(fact, requirement)),
    );
    const usableDirect = direct.filter((fact) => fact.usable);
    if (usableDirect.length > 0) {
      for (const fact of direct) selected.set(fact.factId, fact);
      continue;
    }

    let derived = usableMatches(available, requirement)[0];
    if (derived === undefined && requirement.conceptId === FREE_CASH_FLOW) {
      derived = materializeFreeCashFlow(available, requirement);
    } else if (
      derived === undefined
      && requirement.conceptId === MARKET_CAP
    ) {
      derived = materializeMarketCap(available, requirement);
    }
    if (derived !== undefined) {
      selected.set(derived.factId, derived);
      available.push(derived);
      continue;
    }

    for (const fact of direct) selected.set(fact.factId, fact);
    if (supportsAutomaticDerivation(requirement)) {
      reasonCodes.push(`DERIVATION_UNAVAILABLE:${requirement.conceptId}`);
    }
  }

  return {
    facts: sortedFacts([...selected.values()]),
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}
