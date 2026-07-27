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

it("accepts equivalent units expressed with different source scales", () => {
  const yuan = makeObservation({ value: "100000000", scale: "1" });
  const yiYuan = makeObservation({
    value: "1",
    scale: "100000000",
    upstreamSourceId: "tencent",
  });
  expect(compareCompatibility(yuan, yiYuan)).toEqual({
    compatible: true,
    reasonCodes: [],
  });
});

it("reports every incompatible accounting and period dimension", () => {
  const left = makeObservation();
  const right = makeObservation({
    companyId: "company:other",
    concept: "income.netProfit",
    period: { endDate: "2024-12-31", fiscalYear: 2024 },
    basis: {
      standard: "IFRS",
      scope: "standalone",
      attribution: "all-shareholders",
    },
  });
  expect(compareCompatibility(left, right).reasonCodes).toEqual([
    "CONCEPT_MISMATCH",
    "COMPANY_MISMATCH",
    "PERIOD_MISMATCH",
    "ACCOUNTING_STANDARD_MISMATCH",
    "ACCOUNTING_SCOPE_MISMATCH",
    "ATTRIBUTION_MISMATCH",
  ]);
});
