import {
  buildFactSet,
  canonicalJson,
  stableId,
  verifyAndMaterializeFact,
} from "@verified-financial/core";
import {
  ProviderFailure,
  ProviderRequestSchema,
  parseProviderBatch,
  type ProviderBatch,
  type ProviderCapability,
  type ProviderIssue,
  type SourceProvider,
} from "@verified-financial/provider-contract";
import {
  FactRequestSchema,
  VERIFIED_FACT_SET_SCHEMA_VERSION,
  isAvailableAsOf,
  type Company,
  type CanonicalFact,
  type FactRequirement,
  type FactRequest,
  type FactSetTemporalContext,
  type Instrument,
  type Observation,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import {
  type CachedFactSet,
  type ContentAddressedSnapshotStore,
  type FactExplanation,
  type MetadataStore,
} from "@verified-financial/storage";
import { Decimal } from "decimal.js";
import {
  SyntacticInstrumentResolver,
  type InstrumentResolution,
  type InstrumentResolver,
} from "./identity.js";
import {
  expandDerivationRequirements,
  materializeRequestedFacts,
} from "./derivation-orchestrator.js";

const DEFAULT_VALIDATION_RULES_VERSION = "1.15.0";
const MARKET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const PROVIDER_MAPPING_REASON_CODES = new Set([
  "STATEMENT_NOT_FOUND",
  "STATEMENT_IMAGE_ONLY",
  "TEXT_ENCODING_UNUSABLE",
  "COLUMN_LAYOUT_AMBIGUOUS",
  "LABEL_NOT_FOUND",
]);

export class GatewayError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_INPUT" | "STORAGE_ERROR";

  constructor(
    code: GatewayError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayError";
    this.code = code;
  }
}

export interface FinancialGatewayOptions {
  providers: SourceProvider[];
  metadata: MetadataStore;
  snapshots: ContentAddressedSnapshotStore;
  resolver?: InstrumentResolver;
  now?: () => string;
  providerTimeoutMs?: number;
  schemaVersion?: typeof VERIFIED_FACT_SET_SCHEMA_VERSION;
  validationRulesVersion?: string;
}

interface ProviderOutcome {
  batch?: ProviderBatch;
  issues: ProviderIssue[];
  requirements: FactRequirement[];
}

interface NormalizedFreshness {
  maxAgeSeconds: number;
  allowStaleOnProviderFailure: boolean;
  offline: boolean;
}

interface AssembledFactSet {
  factSet: VerifiedFactSet;
  lineageFacts: CanonicalFact[];
  observations: Observation[];
  mappingVersions: string[];
}

function providerReason(issue: ProviderIssue): string {
  if (issue.reasonCode === "REPORT_NOT_AVAILABLE_AS_OF") {
    return `REPORT_NOT_PUBLISHED_AS_OF:${issue.providerId}`;
  }
  if (
    issue.reasonCode !== undefined
    && PROVIDER_MAPPING_REASON_CODES.has(issue.reasonCode)
  ) {
    return `PROVIDER_MAPPING_FAILURE:${issue.providerId}:${issue.reasonCode}`;
  }
  return `PROVIDER_FAILURE:${issue.providerId}:${issue.code}`;
}

function selectorEndDate(
  period: NonNullable<FactRequirement["period"]>,
): string {
  const monthDay = period.presentation === "annual"
    ? "12-31"
    : {
        1: "03-31",
        2: "06-30",
        3: "09-30",
        4: "12-31",
      }[period.fiscalQuarter ?? 4];
  return `${period.fiscalYear}-${monthDay}`;
}

