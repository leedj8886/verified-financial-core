import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLocalGateway } from "../packages/local-gateway/dist/index.js";
import type {
  FactPeriodSelector,
  FactRequest,
  VerifiedFactSet,
} from "../packages/schema/dist/index.js";

interface PrimaryCompany {
  code: string;
  name: string;
  baseline_revenue: number | null;
  latest_revenue: number | null;
  baseline_profit: number | null;
  latest_profit: number | null;
  baseline_market_cap: number | null;
  latest_market_cap: number | null;
}

interface IndustryInput {
  industry: string;
  companies: PrimaryCompany[];
}

const metricConcepts = {
  baseline_revenue: "income.revenue",
  latest_revenue: "income.revenue",
  baseline_profit: "income.netProfitParent",
  latest_profit: "income.netProfitParent",
  baseline_market_cap: "market.cap",
  latest_market_cap: "market.cap",
} as const;

type MetricKey = keyof typeof metricConcepts;

function optionValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] !== undefined) {
      values.push(process.argv[index + 1]!);
    }
  }
  return values;
}

function requiredOption(name: string): string {
  const value = optionValues(name)[0];
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function instrumentFor(code: string): string {
  return /^[569]/.test(code) ? `${code}.SH` : `${code}.SZ`;
}

async function loadIndustry(specification: string): Promise<IndustryInput> {
  const separator = specification.indexOf("=");
  if (separator < 1) throw new Error(`Invalid --industry: ${specification}`);
  const industry = specification.slice(0, separator);
  const path = resolve(specification.slice(separator + 1));
  const document = JSON.parse(await readFile(path, "utf8")) as {
    companies?: Array<Record<string, unknown>>;
  };
  const companies = (document.companies ?? []).map((company) => {
    const primary = (
      typeof company["primary"] === "object"
      && company["primary"] !== null
    )
      ? company["primary"] as Record<string, unknown>
      : company;
    const numberValue = (key: MetricKey): number | null =>
      typeof primary[key] === "number" && Number.isFinite(primary[key])
        ? primary[key] as number
        : null;
    return {
      code: String(company["code"]),
      name: String(company["name"]),
      baseline_revenue: numberValue("baseline_revenue"),
      latest_revenue: numberValue("latest_revenue"),
      baseline_profit: numberValue("baseline_profit"),
      latest_profit: numberValue("latest_profit"),
      baseline_market_cap: numberValue("baseline_market_cap"),
      latest_market_cap: numberValue("latest_market_cap"),
    };
  });
  return { industry, companies };
}

function request(
  instrument: string,
  asOf: string,
  period: FactPeriodSelector,
): FactRequest {
  return {
    instrument,
    requirements: [
      {
        conceptId: "income.revenue",
        required: true,
        period,
      },
      {
        conceptId: "income.netProfitParent",
        required: true,
        period,
      },
      {
        conceptId: "market.cap",
        required: true,
        period,
      },
    ],
    asOf,
    freshness: {
      maxAgeSeconds: 0,
      allowStaleOnProviderFailure: false,
      offline: false,
    },
  };
}

function usableValue(
  factSet: VerifiedFactSet,
  concept: string,
): string | null {
  return factSet.facts.find((fact) =>
    fact.concept === concept && fact.usable
  )?.value ?? null;
}

function hasStrictMarketCap(factSet: VerifiedFactSet): boolean {
  return factSet.facts.some((fact) =>
    fact.concept === "market.cap"
    && fact.usable
    && fact.derivation?.formulaId === "market-cap.price-times-shares.v1"
  );
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const result = Array<U>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return result;
}

const industryInputs = await Promise.all(
  optionValues("--industry").map(loadIndustry),
);
if (industryInputs.length === 0) throw new Error("At least one --industry is required");

const dataDirectory = resolve(requiredOption("--data-dir"));
const outputPath = resolve(requiredOption("--output"));
const concurrency = Number(optionValues("--concurrency")[0] ?? "3");
const local = createLocalGateway(dataDirectory);
const baselinePeriod: FactPeriodSelector = {
  fiscalYear: 2024,
  fiscalQuarter: 2,
  presentation: "ttm",
};
const latestPeriod: FactPeriodSelector = {
  fiscalYear: 2026,
  fiscalQuarter: 1,
  presentation: "ttm",
};

try {
  const reports = [];
  for (const input of industryInputs) {
    let completed = 0;
    const companyResults = await mapConcurrent(
      input.companies,
      concurrency,
      async (company) => {
        const instrument = instrumentFor(company.code);
        const [baseline, latest] = await Promise.all([
          local.gateway.getFacts(request(
            instrument,
            "2024-08-30T23:59:59+08:00",
            baselinePeriod,
          )),
          local.gateway.getFacts(request(
            instrument,
            "2026-07-29T23:59:59+08:00",
            latestPeriod,
          )),
        ]);
        completed += 1;
        if (completed % 5 === 0 || completed === input.companies.length) {
          process.stderr.write(
            `${input.industry}: ${completed}/${input.companies.length}\n`,
          );
        }
        const values = {
          baseline_revenue: usableValue(baseline, "income.revenue"),
          latest_revenue: usableValue(latest, "income.revenue"),
          baseline_profit: usableValue(baseline, "income.netProfitParent"),
          latest_profit: usableValue(latest, "income.netProfitParent"),
          baseline_market_cap: usableValue(baseline, "market.cap"),
          latest_market_cap: usableValue(latest, "market.cap"),
        };
        const financialComplete = [
          values.baseline_revenue,
          values.latest_revenue,
          values.baseline_profit,
          values.latest_profit,
        ].every((value) => value !== null);
        const marketComplete = [
          values.baseline_market_cap,
          values.latest_market_cap,
        ].every((value) => value !== null)
          && hasStrictMarketCap(baseline)
          && hasStrictMarketCap(latest);
        return {
          code: company.code,
          name: company.name,
          primary: company,
          values,
          financialComplete,
          marketComplete,
          fullComplete: financialComplete && marketComplete,
          baselineStatus: baseline.summary.overallStatus,
          latestStatus: latest.summary.overallStatus,
          unresolvedReasons: [
            ...(financialComplete && marketComplete ? [] : baseline.reasonCodes),
            ...(financialComplete && marketComplete ? [] : latest.reasonCodes),
          ],
        };
      },
    );

    const metricCoverage = Object.keys(metricConcepts).map((key) => {
      const metric = key as MetricKey;
      const denominator = companyResults.reduce((total, company) =>
        total + Math.abs(company.primary[metric] ?? 0), 0);
      const numerator = companyResults.reduce((total, company) =>
        company.values[metric] === null
          ? total
          : total + Math.abs(company.primary[metric] ?? 0), 0);
      return {
        metric,
        coveredCompanies: companyResults.filter((company) =>
          company.values[metric] !== null
        ).length,
        amountNumerator: numerator,
        amountDenominator: denominator,
        amountCoverageRatio: denominator === 0 ? 0 : numerator / denominator,
      };
    });
    const unresolvedReasons = new Map<string, number>();
    for (const company of companyResults) {
      for (const reason of new Set(company.unresolvedReasons)) {
        unresolvedReasons.set(reason, (unresolvedReasons.get(reason) ?? 0) + 1);
      }
    }
    reports.push({
      industry: input.industry,
      companyCount: companyResults.length,
      financialCompanyCount: companyResults.filter((company) =>
        company.financialComplete
      ).length,
      marketCompanyCount: companyResults.filter((company) =>
        company.marketComplete
      ).length,
      fullCompanyCount: companyResults.filter((company) =>
        company.fullComplete
      ).length,
      metricCoverage,
      unresolvedReasons: [...unresolvedReasons.entries()]
        .map(([reason, companyCount]) => ({ reason, companyCount }))
        .sort((left, right) =>
          right.companyCount - left.companyCount
          || left.reason.localeCompare(right.reason)
        ),
      companies: companyResults,
    });
  }
  const output = {
    generatedAt: new Date().toISOString(),
    baselineAsOf: "2024-08-30T23:59:59+08:00",
    baselinePeriod,
    latestAsOf: "2026-07-29T23:59:59+08:00",
    latestPeriod,
    amountCoveragePolicy:
      "sum(abs(primary amount)) for companies with a usable core fact / sum(abs(primary amount)) for all companies",
    reports,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
} finally {
  local.close();
}
