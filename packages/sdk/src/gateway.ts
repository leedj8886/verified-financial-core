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
  isAvailableAsOf,
  type Company,
  type FactRequirement,
  type FactRequest,
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
import {
  SyntacticInstrumentResolver,
  type InstrumentResolution,
  type InstrumentResolver,
} from "./identity.js";
import {
  expandDerivationRequirements,
  materializeRequestedFacts,
} from "./derivation-orchestrator.js";

const DEFAULT_SCHEMA_VERSION = "1.0.0";
const DEFAULT_VALIDATION_RULES_VERSION = "1.5.0";

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
  schemaVersion?: string;
  validationRulesVersion?: string;
}

interface ProviderOutcome {
  batch?: ProviderBatch;
  issues: ProviderIssue[];
}

interface NormalizedFreshness {
  maxAgeSeconds: number;
  allowStaleOnProviderFailure: boolean;
  offline: boolean;
}

interface AssembledFactSet {
  factSet: VerifiedFactSet;
  observations: Observation[];
  mappingVersions: string[];
}

function providerReason(issue: ProviderIssue): string {
  return `PROVIDER_FAILURE:${issue.providerId}:${issue.code}`;
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
  requirements: readonly FactRequirement[],
): FactRequirement[] {
  const capabilities = new Set(provider.capabilities);
  return requirements.filter((requirement) =>
    capabilities.has(capabilityForRequirement(requirement))
  );
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
  schemaVersion: string,
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
  });
}

function matchesRequest(
  observation: Observation,
  request: FactRequest,
): boolean {
  return request.requirements.some((requirement) => {
    if (requirement.conceptId !== observation.concept) return false;
    if (requirement.period === undefined) return true;
    return observation.period.fiscalYear === requirement.period.fiscalYear
      && observation.period.fiscalQuarter
        === requirement.period.fiscalQuarter
      && observation.period.presentation === requirement.period.presentation;
  });
}

function compatibilityGroupKey(observation: Observation): string {
  return canonicalJson({
    companyId: observation.companyId,
    instrumentId: observation.instrumentId,
    concept: observation.concept,
    unit: observation.unit,
    period: observation.period,
    basis: observation.basis,
  });
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
  private readonly schemaVersion: string;
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
    this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
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
      return { batch, issues };
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
      return { issues: [issue] };
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
    const eligibleObservations = allObservations.filter((observation) =>
      isAvailableAsOf(observation.availability, request.asOf)
    );
    const unavailableReasons = allObservations
      .filter((observation) =>
        !isAvailableAsOf(observation.availability, request.asOf)
      )
      .map(unavailableReason);
    const groups = new Map<string, Observation[]>();
    for (const observation of eligibleObservations) {
      const key = compatibilityGroupKey(observation);
      const group = groups.get(key) ?? [];
      group.push(observation);
      groups.set(key, group);
    }
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
      ...unavailableReasons,
      ...instrumentScopeReasons,
      ...companyConflictReasons,
      ...materialized.reasonCodes,
      ...extraReasonCodes,
    ];
    const mappingVersions = batches.flatMap(
      (batch) => batch.mappingVersions,
    );
    const observations = eligibleObservations.filter(
      (observation) => observation.companyId === company.companyId,
    );
    return {
      factSet: buildFactSet({
        schemaVersion: this.schemaVersion,
        request,
        generatedAt: startedAt,
        company,
        instruments: mergeInstruments(resolution, sameCompanyBatches, company),
        facts: facts.filter((fact) => fact.companyId === company.companyId),
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
        reasonCodes,
      }),
      observations,
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
      reasonCodes: [
        ...cached.factSet.reasonCodes,
        ...additionalReasonCodes,
      ],
    });
    this.persistFactSet({
      factSet,
      observations: cached.observations,
      mappingVersions: cached.mappingVersions,
    });
    return factSet;
  }

  async getFacts(input: FactRequest): Promise<VerifiedFactSet> {
    let request: FactRequest;
    try {
      request = FactRequestSchema.parse(input);
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
    const providerPlans = this.providers.flatMap((provider) => {
      const requirements = requirementsForProvider(
        provider,
        fetchRequirements,
      );
      return requirements.length === 0 ? [] : [{ provider, requirements }];
    });
    const unsupportedReasons = request.requirements
      .filter((requirement) =>
        !this.providers.some((provider) =>
          provider.capabilities.includes(
            capabilityForRequirement(requirement),
          )
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
      (outcome) => outcome.issues.length > 0,
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
    schemaVersion: string;
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