function sameRequirement(
  left: FactRequirement,
  right: FactRequirement,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function providerInputReasons(
  outcomes: readonly ProviderOutcome[],
  materializedReasonCodes: readonly string[],
  asOf: string,
): string[] {
  const missing = new Set(
    materializedReasonCodes.filter((reasonCode) =>
      reasonCode.startsWith("DERIVATION_INPUT_MISSING:")
    ),
  );
  return outcomes.flatMap((outcome) =>
    outcome.requirements.flatMap((requirement) => {
      const period = requirement.period;
      if (period === undefined) return [];
      const dependencyCode =
        `DERIVATION_INPUT_MISSING:${requirement.conceptId}:`
        + `${selectorEndDate(period)}:${period.presentation}`;
      if (!missing.has(dependencyCode)) return [];
      const issue = outcome.issues.find((candidate) =>
        candidate.requirements?.some((issueRequirement) =>
          sameRequirement(issueRequirement, requirement)
        ) === true
      );
      const providerId = outcome.batch?.providerId
        ?? issue?.providerId;
      if (providerId === undefined) return [];
      const unavailable = outcome.batch?.observations.some((observation) =>
        observationMatchesRequirement(observation, requirement)
        && !isAvailableAsOf(observation.availability, asOf)
      ) === true;
      if (unavailable) {
        const dependency = `${requirement.conceptId}:`
          + `${selectorEndDate(period)}:${period.presentation}`;
        return [
          `DERIVATION_INPUT_UNAVAILABLE_AS_OF:${dependency}`,
          `PROVIDER_INPUT_UNAVAILABLE_AS_OF:${providerId}:${dependency}`,
        ];
      }
      return [
        `PROVIDER_INPUT_MISSING:${providerId}:${requirement.conceptId}:`
        + `${selectorEndDate(period)}:${period.presentation}:`
        + `${issue?.reasonCode ?? issue?.code ?? "EMPTY_RESPONSE"}`,
      ];
    })
  );
}

function observationMatchesRequirement(
  observation: Observation,
  requirement: FactRequirement,
): boolean {
  if (observation.concept !== requirement.conceptId) return false;
  if (requirement.period === undefined) return true;
  return observation.period.fiscalYear === requirement.period.fiscalYear
    && observation.period.fiscalQuarter === requirement.period.fiscalQuarter
    && observation.period.presentation === requirement.period.presentation;
}

function unmappedInputReasons(batches: readonly ProviderBatch[]): string[] {
  return batches.flatMap((batch) =>
    batch.unmapped.flatMap((unmapped) => {
      if (
        unmapped.intendedConceptId === undefined
        || unmapped.intendedPeriod === undefined
      ) {
        return [];
      }
      return [
        `PROVIDER_INPUT_UNMAPPED:${batch.providerId}:`
        + `${unmapped.intendedConceptId}:`
        + `${unmapped.intendedPeriod.endDate}:`
        + `${unmapped.intendedPeriod.presentation}`,
      ];
    })
  );
}

function unavailableReason(observation: Observation): string {
  return `NOT_AVAILABLE_AS_OF:${observation.provenance.providerId}`;
}

function capabilityForRequirement(
  requirement: FactRequirement,
): ProviderCapability {
  const concept = requirement.conceptId;
  if (concept.startsWith("market.")) return "market";
  if (concept.startsWith("valuation.")) return "valuation";
  if (concept.startsWith("distribution.")) return "dividends";
  return "financials";
}

function requirementsForProvider(
  provider: SourceProvider,
  instrument: Instrument,
  requirements: readonly FactRequirement[],
): FactRequirement[] {
  const capabilities = new Set(provider.capabilities);
  return requirements.filter((requirement) =>
    capabilities.has(capabilityForRequirement(requirement))
    && (provider.supportsRequirement?.(instrument, requirement) ?? true)
  );
}

function supportsRequirement(
  provider: SourceProvider,
  instrument: Instrument,
  requirement: FactRequirement,
): boolean {
  return provider.capabilities.includes(capabilityForRequirement(requirement))
    && (provider.supportsRequirement?.(instrument, requirement) ?? true);
}

function supportsInstrument(
  provider: SourceProvider,
  instrument: Instrument,
): boolean {
  return provider.supportsInstrument?.(instrument) ?? true;
}

export function defaultMaxAgeSeconds(
  requirements: readonly FactRequirement[],
): number {
  return requirements.some((requirement) => {
      const capability = capabilityForRequirement(requirement);
      return capability === "market" || capability === "valuation";
    })
    ? 60
    : 86_400;
}

function normalizeFreshness(request: FactRequest): NormalizedFreshness {
  return {
    maxAgeSeconds: request.freshness?.maxAgeSeconds
      ?? defaultMaxAgeSeconds(request.requirements),
    allowStaleOnProviderFailure:
      request.freshness?.allowStaleOnProviderFailure ?? true,
    offline: request.freshness?.offline ?? false,
  };
}

function cacheAgeSeconds(cached: CachedFactSet, now: string): number {
  return Math.max(
    0,
    (Date.parse(now) - Date.parse(cached.cachedAt)) / 1000,
  );
}

function requestCacheKey(
  resolution: InstrumentResolution,
  request: FactRequest,
  schemaVersion: typeof VERIFIED_FACT_SET_SCHEMA_VERSION,
  validationRulesVersion: string,
): string {
  return stableId("request", {
    schemaVersion,
    validationRulesVersion,
    instrumentId: resolution.instrument.instrumentId,
    requirements: [...request.requirements].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    ),
    asOf: request.asOf,
    knowledgeAsOf: request.knowledgeAsOf ?? request.asOf,
  });
}

