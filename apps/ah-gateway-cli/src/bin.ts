#!/usr/bin/env node

import { resolve } from "node:path";
import { runCli } from "./cli.js";
import { createLocalGateway } from "./local.js";

const dataDirectory = resolve(
  process.env["VERIFIED_FINANCIAL_DATA_DIR"] ?? "data",
);

let local: ReturnType<typeof createLocalGateway> | undefined;
try {
  local = createLocalGateway(dataDirectory);
  process.exitCode = await runCli(
    process.argv.slice(2),
    local.gateway,
    {
      stdout(value) {
        process.stdout.write(value);
      },
      stderr(value) {
        process.stderr.write(value);
      },
    },
  );
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: "STORAGE_ERROR",
      message: error instanceof Error ? error.message : "Storage failure",
    },
  })}\n`);
  process.exitCode = 4;
} finally {
  local?.close();
}
