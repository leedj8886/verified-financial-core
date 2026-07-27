import {
  buildFactSet,
  canonicalJson,
  verifyAndMaterializeFact,
} from "@verified-financial/core";
import {
  ProviderFailure,
  ProviderRequestSchema,
  parseProviderBatch,
  type ProviderBatch,
  type ProviderIssue,
  type SourceProvider,
} from "@verified-financial/provider-contract";
import {
  FactRequestSchema,
  isAvailableAsOf,
  type Company,
  type FactRequest,
  type Instrument,
  type Observation,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import {
  type ContentAddressedSnapshotStore,
  type FactExplanation,
  type MetadataStore,
} from "@verified-financial/storage";
import {
  SyntacticInstrumentResolver,
  type InstrumentResolution,
  type InstrumentResolver,
} from "./identity.js";

const DEFAULT_SCHEMA_VERSION = "1.0.0";
const DEFAULT_VALIDATION_RULES_VERSION = "1.0.0";

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

function providerReason(issue: ProviderIssue): string {
  return `PROVIDER_FAILURE:${issue.providerId}:${issue.code}`;
}

function unavailableReason(observation: Observation): string {
  return `NOT_AVAILABLE_AS_OF:${observation.provenance.providerId}`;
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
    .map((batch) => batch.company)
    .filter((company) =>
      batches.every((batch) => batch.company.companyId === company.companyId)
    )
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return matching[0] ?? resolution.company;
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
      if (batch.observations.length === 0 && batch.unmapped.length === 0) {
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
    const providerRequest = ProviderRequestSchema.parse({
      instrument: resolution.instrument,
      requirements: request.requirements,
      asOf: request.asOf,
      offline: request.freshness?.offline ?? false,
    });
    const outcomes = await Promise.all(
      this.providers.map((provider) =>
        this.fetchProvider(provider, providerRequest, startedAt)
      ),
    );
    const batches = outcomes.flatMap((outcome) =>
      outcome.batch === undefined ? [] : [outcome.batch]
    );
    const issues = outcomes.flatMap((outcome) => outcome.issues);
    const requestedObservations = batches
      .flatMap((batch) => batch.observations)
      .filter((observation) => matchesRequest(observation, request));
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
    const facts = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, observations]) => verifyAndMaterializeFact(observations));
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
      ...(providerRequest.offline ? ["OFFLINE_SNAPSHOT"] : []),
    ];
    const mappingVersions = batches.flatMap(
      (batch) => batch.mappingVersions,
    );
    const factSet = buildFactSet({
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
          && fact.verification.verificationId === validation.verificationId
        )
      ),
      rawSnapshotIds: sameCompanyBatches.flatMap((batch) =>
        batch.rawSnapshots.map((snapshot) => snapshot.snapshotId)
      ),
      mappingVersions,
      validationRulesVersion: this.validationRulesVersion,
      reasonCodes,
    });
    try {
      this.metadata.putFactSet(
        factSet,
        eligibleObservations.filter(
          (observation) => observation.companyId === company.companyId,
        ),
        mappingVersions,
      );
    } catch (error) {
      throw new GatewayError(
        "STORAGE_ERROR",
        "Failed to persist FactSet",
        { cause: error },
      );
    }
    return factSet;
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