function requestKnowledgeAsOf(
  request: Pick<FactRequest, "asOf" | "knowledgeAsOf">,
): string {
  return request.knowledgeAsOf ?? request.asOf;
}

function buildTemporalContext(
  request: FactRequest,
  facts: readonly CanonicalFact[],
  observations: readonly Observation[],
): FactSetTemporalContext {
  const effectiveAsOf = request.asOf;
  const knowledgeAsOf = requestKnowledgeAsOf(request);
  const observationsById = new Map(
    observations.map((observation) => [observation.observationId, observation]),
  );
  return {
    effectiveAsOf,
    knowledgeAsOf,
    mode: Date.parse(knowledgeAsOf) === Date.parse(effectiveAsOf)
      ? "point-in-time"
      : "post-disclosure",
    facts: [...facts]
      .sort((left, right) => left.factId.localeCompare(right.factId))
      .map((fact) => {
        const evidence = fact.observationIds
          .map((observationId) => observationsById.get(observationId))
          .filter((observation): observation is Observation =>
            observation?.availability.publishedAt !== undefined
          );
        const evidenceAvailableAt = evidence
          .map((observation) => observation.availability.publishedAt!)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
        if (evidenceAvailableAt === undefined) {
          throw new Error(`FACT_TEMPORAL_EVIDENCE_MISSING:${fact.factId}`);
        }
        const postEffectiveDateObservationIds = evidence
          .filter((observation) =>
            Date.parse(observation.availability.publishedAt!)
              > Date.parse(effectiveAsOf)
          )
          .map((observation) => observation.observationId)
          .sort();
        return {
          factId: fact.factId,
          evidenceAvailableAt,
          knownAtEffectiveAsOf: postEffectiveDateObservationIds.length === 0,
          postEffectiveDateObservationIds,
        };
      }),
  };
}

function matchesRequest(
  observation: Observation,
  request: FactRequest,
): boolean {
  const effectiveMarketDate = MARKET_DATE_FORMATTER.format(
    new Date(request.asOf),
  );
  return request.requirements.some((requirement) => {
    if (requirement.conceptId !== observation.concept) return false;
    if (
      requirement.period === undefined
      && (
        requirement.conceptId.startsWith("market.")
        || requirement.conceptId.startsWith("valuation.")
      )
      && (
        observation.period.kind !== "instant"
        || observation.period.endDate !== effectiveMarketDate
      )
    ) {
      return false;
    }
    if (requirement.period === undefined) return true;
    return observation.period.fiscalYear === requirement.period.fiscalYear
      && observation.period.fiscalQuarter
        === requirement.period.fiscalQuarter
      && observation.period.presentation === requirement.period.presentation;
  });
}

function compatibilitySemanticKey(observation: Observation): string {
  return canonicalJson({
    companyId: observation.companyId,
    instrumentId: observation.instrumentId,
    concept: observation.concept,
    unit: observation.unit,
    period: observation.period,
    basis: observation.basis,
  });
}

