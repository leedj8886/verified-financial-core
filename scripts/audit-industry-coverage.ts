import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createDefaultProviders,
  createLocalGateway,
} from "../packages/local-gateway/dist/index.js";
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
type AuditScope = "financial" | "market";

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
  if (/^(?:[48]\d{5}|92\d{4})$/.test(code)) return `${code}.BJ`;
  return /^6/.test(code) ? `${code}.SH` : `${code}.SZ`;
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
  scope: AuditScope,
): FactRequest {
  const conceptIds = scope === "financial"
    ? ["income.revenue", "income.netProfitParent"] as const
    : ["market.cap"] as const;
  return {
    instrument,
    requirements: conceptIds.map((conceptId) => ({
      conceptId,
      required: true,
      period,
    })),
    asOf,
    freshness: {
      maxAgeSeconds: 0,
      allowStaleOnProviderFailure: false,
      offline: false,
    },
  };
}

function independentlyCorroborated(
  factSet: VerifiedFactSet,
  concept: string,
): boolean {
  return factSet.facts.some((fact) =>
    fact.concept === concept
    && fact.usable
    && fact.verification.independentUpstreamSourceIds.length >= 2
  );
}

function satisfiesRequiredFacts(
  factSet: VerifiedFactSet,
  factRequest: FactRequest,
): boolean {
  return factRequest.requirements.filter((requirement) => requirement.required)
    .every((requirement) => factSet.facts.some((fact) =>
      fact.concept === requirement.conceptId && fact.usable
    ));
}

function hasTransientFailure(factSet: VerifiedFactSet): boolean {
  return factSet.reasonCodes.some((reason) =>
    /^PROVIDER_FAILURE:[^:]+:(?:TIMEOUT|AUTH_REQUIRED|RATE_LIMITED|UPSTREAM_UNAVAILABLE)$/.test(
      reason,
    )
  );
}

async function withTransientRetry(
  factRequest: FactRequest,
  load: () => Promise<VerifiedFactSet>,
  retries: number,
  delayMs: number,
): Promise<VerifiedFactSet> {
  let result = await load();
  for (
    let attempt = 0;
    attempt < retries
      && !satisfiesRequiredFacts(result, factRequest)
      && hasTransientFailure(result);
    attempt += 1
  ) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    result = await load();
  }
  return result;
}

function asOfOption(name: string, fallback: string): string {
  const value = optionValues(name)[0] ?? fallback;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function reasonBucket(reason: string): string {
  if (
    reason.startsWith("REPORT_NOT_PUBLISHED_AS_OF:")
    || reason.endsWith(":REPORT_NOT_AVAILABLE_AS_OF")
  ) {
    return "expected-point-in-time-availability";
  }
  if (
    reason.includes(":STATEMENT_NOT_FOUND")
    || reason.includes(":STATEMENT_IMAGE_ONLY")
    || reason.includes(":TEXT_ENCODING_UNUSABLE")
    || reason.includes(":OCR_TEXT_UNUSABLE")
    || reason.includes(":COLUMN_LAYOUT_AMBIGUOUS")
    || reason.includes(":LABEL_NOT_FOUND")
  ) {
    return "official-statement-mapping";
  }
  if (reason.includes("_UNAVAILABLE_AS_OF:")) {
    return "historical-revision-unavailable";
  }
  if (
    reason.includes(":TIMEOUT")
    || reason.includes(":AUTH_REQUIRED")
    || reason.includes(":RATE_LIMITED")
    || reason.includes(":UPSTREAM_UNAVAILABLE")
  ) {
    return "transient-upstream";
  }
  return "other";
}

function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function repositoryDirty(): boolean | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
  } catch {
    return null;
  }
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
const transientRetries = Number(optionValues("--transient-retries")[0] ?? "2");
const transientRetryDelayMs = Number(
  optionValues("--transient-retry-delay-ms")[0] ?? "1000",
);
if (
  !Number.isInteger(transientRetries)
  || transientRetries < 0
  || !Number.isFinite(transientRetryDelayMs)
  || transientRetryDelayMs < 0
) {
  throw new Error("Invalid transient retry options");
}
const amountCoverageThreshold = Number(
  optionValues("--amount-coverage-threshold")[0] ?? "0.8",
);
if (
  !Number.isFinite(amountCoverageThreshold)
  || amountCoverageThreshold < 0
  || amountCoverageThreshold > 1
) {
  throw new Error(
    `Invalid --amount-coverage-threshold: ${amountCoverageThreshold}`,
  );
}
const baselineFinancialAsOf = asOfOption(
  "--baseline-financial-as-of",
  "2024-08-30T23:59:59+08:00",
);
const baselineMarketAsOf = asOfOption(
  "--baseline-market-as-of",
  baselineFinancialAsOf,
);
const latestFinancialAsOf = asOfOption(
  "--latest-financial-as-of",
  "2026-07-29T23:59:59+08:00",
);
const latestMarketAsOf = asOfOption(
  "--latest-market-as-of",
  latestFinancialAsOf,
);
const cninfoOcrEnabled = process.argv.includes("--cninfo-ocr");
const providerTimeoutMs = Number(
  optionValues("--provider-timeout-ms")[0]
    ?? (cninfoOcrEnabled ? "600000" : "30000"),
);
if (!Number.isFinite(providerTimeoutMs) || providerTimeoutMs <= 0) {
  throw new Error(`Invalid --provider-timeout-ms: ${providerTimeoutMs}`);
}
const providers = cninfoOcrEnabled
  ? createDefaultProviders({
      cninfo: {
        extractTextImplementation: (await import(
          "../packages/provider-cninfo-ocr/dist/index.js"
        )).createCninfoOcrTextExtractor({
          cacheDirectory: resolve(dataDirectory, "ocr-cache"),
        }),
      },
    })
  : createDefaultProviders();
