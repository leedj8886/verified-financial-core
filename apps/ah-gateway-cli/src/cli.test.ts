import {
  VERIFIED_FACT_SET_SCHEMA_VERSION,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import type { InstrumentResolution } from "@verified-financial/sdk";
import { describe, expect, it, vi } from "vitest";
import { parsePeriod, runCli, type CliGateway } from "./cli.js";

const failedFactSet = {
  factSetId: "fs:empty",
  summary: { overallStatus: "failed" },
} as VerifiedFactSet;

function makeGateway(
  factSet: VerifiedFactSet = failedFactSet,
): CliGateway {
  return {
    resolveInstrument: vi.fn(async (
      input: string,
    ): Promise<InstrumentResolution> => ({
      input,
      normalizedInput: "XSHG:600519",
      company: {
        companyId: "company:XSHG:600519",
        legalName: "Unresolved XSHG:600519",
        jurisdiction: "CN",
      },
      instrument: {
        instrumentId: "XSHG:600519",
        companyId: "company:XSHG:600519",
        exchangeMic: "XSHG",
        symbol: "600519",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      confidence: "syntactic",
    })),
    getFacts: vi.fn(async () => factSet),
    getFactSet: vi.fn(async () => factSet),
    explainFact: vi.fn(async () => ({
      factSetId: "fs:fixture",
      fact: {} as never,
      verification: {} as never,
      observations: [],
      rawSnapshotIds: [],
      inputs: [],
    })),
    doctor: vi.fn(() => ({
      schemaVersion: VERIFIED_FACT_SET_SCHEMA_VERSION,
      validationRulesVersion: "1.0.0",
      providers: [],
      storage: {
        databasePath: "/tmp/fixture.sqlite",
        factSetCount: 0,
        snapshotCount: 0,
        cacheEntryCount: 0,
        providerRequestCount: 0,
      },
    })),
  };
}

function captureIo(): {
  stdout: string[];
  stderr: string[];
  io: {
    stdout(value: string): void;
    stderr(value: string): void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(value) {
        stdout.push(value);
      },
      stderr(value) {
        stderr.push(value);
      },
    },
  };
}

describe("ah-context JSON CLI", () => {
  it("parses supported financial period syntax", () => {
    expect(parsePeriod("2025FY")).toEqual({
      fiscalYear: 2025,
      presentation: "annual",
    });
    expect(parsePeriod("2025Q3YTD")).toEqual({
      fiscalYear: 2025,
      fiscalQuarter: 3,
      presentation: "ytd",
    });
    expect(parsePeriod("2026Q2TTM")).toEqual({
      fiscalYear: 2026,
      fiscalQuarter: 2,
      presentation: "ttm",
    });
  });

  it("writes resolution JSON only to stdout", async () => {
    const output = captureIo();
    expect(await runCli(
      ["resolve", "600519.SH"],
      makeGateway(),
      output.io,
    )).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      normalizedInput: "XSHG:600519",
    });
    expect(output.stderr).toEqual([]);
  });

  it("returns exit code 2 when facts fail the default warning threshold", async () => {
    const output = captureIo();
    const gateway = makeGateway();
    expect(await runCli([
      "facts",
      "600519.SH",
      "--concept",
      "income.revenue",
      "--period",
      "2025FY",
      "--as-of",
      "2026-07-27",
      "--format",
      "json",
    ], gateway, output.io)).toBe(2);
    expect(JSON.parse(output.stdout[0]!).factSetId).toBe("fs:empty");
    expect(output.stderr).toEqual([]);
    expect(gateway.getFacts).toHaveBeenCalledWith(expect.objectContaining({
      asOf: "2026-07-27T23:59:59+08:00",
      freshness: expect.objectContaining({ maxAgeSeconds: 86_400 }),
    }));
  });

  it("passes an explicit knowledge cutoff for post-disclosure analysis", async () => {
    const output = captureIo();
    const gateway = makeGateway();
    await runCli([
      "facts",
      "600519.SH",
      "--concept",
      "income.revenue",
      "--period",
      "2024Q2TTM",
      "--as-of",
      "2024-08-30",
      "--knowledge-as-of",
      "2024-09-30",
    ], gateway, output.io);

    expect(gateway.getFacts).toHaveBeenCalledWith(expect.objectContaining({
      asOf: "2024-08-30T23:59:59+08:00",
      knowledgeAsOf: "2024-09-30T23:59:59+08:00",
    }));
  });

  it("keeps invalid input diagnostics on stderr", async () => {
    const output = captureIo();
    expect(await runCli(["facts", "600519.SH"], makeGateway(), output.io))
      .toBe(3);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0]!).error.code).toBe("INVALID_INPUT");
  });

  it("rejects an invalid cache age before invoking the Gateway", async () => {
    const output = captureIo();
    const gateway = makeGateway();
    expect(await runCli([
      "facts",
      "600519.SH",
      "--concept",
      "market.cap",
      "--as-of",
      "2026-07-27",
      "--max-age-seconds",
      "-1",
    ], gateway, output.io)).toBe(3);
    expect(gateway.getFacts).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr[0]!).error.message)
      .toContain("--max-age-seconds");
  });

  it("reports local provider and storage health", async () => {
    const output = captureIo();
    expect(await runCli(["doctor"], makeGateway(), output.io)).toBe(0);
    expect(JSON.parse(output.stdout[0]!).providers).toEqual([]);
  });
});
