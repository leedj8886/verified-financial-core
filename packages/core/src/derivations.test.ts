import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deriveFreeCashFlow,
  deriveMarketCap,
  derivePe,
  deriveRoe,
  deriveTtmFlow,
} from "./derivations.js";
import { makeFact } from "./test-fixtures.js";

describe("deterministic financial derivations", () => {
  it("calculates TTM from compatible YTD facts", () => {
    const result = deriveTtmFlow({
      currentYtd: makeFact({
        factId: "current", value: "80", fiscalYear: 2026,
        fiscalQuarter: 1, presentation: "ytd",
      }),
      previousAnnual: makeFact({
        factId: "annual", value: "300", fiscalYear: 2025,
        presentation: "annual",
      }),
      previousYtd: makeFact({
        factId: "previous", value: "70", fiscalYear: 2025,
        fiscalQuarter: 1, presentation: "ytd",
      }),
    });
    expect(result.value).toBe("310");
    expect(result.derivation?.formulaId).toBe("ttm.flow.v1");
  });

  it("defines FCF as OCF minus capex", () => {
    expect(deriveFreeCashFlow(
      makeFact({
        concept: "cashFlow.operatingCashFlow", value: "120",
      }),
      makeFact({ concept: "cashFlow.capex", value: "35" }),
    ).value).toBe("85");
  });

  it("rejects incompatible derivation inputs", () => {
    expect(() => deriveTtmFlow({
      currentYtd: makeFact({
        currency: "CNY", fiscalYear: 2026,
        fiscalQuarter: 1, presentation: "ytd",
      }),
      previousAnnual: makeFact({
        currency: "HKD", fiscalYear: 2025, presentation: "annual",
      }),
      previousYtd: makeFact({
        currency: "CNY", fiscalYear: 2025,
        fiscalQuarter: 1, presentation: "ytd",
      }),
    })).toThrow("INCOMPATIBLE_DERIVATION_INPUTS");
    expect(() => deriveFreeCashFlow(
      makeFact({ concept: "cashFlow.operatingCashFlow" }),
      makeFact({
        concept: "cashFlow.capex",
        period: { endDate: "2024-12-31", fiscalYear: 2024 },
      }),
    )).toThrow("INCOMPATIBLE_DERIVATION_INPUTS");
  });

  it("propagates warning status into derived facts", () => {
    expect(deriveFreeCashFlow(
      makeFact({
        concept: "cashFlow.operatingCashFlow",
        status: "warning",
      }),
      makeFact({ concept: "cashFlow.capex" }),
    )).toMatchObject({
      status: "warning",
      reasonCodes: ["DERIVED_FROM_WARNING_INPUT"],
    });
  });

  it("uses average opening and closing equity for ROE", () => {
    expect(deriveRoe({
      netProfit: makeFact({
        concept: "income.netProfitParent", value: "20",
      }),
      openingEquity: makeFact({
        concept: "balance.equity", value: "90",
        period: { endDate: "2024-12-31", fiscalYear: 2024 },
      }),
      closingEquity: makeFact({
        concept: "balance.equity", value: "110",
      }),
    }).value).toBe("0.2");
  });

  it("calculates market cap and PE without binary floats", () => {
    expect(deriveMarketCap(
      makeFact({
        concept: "market.price.close", value: "10.5", unit: "CNY",
      }),
      makeFact({
        concept: "market.shares.outstanding",
        value: "1000000000",
        unit: "shares",
      }),
    ).value).toBe("10500000000");
    expect(derivePe(
      makeFact({
        concept: "market.price.close", value: "10.5", unit: "CNY",
      }),
      makeFact({
        concept: "income.epsBasic", value: "0.5",
        unit: "CNY-per-share", presentation: "ttm",
      }),
    )).toMatchObject({
      concept: "valuation.peTtm",
      value: "21",
      period: { presentation: "ttm" },
    });
  });

  it("rejects historical market cap built with current shares", () => {
    expect(() => deriveMarketCap(
      makeFact({
        concept: "market.price.close",
        value: "10.5",
        unit: "CNY",
        fiscalYear: 2024,
        period: { endDate: "2024-08-30" },
      }),
      makeFact({
        concept: "market.shares.outstanding",
        value: "1000000000",
        unit: "shares",
        fiscalYear: 2026,
        period: { endDate: "2026-07-29" },
      }),
    )).toThrow("INCOMPATIBLE_DERIVATION_INPUTS");
  });

  it("rejects zero ROE and PE denominators", () => {
    expect(() => deriveRoe({
      netProfit: makeFact({ concept: "income.netProfitParent" }),
      openingEquity: makeFact({
        concept: "balance.equity", value: "0",
        period: { endDate: "2024-12-31", fiscalYear: 2024 },
      }),
      closingEquity: makeFact({ concept: "balance.equity", value: "0" }),
    })).toThrow("INCOMPATIBLE_DERIVATION_INPUTS");
    expect(() => derivePe(
      makeFact({ concept: "market.price.close" }),
      makeFact({
        concept: "income.epsBasic",
        value: "0",
        presentation: "ttm",
      }),
    )).toThrow("INCOMPATIBLE_DERIVATION_INPUTS");
  });

  it("TTM obeys current YTD + annual - previous YTD", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      (current, annual, previous) => {
        const result = deriveTtmFlow({
          currentYtd: makeFact({
            value: String(current), fiscalYear: 2026,
            fiscalQuarter: 1, presentation: "ytd",
          }),
          previousAnnual: makeFact({
            value: String(annual), fiscalYear: 2025,
            presentation: "annual",
          }),
          previousYtd: makeFact({
            value: String(previous), fiscalYear: 2025,
            fiscalQuarter: 1, presentation: "ytd",
          }),
        });
        expect(result.value).toBe(
          new Decimal(current).plus(annual).minus(previous).toString(),
        );
      },
    ));
  });
});