function compatibilityGroupKey(observation: Observation): string {
  return canonicalJson({
    semanticKey: compatibilitySemanticKey(observation),
    reportingVersion: observation.reportingVersion ?? {
      kind: "unversioned-current-view",
    },
  });
}

function observationDiscrepancyPercent(
  left: Observation,
  right: Observation,
): Decimal {
  const leftValue = new Decimal(left.value).mul(left.scale);
  const rightValue = new Decimal(right.value).mul(right.scale);
  const denominator = Decimal.min(leftValue.abs(), rightValue.abs());
  if (denominator.isZero()) {
    return leftValue.eq(rightValue) ? new Decimal(0) : new Decimal(Infinity);
  }
  return leftValue.minus(rightValue).abs().div(denominator).mul(100);
}

function reportingVersionRank(observation: Observation): number {
  return {
    "original-filing": 0,
    "later-comparative": 1,
    "explicit-restatement": 2,
  }[observation.reportingVersion?.kind ?? "original-filing"];
}

function groupCompatibleObservations(
  observations: readonly Observation[],
): Map<string, Observation[]> {
  const groups = new Map<string, Observation[]>();
  const versionedBySemantic = new Map<string, Map<string, Observation[]>>();
  for (const observation of observations) {
    if (observation.reportingVersion === undefined) continue;
    const semanticKey = compatibilitySemanticKey(observation);
    const groupKey = compatibilityGroupKey(observation);
    const semanticGroups = versionedBySemantic.get(semanticKey) ?? new Map();
    const group = semanticGroups.get(groupKey) ?? [];
    group.push(observation);
    semanticGroups.set(groupKey, group);
    versionedBySemantic.set(semanticKey, semanticGroups);
    groups.set(groupKey, group);
  }
  for (const observation of observations) {
    if (observation.reportingVersion !== undefined) continue;
    const candidates = [...(
      versionedBySemantic.get(compatibilitySemanticKey(observation))?.entries()
        ?? []
    )].map(([groupKey, group]) => {
      const minimumDiscrepancy = Decimal.min(
        ...group.map((candidate) =>
          observationDiscrepancyPercent(observation, candidate)
        ),
      );
      const representative = [...group].sort((left, right) =>
        reportingVersionRank(right) - reportingVersionRank(left)
        || (right.reportingVersion?.sourcePeriodEndDate ?? "")
          .localeCompare(left.reportingVersion?.sourcePeriodEndDate ?? "")
      )[0]!;
      return { groupKey, minimumDiscrepancy, representative };
    }).sort((left, right) =>
      reportingVersionRank(right.representative)
        - reportingVersionRank(left.representative)
      || (right.representative.reportingVersion?.sourcePeriodEndDate ?? "")
        .localeCompare(
          left.representative.reportingVersion?.sourcePeriodEndDate ?? "",
        )
      || left.minimumDiscrepancy.comparedTo(right.minimumDiscrepancy)
      || left.groupKey.localeCompare(right.groupKey)
    );
    const matchedCandidates = candidates.filter((candidate) =>
      candidate.minimumDiscrepancy.lte(1)
    );
    const groupKey = (matchedCandidates[0] ?? candidates[0])?.groupKey
      ?? compatibilityGroupKey(observation);
    const group = groups.get(groupKey) ?? [];
    group.push(observation);
    groups.set(groupKey, group);
  }
  return groups;
}

function mergeInstruments(
  resolution: InstrumentResolution,
  batches: readonly ProviderBatch[],
  company: Company,
): Instrument[] {
  const providerInstruments = batches
    .flatMap((batch) => batch.instruments)
    .filter((instrument) => instrument.companyId === company.companyId);
  const candidates = [
    ...providerInstruments,
    ...(providerInstruments.some((instrument) =>
      instrument.instrumentId === resolution.instrument.instrumentId
    ) || resolution.instrument.companyId !== company.companyId
      ? []
      : [resolution.instrument]),
  ].sort((left, right) =>
    left.instrumentId.localeCompare(right.instrumentId)
    || canonicalJson(left).localeCompare(canonicalJson(right))
  );
  const byId = new Map<string, Instrument>();
  for (const instrument of candidates) {
    if (!byId.has(instrument.instrumentId)) {
      byId.set(instrument.instrumentId, instrument);
    }
  }
  return [...byId.values()];
}

