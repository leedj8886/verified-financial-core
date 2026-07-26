import { z } from "zod";

export const TransformationStepSchema = z.object({
  transformId: z.string().min(1),
  version: z.string().min(1),
  detail: z.string().min(1),
});
export type TransformationStep = z.infer<typeof TransformationStepSchema>;

export const ProvenanceSchema = z.object({
  providerId: z.string().min(1),
  upstreamSourceId: z.string().min(1),
  sourceType: z.enum(["official", "first-party", "aggregator"]),
  documentId: z.string().min(1).optional(),
  sourceUrl: z.string().url(),
  rawSnapshotId: z.string().min(1),
  rawField: z.string().min(1),
  extractionMethod: z.enum(["api", "html", "pdf", "derived"]),
  fetchedAt: z.string().datetime({ offset: true }),
  transformations: z.array(TransformationStepSchema),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;
