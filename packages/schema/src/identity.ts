import { z } from "zod";

export const ExchangeMicSchema = z.enum(["XSHG", "XSHE", "XBSE", "XHKG"]);
export type ExchangeMic = z.infer<typeof ExchangeMicSchema>;

export const CompanySchema = z.object({
  companyId: z.string().min(1),
  legalName: z.string().min(1),
  jurisdiction: z.string().length(2),
});
export type Company = z.infer<typeof CompanySchema>;

export const InstrumentSchema = z.object({
  instrumentId: z.string().min(1),
  companyId: z.string().min(1),
  exchangeMic: ExchangeMicSchema,
  symbol: z.string().min(1),
  shareClass: z.enum(["A", "H"]),
  tradingCurrency: z.enum(["CNY", "HKD"]),
}).superRefine((instrument, context) => {
  const expectedId = canonicalInstrumentId(
    instrument.exchangeMic,
    instrument.symbol,
  );
  if (instrument.instrumentId !== expectedId) {
    context.addIssue({
      code: "custom",
      message: `Expected instrumentId ${expectedId}`,
    });
  }
  const isHShare = instrument.exchangeMic === "XHKG";
  if (isHShare !== (instrument.shareClass === "H")) {
    context.addIssue({
      code: "custom",
      message: "Share class does not match exchange",
    });
  }
  const expectedCurrency = isHShare ? "HKD" : "CNY";
  if (instrument.tradingCurrency !== expectedCurrency) {
    context.addIssue({
      code: "custom",
      message: `Expected trading currency ${expectedCurrency}`,
    });
  }
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export function canonicalInstrumentId(
  exchangeMic: ExchangeMic,
  symbol: string,
): string {
  const normalized = exchangeMic === "XHKG"
    ? symbol.replace(/^0+/, "").padStart(5, "0")
    : symbol.padStart(6, "0");
  return `${exchangeMic}:${normalized}`;
}