function chooseCompany(
  resolution: InstrumentResolution,
  batches: readonly ProviderBatch[],
): Company {
  const matching = batches
    .filter((batch) => batch.company.companyId === resolution.company.companyId)
    .sort((left, right) => {
      const observationDifference =
        Number(right.observations.length > 0)
        - Number(left.observations.length > 0);
      if (observationDifference !== 0) return observationDifference;
      const resolvedNameDifference =
        Number(
          right.company.legalName !== right.instruments[0]?.instrumentId,
        )
        - Number(
          left.company.legalName !== left.instruments[0]?.instrumentId,
        );
      if (resolvedNameDifference !== 0) return resolvedNameDifference;
      const jurisdictionDifference =
        Number(right.company.jurisdiction === resolution.company.jurisdiction)
        - Number(left.company.jurisdiction === resolution.company.jurisdiction);
      if (jurisdictionDifference !== 0) return jurisdictionDifference;
      return canonicalJson(left.company).localeCompare(
        canonicalJson(right.company),
      );
    });
  return matching[0]?.company ?? resolution.company;
}

function normalizeThrownIssue(
  provider: SourceProvider,
  error: unknown,
  aborted: boolean,
): ProviderIssue {
  if (error instanceof ProviderFailure) return error.issue;
  return {
    providerId: provider.providerId,
    code: aborted ? "TIMEOUT" : "PARSE_FAILED",
    message: error instanceof Error ? error.message : "Unknown provider failure",
    retryable: aborted,
  };
}

export class FinancialGateway {
  readonly providers: readonly SourceProvider[];
  readonly metadata: MetadataStore;
  readonly snapshots: ContentAddressedSnapshotStore;
  readonly resolver: InstrumentResolver;
  private readonly now: () => string;
  private readonly providerTimeoutMs: number;
  private readonly schemaVersion: typeof VERIFIED_FACT_SET_SCHEMA_VERSION;
  private readonly validationRulesVersion: string;

  constructor(options: FinancialGatewayOptions) {
    this.providers = [...options.providers].sort((left, right) =>
      left.providerId.localeCompare(right.providerId)
    );
    this.metadata = options.metadata;
    this.snapshots = options.snapshots;
    this.resolver = options.resolver ?? new SyntacticInstrumentResolver();
    this.now = options.now ?? (() => new Date().toISOString());
    this.providerTimeoutMs = options.providerTimeoutMs ?? 30_000;
    this.schemaVersion = options.schemaVersion
      ?? VERIFIED_FACT_SET_SCHEMA_VERSION;
    this.validationRulesVersion = options.validationRulesVersion
      ?? DEFAULT_VALIDATION_RULES_VERSION;
  }

  async resolveInstrument(input: string): Promise<InstrumentResolution> {
    try {
      return await this.resolver.resolve(input);
    } catch (error) {
      throw new GatewayError(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid instrument",
        { cause: error },
      );
    }
  }

