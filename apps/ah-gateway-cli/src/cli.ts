import { parseArgs } from "node:util";
import {
  ConceptIdSchema,
  FactStatusSchema,
  type FactPeriodSelector,
  type FactRequest,
  type FactStatus,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import {
  defaultMaxAgeSeconds,
  GatewayError,
  type FinancialGateway,
} from "@verified-financial/sdk";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliGateway {
  resolveInstrument: FinancialGateway["resolveInstrument"];
  getFacts: FinancialGateway["getFacts"];
  getFactSet: FinancialGateway["getFactSet"];
  explainFact: FinancialGateway["explainFact"];
  doctor: FinancialGateway["doctor"];
}

const statusRank: Record<FactStatus, number> = {
  failed: 0,
  warning: 1,
  verified: 2,
};

function writeJson(writer: (value: string) => void, value: unknown): void {
  writer(`${JSON.stringify(value)}\n`);
}

function normalizeAsOf(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59+08:00`
    : value;
}

export function parsePeriod(value: string): FactPeriodSelector {
  const annual = /^(\d{4})FY$/i.exec(value);
  if (annual !== null) {
    return {
      fiscalYear: Number(annual[1]),
      presentation: "annual",
    };
  }
  const ttm = /^(\d{4})TTM$/i.exec(value);
  if (ttm !== null) {
    return {
      fiscalYear: Number(ttm[1]),
      presentation: "ttm",
    };
  }
  const quarter = /^(\d{4})Q([1-4])$/i.exec(value);
  if (quarter !== null) {
    return {
      fiscalYear: Number(quarter[1]),
      fiscalQuarter: Number(quarter[2]) as 1 | 2 | 3 | 4,
      presentation: "quarter",
    };
  }
  const ytd = /^(\d{4})Q([1-4])YTD$/i.exec(value);
  if (ytd !== null) {
    return {
      fiscalYear: Number(ytd[1]),
      fiscalQuarter: Number(ytd[2]) as 1 | 2 | 3 | 4,
      presentation: "ytd",
    };
  }
  throw new Error(`INVALID_PERIOD:${value}`);
}

function meetsRequiredStatus(
  factSet: VerifiedFactSet,
  required: FactStatus,
): boolean {
  return statusRank[factSet.summary.overallStatus] >= statusRank[required];
}

async function runResolve(
  argv: string[],
  gateway: CliGateway,
  io: CliIo,
): Promise<number> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) throw new Error("resolve requires one instrument");
  writeJson(io.stdout, await gateway.resolveInstrument(positionals[0]!));
  return 0;
}

async function runFacts(
  argv: string[],
  gateway: CliGateway,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      concept: { type: "string", multiple: true },
      period: { type: "string" },
      "as-of": { type: "string" },
      "max-age-seconds": { type: "string" },
      offline: { type: "boolean", default: false },
      "require-status": { type: "string" },
      format: { type: "string", default: "json" },
    },
  });
  if (positionals.length !== 1) throw new Error("facts requires one instrument");
  if (values.concept === undefined || values.concept.length === 0) {
    throw new Error("facts requires at least one --concept");
  }
  if (values["as-of"] === undefined) throw new Error("facts requires --as-of");
  if (values.format !== "json") throw new Error("Only --format json is supported");
  const period = values.period === undefined
    ? undefined
    : parsePeriod(values.period);
  const requirements = values.concept.map((concept) => ({
    conceptId: ConceptIdSchema.parse(concept),
    required: true,
    ...(period === undefined ? {} : { period }),
  }));
  const maxAgeSeconds = values["max-age-seconds"] === undefined
    ? defaultMaxAgeSeconds(requirements)
    : Number(values["max-age-seconds"]);
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new Error("--max-age-seconds must be a non-negative integer");
  }
  const request: FactRequest = {
    instrument: positionals[0]!,
    requirements,
    asOf: normalizeAsOf(values["as-of"]),
    freshness: {
      maxAgeSeconds,
      allowStaleOnProviderFailure: true,
      offline: values.offline,
    },
  };
  const requiredStatus = values["require-status"] === undefined
    ? "warning"
    : FactStatusSchema.parse(values["require-status"]);
  const factSet = await gateway.getFacts(request);
  writeJson(io.stdout, factSet);
  return meetsRequiredStatus(factSet, requiredStatus) ? 0 : 2;
}

async function runLookup(
  command: "fact-set" | "explain",
  argv: string[],
  gateway: CliGateway,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: "string", default: "json" },
    },
  });
  if (values.format !== "json") throw new Error("Only --format json is supported");
  if (positionals.length !== 1) {
    throw new Error(`${command} requires one identifier`);
  }
  const result = command === "fact-set"
    ? await gateway.getFactSet(positionals[0]!)
    : await gateway.explainFact(positionals[0]!);
  writeJson(io.stdout, result);
  return 0;
}

export async function runCli(
  argv: string[],
  gateway: CliGateway,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "resolve":
        return await runResolve(rest, gateway, io);
      case "facts":
        return await runFacts(rest, gateway, io);
      case "fact-set":
      case "explain":
        return await runLookup(command, rest, gateway, io);
      case "doctor":
        if (rest.length > 0) throw new Error("doctor accepts no arguments");
        writeJson(io.stdout, gateway.doctor());
        return 0;
      default:
        throw new Error(
          "Usage: ah-context <resolve|facts|fact-set|explain|doctor>",
        );
    }
  } catch (error) {
    const isStorageError = error instanceof GatewayError
      && error.code === "STORAGE_ERROR";
    writeJson(io.stderr, {
      error: {
        code: error instanceof GatewayError
          ? error.code
          : "INVALID_INPUT",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
    return isStorageError ? 4 : 3;
  }
}
