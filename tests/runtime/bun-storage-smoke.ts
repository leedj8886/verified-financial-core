import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../packages/local-gateway/dist/index.js";

const directory = mkdtempSync(join(tmpdir(), "verified-bun-storage-"));
const local = createLocalGateway(directory, []);

try {
  const factSet = await local.gateway.getFacts({
    instrument: "600519.SH",
    requirements: [{
      conceptId: "income.revenue",
      required: true,
      period: {
        fiscalYear: 2025,
        presentation: "annual",
      },
    }],
    asOf: "2026-04-18T23:59:59+08:00",
    freshness: {
      maxAgeSeconds: 86_400,
      allowStaleOnProviderFailure: true,
      offline: true,
    },
  });

  if (factSet.summary.overallStatus !== "failed") {
    throw new Error("Expected fail-closed empty offline FactSet");
  }
  if (!factSet.reasonCodes.includes("OFFLINE_SNAPSHOT")) {
    throw new Error("Expected Bun SQLite cache lookup to complete");
  }
  if (local.gateway.doctor().storage.factSetCount !== 1) {
    throw new Error("Expected Bun SQLite to persist the FactSet");
  }
} finally {
  local.close();
  rmSync(directory, { recursive: true, force: true });
}
