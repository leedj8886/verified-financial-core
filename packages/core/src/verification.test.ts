import { describe, expect, it } from "vitest";
import {
  verifyAndMaterializeFact,
  verifyObservations,
} from "./verification.js";
import { makeObservation } from "./test-fixtures.js";

describe("cross-source verification", () => {
  it("rejects an empty observation group", () => {
    expect(() => verifyObservations([]))
      .toThrow("verifyObservations requires at least one observation");
  });
  it("verifies independent sources within 1 percent", () => {
    const result = verifyObservations([
      makeObservation({ observationId: "eastmoney", value: "100" }),
      makeObservation({
        observationId: "cninfo",
        value: "100.5",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ]);
    expect(result.status).toBe("verified");
    expect(result.discrepancyPercent).toBe("0.5");
  });

  it("compares exact effective values across source scales", () => {
    expect(verifyObservations([
      makeObservation({ value: "100000000", scale: "1" }),
      makeObservation({
        value: "1",
        scale: "100000000",
        upstreamSourceId: "tencent",
      }),
    ])).toMatchObject({
      status: "verified",
      discrepancyPercent: "0",
    });
  });

  it("warns for one real upstream despite two providers", () => {
    const result = verifyObservations([
      makeObservation({
        providerId: "eastmoney-direct",
        upstreamSourceId: "eastmoney",
      }),
      makeObservation({
        providerId: "legacy-akshare",
        upstreamSourceId: "eastmoney",
      }),
    ]);
    expect(result.reasonCodes).toContain("SINGLE_INDEPENDENT_SOURCE");
  });

  it("fails above 5 percent without official adjudication", () => {
    const result = verifyObservations([
      makeObservation({ value: "100" }),
      makeObservation({ value: "110", upstreamSourceId: "tushare" }),
    ]);
    expect(result).toMatchObject({ status: "failed", usable: false });
  });

  it("warns for a discrepancy between 1 and 5 percent", () => {
    expect(verifyObservations([
      makeObservation({ value: "100" }),
      makeObservation({ value: "103", upstreamSourceId: "tushare" }),
    ])).toMatchObject({
      status: "warning",
      usable: true,
      reasonCodes: ["SOURCE_DISCREPANCY"],
    });
  });

  it("fails incompatible observation groups", () => {
    expect(verifyObservations([
      makeObservation(),
      makeObservation({
        upstreamSourceId: "cninfo",
        basis: { standard: "IFRS" },
      }),
    ])).toMatchObject({
      status: "failed",
      usable: false,
      reasonCodes: ["ACCOUNTING_STANDARD_MISMATCH"],
    });
  });

  it("fails closed on a material official-source conflict", () => {
    const fact = verifyAndMaterializeFact([
      makeObservation({
        observationId: "eastmoney",
        value: "100",
        scale: "1000",
      }),
      makeObservation({
        observationId: "cninfo",
        value: "110",
        scale: "1000",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ]);
    expect(fact).toMatchObject({
      value: "110000",
      status: "failed",
      usable: false,
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
    });
  });

  it("uses a two-source structured consensus when a PDF extraction is the outlier", () => {
    const fact = verifyAndMaterializeFact([
      makeObservation({
        observationId: "cninfo-pdf",
        value: "-4.636",
        upstreamSourceId: "cninfo",
        sourceType: "official",
        extractionMethod: "pdf",
      }),
      makeObservation({
        observationId: "eastmoney",
        value: "72.9389",
        upstreamSourceId: "eastmoney",
      }),
      makeObservation({
        observationId: "ths",
        value: "72.9389",
        upstreamSourceId: "ths",
      }),
    ]);

    expect(fact).toMatchObject({
      value: "72.9389",
      status: "warning",
      usable: true,
      reasonCodes: ["OFFICIAL_EXTRACTION_OUTLIER"],
      verification: {
        chosenObservationId: "eastmoney",
        independentUpstreamSourceIds: ["cninfo", "eastmoney", "ths"],
      },
    });
  });

  it("does not override an official API conflict with aggregator consensus", () => {
    expect(verifyObservations([
      makeObservation({
        observationId: "official-api",
        value: "90",
        upstreamSourceId: "official-api",
        sourceType: "official",
      }),
      makeObservation({
        observationId: "eastmoney",
        value: "100",
        upstreamSourceId: "eastmoney",
      }),
      makeObservation({
        observationId: "ths",
        value: "100",
        upstreamSourceId: "ths",
      }),
    ])).toMatchObject({
      status: "failed",
      usable: false,
      chosenObservationId: "official-api",
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
    });
  });

  it("does not override a PDF extraction with only one structured source", () => {
    expect(verifyObservations([
      makeObservation({
        observationId: "cninfo-pdf",
        value: "90",
        upstreamSourceId: "cninfo",
        sourceType: "official",
        extractionMethod: "pdf",
      }),
      makeObservation({
        observationId: "eastmoney",
        value: "100",
        upstreamSourceId: "eastmoney",
      }),
    ])).toMatchObject({
      status: "failed",
      usable: false,
      chosenObservationId: "cninfo-pdf",
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
    });
  });

  it("uses the latest revision published by each upstream source", () => {
    const fact = verifyAndMaterializeFact([
      makeObservation({
        observationId: "cninfo-original",
        value: "50",
        upstreamSourceId: "cninfo",
        sourceType: "official",
        availability: {
          publishedAt: "2025-04-30T23:59:59+08:00",
        },
      }),
      makeObservation({
        observationId: "cninfo-comparative-restatement",
        value: "100",
        upstreamSourceId: "cninfo",
        sourceType: "official",
        availability: {
          publishedAt: "2026-04-30T23:59:59+08:00",
          sourceAsOf: "2026-04-30T23:59:59+08:00",
        },
      }),
      makeObservation({
        observationId: "eastmoney-restatement",
        value: "100",
        upstreamSourceId: "eastmoney",
        availability: {
          publishedAt: "2026-04-30T23:59:59+08:00",
        },
      }),
    ]);
    expect(fact).toMatchObject({
      value: "100",
      status: "verified",
      usable: true,
      observationIds: [
        "cninfo-comparative-restatement",
        "cninfo-original",
        "eastmoney-restatement",
      ],
    });
  });

  it("is independent of provider return order", () => {
    const observations = [
      makeObservation({ observationId: "eastmoney", value: "100" }),
      makeObservation({
        observationId: "cninfo",
        value: "100.5",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ];
    expect(verifyObservations(observations))
      .toEqual(verifyObservations([...observations].reverse()));
  });
});