const local = createLocalGateway(dataDirectory, providers, {
  providerTimeoutMs,
});
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
        const baselineFinancialRequest = request(
          instrument,
          baselineFinancialAsOf,
          baselinePeriod,
          "financial",
        );
        const latestFinancialRequest = request(
          instrument,
          latestFinancialAsOf,
          latestPeriod,
          "financial",
        );
        const baselineMarketRequest = request(
          instrument,
          baselineMarketAsOf,
          baselinePeriod,
          "market",
        );
        const latestMarketRequest = request(
          instrument,
          latestMarketAsOf,
          latestPeriod,
          "market",
        );
        const [
          baselineFinancial,
          latestFinancial,
          baselineMarket,
          latestMarket,
        ] = await Promise.all([
          withTransientRetry(
            baselineFinancialRequest,
            () => local.gateway.getFacts(baselineFinancialRequest),
            transientRetries,
            transientRetryDelayMs,
          ),
          withTransientRetry(
            latestFinancialRequest,
            () => local.gateway.getFacts(latestFinancialRequest),
            transientRetries,
            transientRetryDelayMs,
          ),
          withTransientRetry(
            baselineMarketRequest,
            () => local.gateway.getFacts(baselineMarketRequest),
            transientRetries,
            transientRetryDelayMs,
          ),
          withTransientRetry(
            latestMarketRequest,
            () => local.gateway.getFacts(latestMarketRequest),
            transientRetries,
            transientRetryDelayMs,
          ),
        ]);
        completed += 1;
        if (completed % 5 === 0 || completed === input.companies.length) {
          process.stderr.write(
            `${input.industry}: ${completed}/${input.companies.length}\n`,
          );
        }
        const values = {
          baseline_revenue: usableValue(
            baselineFinancial,
            "income.revenue",
          ),
          latest_revenue: usableValue(latestFinancial, "income.revenue"),
          baseline_profit: usableValue(
            baselineFinancial,
            "income.netProfitParent",
          ),
          latest_profit: usableValue(
            latestFinancial,
            "income.netProfitParent",
          ),
          baseline_market_cap: usableValue(baselineMarket, "market.cap"),
          latest_market_cap: usableValue(latestMarket, "market.cap"),
        };
        const independentlyCovered = {
          baseline_revenue: independentlyCorroborated(
            baselineFinancial,
            "income.revenue",
          ),
          latest_revenue: independentlyCorroborated(
            latestFinancial,
            "income.revenue",
          ),
          baseline_profit: independentlyCorroborated(
            baselineFinancial,
            "income.netProfitParent",
          ),
          latest_profit: independentlyCorroborated(
            latestFinancial,
            "income.netProfitParent",
          ),
          baseline_market_cap: independentlyCorroborated(
            baselineMarket,
            "market.cap",
          ),
          latest_market_cap: independentlyCorroborated(
            latestMarket,
            "market.cap",
          ),
        };
        const baselineFinancialComplete = [
          values.baseline_revenue,
          values.baseline_profit,
        ].every((value) => value !== null);
        const latestFinancialComplete = [
          values.latest_revenue,
          values.latest_profit,
        ].every((value) => value !== null);
        const financialComplete = baselineFinancialComplete
          && latestFinancialComplete;
        const baselineMarketComplete = values.baseline_market_cap !== null
          && hasStrictMarketCap(baselineMarket);
        const latestMarketComplete = values.latest_market_cap !== null
          && hasStrictMarketCap(latestMarket);
        const marketComplete = baselineMarketComplete && latestMarketComplete;
        return {
          code: company.code,
          name: company.name,
          primary: company,
          values,
          independentlyCovered,
          baselineFinancialComplete,
          latestFinancialComplete,
          financialComplete,
          baselineMarketComplete,
          latestMarketComplete,
          marketComplete,
          fullComplete: financialComplete && marketComplete,
          baselineFinancialStatus: baselineFinancial.summary.overallStatus,
          latestFinancialStatus: latestFinancial.summary.overallStatus,
          baselineMarketStatus: baselineMarket.summary.overallStatus,
          latestMarketStatus: latestMarket.summary.overallStatus,
          unresolvedReasons: [
            ...(baselineFinancialComplete
              ? []
              : baselineFinancial.reasonCodes),
            ...(latestFinancialComplete ? [] : latestFinancial.reasonCodes),
            ...(baselineMarketComplete ? [] : baselineMarket.reasonCodes),
            ...(latestMarketComplete ? [] : latestMarket.reasonCodes),
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
      const independentNumerator = companyResults.reduce((total, company) =>
        company.independentlyCovered[metric]
          ? total + Math.abs(company.primary[metric] ?? 0)
          : total, 0);
      return {
        metric,
        coveredCompanies: companyResults.filter((company) =>
          company.values[metric] !== null
        ).length,
        amountNumerator: numerator,
        amountDenominator: denominator,
        amountCoverageRatio: denominator === 0 ? 0 : numerator / denominator,
        independentlyCoveredCompanies: companyResults.filter((company) =>
          company.independentlyCovered[metric]
        ).length,
        independentAmountNumerator: independentNumerator,
        independentAmountCoverageRatio: denominator === 0
          ? 0
          : independentNumerator / denominator,
      };
    });
    const failedBaselineMetrics = metricCoverage.filter(({ metric }) =>
      metric === "baseline_revenue" || metric === "baseline_profit"
    ).filter(({ amountCoverageRatio }) =>
      amountCoverageRatio < amountCoverageThreshold
    );
    const unresolvedReasons = new Map<string, number>();
    const unresolvedReasonBuckets = new Map<string, number>();
    for (const company of companyResults) {
      for (const reason of new Set(company.unresolvedReasons)) {
        unresolvedReasons.set(reason, (unresolvedReasons.get(reason) ?? 0) + 1);
      }
      const companyBuckets = new Set(
        company.unresolvedReasons.map(reasonBucket),
      );
      if (companyBuckets.size > 1) companyBuckets.delete("other");
      for (const bucket of companyBuckets) {
        unresolvedReasonBuckets.set(
          bucket,
          (unresolvedReasonBuckets.get(bucket) ?? 0) + 1,
        );
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
      verificationGate: {
        status: failedBaselineMetrics.length === 0 ? "PASS" : "FAIL",
        amountCoverageThreshold,
        failedMetrics: failedBaselineMetrics.map(({ metric }) => metric),
      },
      metricCoverage,
      unresolvedReasons: [...unresolvedReasons.entries()]
        .map(([reason, companyCount]) => ({ reason, companyCount }))
        .sort((left, right) =>
          right.companyCount - left.companyCount
          || left.reason.localeCompare(right.reason)
        ),
      unresolvedReasonBuckets: [...unresolvedReasonBuckets.entries()]
        .map(([bucket, companyCount]) => ({ bucket, companyCount }))
        .sort((left, right) =>
          right.companyCount - left.companyCount
          || left.bucket.localeCompare(right.bucket)
        ),
      companies: companyResults,
    });
  }
  const output = {
    generatedAt: new Date().toISOString(),
    cninfoOcrEnabled,
    providerTimeoutMs,
    coreCommit: currentCommit(),
    coreDirty: repositoryDirty(),
    baselineFinancialAsOf,
    baselineMarketAsOf,
    baselineKnowledgeMode: baselineFinancialAsOf === baselineMarketAsOf
      ? "aligned-as-of"
      : "split-as-of-post-disclosure",
    baselinePeriod,
    latestFinancialAsOf,
    latestMarketAsOf,
    latestKnowledgeMode: latestFinancialAsOf === latestMarketAsOf
      ? "aligned-as-of"
      : "split-as-of",
    latestPeriod,
    amountCoverageThreshold,
    transientRetryPolicy: {
      retries: transientRetries,
      delayMs: transientRetryDelayMs,
      onlyWhenRequiredFactsMissing: true,
    },
    amountCoveragePolicy:
      "sum(abs(primary amount)) for companies with a usable core fact / sum(abs(primary amount)) for all companies",
    independentCoveragePolicy:
      "the usable core fact has at least two independent upstream source IDs",
    reports,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
} finally {
  local.close();
}
