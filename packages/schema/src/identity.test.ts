import { describe, expect, it } from "vitest";
import {
  CompanySchema,
  InstrumentSchema,
  canonicalInstrumentId,
} from "./identity.js";

describe("financial identity", () => {
  it("creates MIC-qualified instrument IDs", () => {
    expect(canonicalInstrumentId("XSHG", "600519")).toBe("XSHG:600519");
    expect(canonicalInstrumentId("XHKG", "700")).toBe("XHKG:00700");
  });

  it("keeps company and instrument identities separate", () => {
    const company = CompanySchema.parse({
      companyId: "company:cn-shenhua",
      legalName: "中国神华能源股份有限公司",
      jurisdiction: "CN",
    });
    const instrument = InstrumentSchema.parse({
      instrumentId: "XHKG:01088",
      companyId: company.companyId,
      exchangeMic: "XHKG",
      symbol: "01088",
      shareClass: "H",
      tradingCurrency: "HKD",
    });
    expect(instrument.companyId).toBe(company.companyId);
  });

  it("rejects an H-share on an A-share exchange", () => {
    expect(() => InstrumentSchema.parse({
      instrumentId: "XSHG:01088",
      companyId: "company:cn-shenhua",
      exchangeMic: "XSHG",
      symbol: "01088",
      shareClass: "H",
      tradingCurrency: "HKD",
    })).toThrow();
  });
});
