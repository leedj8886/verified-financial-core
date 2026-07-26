import { describe, expect, it } from "vitest";
import {
  AvailabilitySchema,
  ReportingPeriodSchema,
  isAvailableAsOf,
} from "./period.js";

describe("reporting period and availability", () => {
  it("keeps report end date separate from publication time", () => {
    const period = ReportingPeriodSchema.parse({
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    });
    const availability = AvailabilitySchema.parse({
      filingDate: "2026-03-20",
      publishedAt: "2026-03-20T18:00:00+08:00",
      fetchedAt: "2026-07-26T10:00:00+08:00",
    });
    expect(period.endDate).toBe("2025-12-31");
    expect(isAvailableAsOf(
      availability,
      "2026-03-19T23:59:59+08:00",
    )).toBe(false);
    expect(isAvailableAsOf(
      availability,
      "2026-03-21T00:00:00+08:00",
    )).toBe(true);
  });

  it("requires startDate only for duration periods", () => {
    expect(() => ReportingPeriodSchema.parse({
      kind: "duration",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    })).toThrow();
    expect(ReportingPeriodSchema.parse({
      kind: "instant",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    }).kind).toBe("instant");
  });

  it("requires fiscalQuarter for quarter and YTD presentations", () => {
    expect(() => ReportingPeriodSchema.parse({
      kind: "duration",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      fiscalYear: 2026,
      presentation: "ytd",
    })).toThrow();
  });

  it("rejects fiscalQuarter on annual periods", () => {
    expect(() => ReportingPeriodSchema.parse({
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      fiscalQuarter: 4,
      presentation: "annual",
    })).toThrow("Annual periods cannot have fiscalQuarter");
  });
});
