import { expect, it } from "vitest";
import { compareCompatibility } from "./compatibility.js";
import { makeObservation } from "./test-fixtures.js";

it("rejects A/H instrument mixing", () => {
  const aPrice = makeObservation({
    concept: "market.price.close",
    instrumentId: "XSHG:601088",
    unit: "CNY",
  });
  const hPrice = makeObservation({
    concept: "market.price.close",
    instrumentId: "XHKG:01088",
    unit: "HKD",
    basis: { currency: "HKD" },
  });
  expect(compareCompatibility(aPrice, hPrice)).toEqual({
    compatible: false,
    reasonCodes: [
      "INSTRUMENT_MISMATCH",
      "UNIT_MISMATCH",
      "CURRENCY_MISMATCH",
    ],
  });
});

it("rejects reported and adjusted profit", () => {
  const reported = makeObservation({
    concept: "income.netProfitParent",
    basis: { presentation: "reported" },
  });
  const adjusted = makeObservation({
    concept: "income.netProfitParent",
    basis: { presentation: "adjusted" },
  });
  expect(compareCompatibility(reported, adjusted).reasonCodes)
    .toContain("ACCOUNTING_PRESENTATION_MISMATCH");
});

it("accepts compatible observations from different upstreams", () => {
  const left = makeObservation({ upstreamSourceId: "eastmoney" });
  const right = makeObservation({ upstreamSourceId: "cninfo" });
  expect(compareCompatibility(left, right)).toEqual({
    compatible: true,
    reasonCodes: [],
  });
});
