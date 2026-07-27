import { describe, expect, it } from "vitest";
import { SyntacticInstrumentResolver } from "./identity.js";

describe("A/H instrument syntax resolution", () => {
  const resolver = new SyntacticInstrumentResolver();

  it.each([
    ["600519.SH", "XSHG:600519"],
    ["SZ000001", "XSHE:000001"],
    ["430047.BJ", "XBSE:430047"],
    ["0700.HK", "XHKG:00700"],
    ["XHKG:00700", "XHKG:00700"],
    ["600519", "XSHG:600519"],
  ])("resolves %s as %s", async (input, expected) => {
    expect((await resolver.resolve(input)).instrument.instrumentId)
      .toBe(expected);
  });

  it("rejects exchange and symbol mismatches", async () => {
    await expect(resolver.resolve("600519.SZ"))
      .rejects.toThrow("INSTRUMENT_EXCHANGE_MISMATCH");
    await expect(resolver.resolve("ABC"))
      .rejects.toThrow("UNSUPPORTED_INSTRUMENT");
  });
});
