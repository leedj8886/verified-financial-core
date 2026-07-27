import {
  CompanySchema,
  InstrumentSchema,
  canonicalInstrumentId,
  type Company,
  type ExchangeMic,
  type Instrument,
} from "@verified-financial/schema";

export interface InstrumentResolution {
  input: string;
  normalizedInput: string;
  company: Company;
  instrument: Instrument;
  confidence: "syntactic" | "authoritative";
}

export interface InstrumentResolver {
  resolve(input: string): Promise<InstrumentResolution>;
}

function explicitExchange(
  exchange: string,
): ExchangeMic | undefined {
  switch (exchange) {
    case "SH":
    case "SS":
    case "XSHG":
      return "XSHG";
    case "SZ":
    case "XSHE":
      return "XSHE";
    case "BJ":
    case "XBSE":
      return "XBSE";
    case "HK":
    case "XHKG":
      return "XHKG";
    default:
      return undefined;
  }
}

function inferMainlandExchange(symbol: string): ExchangeMic | undefined {
  if (/^6\d{5}$/.test(symbol)) return "XSHG";
  if (/^[03]\d{5}$/.test(symbol)) return "XSHE";
  if (/^(?:[48]\d{5}|92\d{4})$/.test(symbol)) return "XBSE";
  return undefined;
}

function parseInstrumentInput(
  input: string,
): { exchangeMic: ExchangeMic; symbol: string } {
  const normalized = input.trim().toUpperCase();
  const canonical = /^(XSHG|XSHE|XBSE|XHKG):(\d{1,6})$/.exec(normalized);
  if (canonical !== null) {
    return {
      exchangeMic: canonical[1] as ExchangeMic,
      symbol: canonical[2]!,
    };
  }
  const suffixed = /^(\d{1,6})\.(SH|SS|SZ|BJ|HK)$/.exec(normalized);
  if (suffixed !== null) {
    return {
      exchangeMic: explicitExchange(suffixed[2]!)!,
      symbol: suffixed[1]!,
    };
  }
  const prefixed = /^(SH|SZ|BJ|HK)(\d{1,6})$/.exec(normalized);
  if (prefixed !== null) {
    return {
      exchangeMic: explicitExchange(prefixed[1]!)!,
      symbol: prefixed[2]!,
    };
  }
  if (/^\d{1,5}$/.test(normalized)) {
    return { exchangeMic: "XHKG", symbol: normalized };
  }
  if (/^\d{6}$/.test(normalized)) {
    const exchangeMic = inferMainlandExchange(normalized);
    if (exchangeMic !== undefined) {
      return { exchangeMic, symbol: normalized };
    }
  }
  throw new Error(`UNSUPPORTED_INSTRUMENT:${input}`);
}

function validateSymbol(exchangeMic: ExchangeMic, symbol: string): void {
  if (exchangeMic === "XHKG") {
    if (!/^\d{1,5}$/.test(symbol)) {
      throw new Error(`UNSUPPORTED_INSTRUMENT:${symbol}`);
    }
    return;
  }
  if (!/^\d{6}$/.test(symbol)) {
    throw new Error(`UNSUPPORTED_INSTRUMENT:${symbol}`);
  }
  const inferred = inferMainlandExchange(symbol);
  if (inferred !== exchangeMic) {
    throw new Error(`INSTRUMENT_EXCHANGE_MISMATCH:${symbol}`);
  }
}

export class SyntacticInstrumentResolver implements InstrumentResolver {
  async resolve(input: string): Promise<InstrumentResolution> {
    const parsed = parseInstrumentInput(input);
    validateSymbol(parsed.exchangeMic, parsed.symbol);
    const instrumentId = canonicalInstrumentId(
      parsed.exchangeMic,
      parsed.symbol,
    );
    const companyId = `company:${instrumentId}`;
    const isHongKong = parsed.exchangeMic === "XHKG";
    const company = CompanySchema.parse({
      companyId,
      legalName: `Unresolved ${instrumentId}`,
      jurisdiction: isHongKong ? "HK" : "CN",
    });
    const instrument = InstrumentSchema.parse({
      instrumentId,
      companyId,
      exchangeMic: parsed.exchangeMic,
      symbol: instrumentId.split(":")[1],
      shareClass: isHongKong ? "H" : "A",
      tradingCurrency: isHongKong ? "HKD" : "CNY",
    });
    return {
      input,
      normalizedInput: instrumentId,
      company,
      instrument,
      confidence: "syntactic",
    };
  }
}
