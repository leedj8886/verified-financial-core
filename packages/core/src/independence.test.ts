import { describe, expect, it } from "vitest";
import { independentUpstreamSourceIds } from "./independence.js";
import { makeObservation } from "./test-fixtures.js";

describe("upstream independence", () => {
  it("counts wrappers over Eastmoney once", () => {
    const observations = [
      makeObservation({
        providerId: "eastmoney-direct",
        upstreamSourceId: "eastmoney",
      }),
      makeObservation({
        providerId: "legacy-akshare",
        upstreamSourceId: "eastmoney",
      }),
      makeObservation({
        providerId: "cninfo-direct",
        upstreamSourceId: "cninfo",
      }),
    ];
    expect(independentUpstreamSourceIds(observations))
      .toEqual(["cninfo", "eastmoney"]);
  });
});
