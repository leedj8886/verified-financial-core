import {
  CompanySchema,
  ConceptIdSchema,
  DecimalStringSchema,
  FactRequirementSchema,
  InstrumentSchema,
  ObservationSchema,
  UnmappedObservationSchema,
  type Company,
  type FactRequirement,
  type Instrument,
  type Observation,
  type UnmappedObservation,
} from "@verified-financial/schema";
import { z } from "zod";

export const ProviderCapabilitySchema = z.enum([
  "identity",
  "market",
  "financials",
  "dividends",
  "valuation",
  "filings",
]);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const SourceFieldMappingSchema = z.object({
  upstreamSchema: z.string().min(1),
  rawField: z.string().min(1),
  conceptId: ConceptIdSchema,
  unit: z.string().min(1),
  scale: DecimalStringSchema,
  transformIds: z.array(z.string().min(1)),
});
export type SourceFieldMapping = z.infer<typeof SourceFieldMappingSchema>;

export const ProviderErrorCodeSchema = z.enum([
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "UPSTREAM_SCHEMA_CHANGED",
  "EMPTY_RESPONSE",
  "PARSE_FAILED",
  "UPSTREAM_UNAVAILABLE",
  "UNSUPPORTED_INSTRUMENT",
  "OFFICIAL_DOCUMENT_UNREADABLE",
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

export const ProviderIssueSchema = z.object({
  providerId: z.string().min(1),
  code: ProviderErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  reasonCode: z.string().min(1).optional(),
  requirements: z.array(FactRequirementSchema).optional(),
});
export type ProviderIssue = z.infer<typeof ProviderIssueSchema>;

export const SnapshotMediaTypeSchema = z.enum(["json", "text", "html", "pdf"]);
export type SnapshotMediaType = z.infer<typeof SnapshotMediaTypeSchema>;

const RawSnapshotMetadataSchema = z.object({
  providerId: z.string().min(1),
  sourceUrl: z.string().url(),
  mediaType: SnapshotMediaTypeSchema,
  fetchedAt: z.string().datetime({ offset: true }),
});

export const RawSnapshotInputSchema = RawSnapshotMetadataSchema.extend({
  body: z.union([z.string(), z.instanceof(Uint8Array)]),
});
export type RawSnapshotInput = z.infer<typeof RawSnapshotInputSchema>;

export const StoredSnapshotRefSchema = RawSnapshotMetadataSchema.extend({
  snapshotId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
});
export type StoredSnapshotRef = z.infer<typeof StoredSnapshotRefSchema>;

export interface SnapshotWriter {
  put(input: RawSnapshotInput): Promise<StoredSnapshotRef>;
}

export const ProviderRequestSchema = z.object({
  instrument: InstrumentSchema,
  requirements: z.array(FactRequirementSchema).min(1),
  asOf: z.string().datetime({ offset: true }),
  knowledgeAsOf: z.string().datetime({ offset: true }).optional(),
  offline: z.boolean(),
}).superRefine((request, context) => {
  if (
    request.knowledgeAsOf !== undefined
    && Date.parse(request.knowledgeAsOf) < Date.parse(request.asOf)
  ) {
    context.addIssue({
      code: "custom",
      path: ["knowledgeAsOf"],
      message: "knowledgeAsOf cannot be earlier than asOf",
    });
  }
});
export interface ProviderRequest {
  instrument: Instrument;
  requirements: FactRequirement[];
  asOf: string;
  knowledgeAsOf?: string | undefined;
  offline: boolean;
}

export function providerKnowledgeAsOf(
  request: Pick<ProviderRequest, "asOf" | "knowledgeAsOf">,
): string {
  return request.knowledgeAsOf ?? request.asOf;
}

export const ProviderBatchSchema = z.object({
  providerId: z.string().min(1),
  upstreamSourceId: z.string().min(1),
  company: CompanySchema,
  instruments: z.array(InstrumentSchema).min(1),
  observations: z.array(ObservationSchema),
  unmapped: z.array(UnmappedObservationSchema),
  rawSnapshots: z.array(StoredSnapshotRefSchema),
  mappingVersions: z.array(z.string().min(1)).min(1),
  issues: z.array(ProviderIssueSchema),
}).superRefine((batch, context) => {
  const snapshotIds = new Set(
    batch.rawSnapshots.map((snapshot) => snapshot.snapshotId),
  );
  for (const instrument of batch.instruments) {
    if (instrument.companyId !== batch.company.companyId) {
      context.addIssue({
        code: "custom",
        message: "Provider instrument belongs to a different company",
      });
    }
  }
  for (const observation of batch.observations) {
    if (observation.companyId !== batch.company.companyId) {
      context.addIssue({
        code: "custom",
        message: "Provider observation belongs to a different company",
      });
    }
    if (observation.provenance.providerId !== batch.providerId) {
      context.addIssue({
        code: "custom",
        message: "Observation providerId does not match its batch",
      });
    }
    if (
      observation.provenance.upstreamSourceId !== batch.upstreamSourceId
    ) {
      context.addIssue({
        code: "custom",
        message: "Observation upstreamSourceId does not match its batch",
      });
    }
    if (!snapshotIds.has(observation.provenance.rawSnapshotId)) {
      context.addIssue({
        code: "custom",
        message: "Observation references a snapshot outside its batch",
      });
    }
  }
  for (const issue of batch.issues) {
    if (issue.providerId !== batch.providerId) {
      context.addIssue({
        code: "custom",
        message: "Provider issue does not match its batch",
      });
    }
  }
});

export interface ProviderBatch {
  providerId: string;
  upstreamSourceId: string;
  company: Company;
  instruments: Instrument[];
  observations: Observation[];
  unmapped: UnmappedObservation[];
  rawSnapshots: StoredSnapshotRef[];
  mappingVersions: string[];
  issues: ProviderIssue[];
}

export interface ProviderContext {
  signal: AbortSignal;
  now: string;
  snapshots: SnapshotWriter;
}

export interface SourceProvider {
  readonly providerId: string;
  readonly upstreamSourceId: string;
  readonly capabilities: readonly ProviderCapability[];
  supportsInstrument?(instrument: Instrument): boolean;
  fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch>;
}

export class ProviderFailure extends Error {
  readonly issue: ProviderIssue;

  constructor(issue: ProviderIssue) {
    super(issue.message);
    this.name = "ProviderFailure";
    this.issue = ProviderIssueSchema.parse(issue);
  }
}

export function parseProviderBatch(
  provider: SourceProvider,
  value: unknown,
): ProviderBatch {
  const batch = ProviderBatchSchema.parse(value);
  if (
    batch.providerId !== provider.providerId
    || batch.upstreamSourceId !== provider.upstreamSourceId
  ) {
    throw new Error("PROVIDER_IDENTITY_MISMATCH");
  }
  return batch;
}
