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

  it("uses official value but preserves a material conflict", () => {
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
      status: "warning",
      usable: true,
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
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
