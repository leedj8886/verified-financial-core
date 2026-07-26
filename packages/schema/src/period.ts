import { z } from "zod";

const IsoDateSchema = z.string().date();
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const PresentationSchema = z.enum([
  "quarter",
  "ytd",
  "annual",
  "ttm",
]);
export type Presentation = z.infer<typeof PresentationSchema>;

export const ReportingPeriodSchema = z.object({
  kind: z.enum(["instant", "duration"]),
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema,
  fiscalYear: z.number().int(),
  fiscalQuarter: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]).optional(),
  presentation: PresentationSchema,
}).superRefine((period, context) => {
  if (period.kind === "duration" && period.startDate === undefined) {
    context.addIssue({
      code: "custom",
      message: "Duration periods require startDate",
    });
  }
  if (period.kind === "instant" && period.startDate !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Instant periods cannot have startDate",
    });
  }
  if (
    (period.presentation === "quarter" || period.presentation === "ytd")
    && period.fiscalQuarter === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Quarter and YTD periods require fiscalQuarter",
    });
  }
  if (
    period.presentation === "annual"
    && period.fiscalQuarter !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Annual periods cannot have fiscalQuarter",
    });
  }
});
export type ReportingPeriod = z.infer<typeof ReportingPeriodSchema>;

export const AvailabilitySchema = z.object({
  filingDate: IsoDateSchema.optional(),
  publishedAt: IsoDateTimeSchema.optional(),
  sourceAsOf: IsoDateTimeSchema.optional(),
  fetchedAt: IsoDateTimeSchema,
});
export type Availability = z.infer<typeof AvailabilitySchema>;

export function isAvailableAsOf(
  availability: Availability,
  asOf: string,
): boolean {
  return availability.publishedAt !== undefined
    && Date.parse(availability.publishedAt) <= Date.parse(asOf);
}