  private async fetchProvider(
    provider: SourceProvider,
    request: ReturnType<typeof ProviderRequestSchema.parse>,
    startedAt: string,
  ): Promise<ProviderOutcome> {
    const requestId = this.metadata.startProviderRequest(
      provider.providerId,
      request,
      startedAt,
    );
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProviderFailure({
          providerId: provider.providerId,
          code: "TIMEOUT",
          message: `Provider timed out after ${this.providerTimeoutMs}ms`,
          retryable: true,
        }));
      }, this.providerTimeoutMs);
    });
    try {
      const value = await Promise.race([
        provider.fetch(request, {
          signal: controller.signal,
          now: startedAt,
          snapshots: this.snapshots,
        }),
        timeoutFailure,
      ]);
      const batch = parseProviderBatch(provider, value);
      const issues = [...batch.issues];
      if (
        batch.observations.length === 0
        && batch.unmapped.length === 0
        && issues.length === 0
      ) {
        issues.push({
          providerId: provider.providerId,
          code: "EMPTY_RESPONSE",
          message: "Provider returned no observations",
          retryable: false,
        });
      }
      this.metadata.finishProviderRequest(
        requestId,
        "succeeded",
        issues,
        this.now(),
      );
      return {
        batch,
        issues,
        requirements: [...request.requirements],
      };
    } catch (error) {
      const issue = normalizeThrownIssue(
        provider,
        error,
        controller.signal.aborted,
      );
      this.metadata.finishProviderRequest(
        requestId,
        "failed",
        [issue],
        this.now(),
      );
      return {
        issues: [issue],
        requirements: [...request.requirements],
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private assembleFactSet(
    request: FactRequest,
    fetchRequirements: readonly FactRequirement[],
    resolution: InstrumentResolution,
    startedAt: string,
    outcomes: readonly ProviderOutcome[],
    extraReasonCodes: readonly string[] = [],
  ): AssembledFactSet {
    const batches = outcomes.flatMap((outcome) =>
      outcome.batch === undefined ? [] : [outcome.batch]
    );
    const issues = outcomes.flatMap((outcome) => outcome.issues);
    const fetchRequest: FactRequest = {
      ...request,
      requirements: [...fetchRequirements],
    };
    const requestedObservations = batches
      .flatMap((batch) => batch.observations)
      .filter((observation) => matchesRequest(observation, fetchRequest));
    const instrumentScopeReasons = requestedObservations
      .filter((observation) =>
        observation.instrumentId !== undefined
        && observation.instrumentId !== resolution.instrument.instrumentId
      )
      .map((observation) =>
        `INSTRUMENT_SCOPE_MISMATCH:${observation.provenance.providerId}`
      );
    const allObservations = requestedObservations.filter((observation) =>
      observation.instrumentId === undefined
      || observation.instrumentId === resolution.instrument.instrumentId
    );
    const knowledgeAsOf = requestKnowledgeAsOf(request);
    const eligibleObservations = allObservations.filter((observation) =>
      isAvailableAsOf(observation.availability, knowledgeAsOf)
    );
    const unavailableReasons = allObservations
      .filter((observation) =>
        !isAvailableAsOf(observation.availability, knowledgeAsOf)
      )
      .map(unavailableReason);
    const groups = groupCompatibleObservations(eligibleObservations);
    const baseFacts = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, observations]) => verifyAndMaterializeFact(observations));
    const materialized = materializeRequestedFacts(
      baseFacts,
      request.requirements,
      fetchRequirements,
    );
    const facts = materialized.facts;
    const validations = facts.map((fact) => fact.verification);
    const company = chooseCompany(resolution, batches);
    const sameCompanyBatches = batches.filter(
      (batch) => batch.company.companyId === company.companyId,
    );
    const companyConflictReasons = batches.length === sameCompanyBatches.length
      ? []
      : ["PROVIDER_COMPANY_IDENTITY_CONFLICT"];
    const reasonCodes = [
      ...issues.map(providerReason),
      ...providerInputReasons(outcomes, materialized.reasonCodes, knowledgeAsOf),
      ...unmappedInputReasons(sameCompanyBatches),
      ...unavailableReasons,
      ...instrumentScopeReasons,
      ...companyConflictReasons,
      ...materialized.reasonCodes,
      ...extraReasonCodes,
    ];
    const mappingVersions = batches.flatMap(
      (batch) => batch.mappingVersions,
    );
    const lineageFacts = materialized.lineageFacts.filter((fact) =>
      fact.companyId === company.companyId
    );
    const companyFacts = facts.filter((fact) =>
      fact.companyId === company.companyId
    );
    const companyObservations = eligibleObservations.filter(
      (observation) => observation.companyId === company.companyId,
    );
    return {
      factSet: buildFactSet({
        schemaVersion: this.schemaVersion,
        request,
        generatedAt: startedAt,
        company,
        instruments: mergeInstruments(resolution, sameCompanyBatches, company),
        facts: companyFacts,
        unmapped: sameCompanyBatches.flatMap((batch) => batch.unmapped),
        validations: validations.filter((validation) =>
          facts.some((fact) =>
            fact.companyId === company.companyId
            && fact.verification.verificationId
              === validation.verificationId
          )
        ),
        rawSnapshotIds: sameCompanyBatches.flatMap((batch) =>
          batch.rawSnapshots.map((snapshot) => snapshot.snapshotId)
        ),
        mappingVersions,
        validationRulesVersion: this.validationRulesVersion,
        temporalContext: buildTemporalContext(
          request,
          companyFacts,
          companyObservations,
        ),
        reasonCodes,
      }),
      lineageFacts,
      observations: companyObservations,
      mappingVersions,
    };
  }

  private persistFactSet(
    assembled: AssembledFactSet,
    cacheKey?: string,
  ): void {
    try {
      this.metadata.putFactSet(
        assembled.factSet,
        assembled.observations,
        assembled.mappingVersions,
        cacheKey,
        assembled.lineageFacts,
      );
    } catch (error) {
      throw new GatewayError(
        "STORAGE_ERROR",
        "Failed to persist FactSet",
        { cause: error },
      );
    }
  }

  private readCachedFactSet(cacheKey: string): CachedFactSet | undefined {
    try {
      return this.metadata.getLatestCachedFactSet(cacheKey);
    } catch (error) {
      throw new GatewayError(
        "STORAGE_ERROR",
        "Failed to read cached FactSet",
        { cause: error },
      );
    }
  }

  private replayCachedFactSet(
    cached: CachedFactSet,
    request: FactRequest,
    additionalReasonCodes: readonly string[],
  ): VerifiedFactSet {
    const factSet = buildFactSet({
      schemaVersion: this.schemaVersion,
      request,
      generatedAt: cached.factSet.generatedAt,
      company: cached.factSet.company,
      instruments: cached.factSet.instruments,
      facts: cached.factSet.facts,
      unmapped: cached.factSet.unmapped,
      validations: cached.factSet.validations,
      rawSnapshotIds: cached.factSet.rawSnapshotIds,
      mappingVersions: cached.mappingVersions,
      validationRulesVersion: this.validationRulesVersion,
      temporalContext: cached.factSet.temporalContext
        ?? buildTemporalContext(
          request,
          cached.factSet.facts,
          cached.observations,
        ),
      reasonCodes: [
        ...cached.factSet.reasonCodes,
        ...additionalReasonCodes,
      ],
    });
    this.persistFactSet({
      factSet,
      lineageFacts: cached.lineageFacts,
      observations: cached.observations,
      mappingVersions: cached.mappingVersions,
    });
    return factSet;
  }

  async getFacts(input: FactRequest): Promise<VerifiedFactSet> {
    let request: FactRequest;
    try {
      const parsed = FactRequestSchema.parse(input);
      request = {
        ...parsed,
        knowledgeAsOf: parsed.knowledgeAsOf ?? parsed.asOf,
      };
    } catch (error) {
      throw new GatewayError("INVALID_INPUT", "Invalid FactRequest", {
        cause: error,
      });
    }
    const resolution = await this.resolveInstrument(request.instrument);
    const startedAt = this.now();
    const freshness = normalizeFreshness(request);
    const cacheKey = requestCacheKey(
      resolution,
      request,
      this.schemaVersion,
      this.validationRulesVersion,
    );
    const cached = this.readCachedFactSet(cacheKey);
    const cachedAge = cached === undefined
      ? undefined
      : cacheAgeSeconds(cached, startedAt);

    if (freshness.offline && cached !== undefined) {
      return this.replayCachedFactSet(cached, request, [
        "OFFLINE_SNAPSHOT",
        ...(cachedAge! > freshness.maxAgeSeconds ? ["STALE_CACHE"] : []),
      ]);
    }
    if (
      !freshness.offline
      && cached !== undefined
      && cachedAge! <= freshness.maxAgeSeconds
    ) {
      return this.replayCachedFactSet(cached, request, []);
    }

    const fetchRequirements = expandDerivationRequirements(
      request.requirements,
    );
    const eligibleProviders = this.providers.filter((provider) =>
      supportsInstrument(provider, resolution.instrument)
    );
    const providerPlans = eligibleProviders.flatMap((provider) => {
      const requirements = requirementsForProvider(
        provider,
        resolution.instrument,
        fetchRequirements,
      );
      return requirements.length === 0 ? [] : [{ provider, requirements }];
    });
    const unsupportedReasons = request.requirements
      .filter((requirement) =>
        !eligibleProviders.some((provider) =>
          supportsRequirement(provider, resolution.instrument, requirement)
        )
      )
      .map((requirement) =>
        `NO_CAPABLE_PROVIDER:${requirement.conceptId}`
      );
    const outcomes = freshness.offline
      ? []
      : await Promise.all(providerPlans.map(({ provider, requirements }) => {
          const providerRequest = ProviderRequestSchema.parse({
            instrument: resolution.instrument,
            requirements,
            asOf: request.asOf,
            knowledgeAsOf: requestKnowledgeAsOf(request),
            offline: false,
          });
          return this.fetchProvider(provider, providerRequest, startedAt);
        }));
    const assembled = this.assembleFactSet(
      request,
      fetchRequirements,
      resolution,
      startedAt,
      outcomes,
      [
        ...unsupportedReasons,
        ...(freshness.offline ? ["OFFLINE_SNAPSHOT"] : []),
      ],
    );
    this.persistFactSet(
      assembled,
      assembled.factSet.summary.overallStatus === "failed"
        ? undefined
        : cacheKey,
    );

    const hasProviderFailure = outcomes.some(
      (outcome) => outcome.issues.some((issue) =>
        issue.reasonCode !== "REPORT_NOT_AVAILABLE_AS_OF"
      ),
    );
    if (
      assembled.factSet.summary.overallStatus === "failed"
      && hasProviderFailure
      && freshness.allowStaleOnProviderFailure
      && cached !== undefined
    ) {
      return this.replayCachedFactSet(cached, request, [
        "STALE_CACHE",
        ...assembled.factSet.reasonCodes.filter(
          (reasonCode) => reasonCode !== "EMPTY_FACT_SET",
        ),
      ]);
    }
    return assembled.factSet;
  }

  async getFactSet(factSetId: string): Promise<VerifiedFactSet> {
    let factSet: VerifiedFactSet | undefined;
    try {
      factSet = this.metadata.getFactSet(factSetId);
    } catch (error) {
      throw new GatewayError(
        "STORAGE_ERROR",
        `Failed to read FactSet: ${factSetId}`,
        { cause: error },
      );
    }
    if (factSet === undefined) {
      throw new GatewayError("NOT_FOUND", `FactSet not found: ${factSetId}`);
    }
    return factSet;
  }

  async explainFact(factId: string): Promise<FactExplanation> {
    let explanation: FactExplanation | undefined;
    try {
      explanation = this.metadata.explainFact(factId);
    } catch (error) {
      throw new GatewayError(
        "STORAGE_ERROR",
        `Failed to explain Fact: ${factId}`,
        { cause: error },
      );
    }
    if (explanation === undefined) {
      throw new GatewayError("NOT_FOUND", `Fact not found: ${factId}`);
    }
    return explanation;
  }

  doctor(): {
    schemaVersion: typeof VERIFIED_FACT_SET_SCHEMA_VERSION;
    validationRulesVersion: string;
    providers: {
      providerId: string;
      upstreamSourceId: string;
      capabilities: readonly string[];
    }[];
    storage: ReturnType<MetadataStore["doctor"]>;
  } {
    return {
      schemaVersion: this.schemaVersion,
      validationRulesVersion: this.validationRulesVersion,
      providers: this.providers.map((provider) => ({
        providerId: provider.providerId,
        upstreamSourceId: provider.upstreamSourceId,
        capabilities: provider.capabilities,
      })),
      storage: this.metadata.doctor(),
    };
  }
}
