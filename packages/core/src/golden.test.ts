import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ObservationSchema,
  isAvailableAsOf,
  type Observation,
} from "@verified-financial/schema";
import { describe, expect, it } from "vitest";
import { verifyObservations } from "./verification.js";

function loadFixture(name: string): Observation[] {
  const path = fileURLToPath(
    new URL(`../../../tests/golden/foundation/${name}.json`, import.meta.url),
  );
  return ObservationSchema.array().parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
}

describe("foundation Golden Corpus", () => {
  it("verifies compatible revenue", () => {
    expect(verifyObservations(loadFixture("verified-revenue")).status)
      .toBe("verified");
  });

  it("warns for a single source", () => {
    expect(verifyObservations(loadFixture("single-source-warning")).status)
      .toBe("warning");
  });

  it("preserves an official conflict", () => {
    expect(verifyObservations(loadFixture("official-conflict")))
      .toMatchObject({
        status: "warning",
        reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
      });
  });

  it("excludes future publications before verification", () => {
    const asOf = "2026-03-19T23:59:59+08:00";
    const eligible = loadFixture("future-publication").filter(
      (item) => isAvailableAsOf(item.availability, asOf),
    );
    expect(eligible).toHaveLength(0);
  });
});
