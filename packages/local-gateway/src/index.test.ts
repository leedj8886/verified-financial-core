import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultProviders,
  createLocalGateway,
} from "./index.js";

describe("local Gateway runtime", () => {
  it("registers seven token-free public and official sources by default", () => {
    const providers = createDefaultProviders();
    expect(providers.map((provider) => provider.providerId))
      .toEqual([
        "eastmoney-direct",
        "ths-financial-direct",
        "cninfo-direct",
        "hkex-direct",
        "baidu-hk-financial-direct",
        "tencent-direct",
        "baidu-direct",
      ]);
    for (
      const providerId of [
        "eastmoney-direct",
        "cninfo-direct",
        "hkex-direct",
      ]
    ) {
      expect(
        providers.find((provider) =>
          provider.providerId === providerId
        )?.capabilities,
      ).toContain("dividends");
    }
  });

  it("creates a closeable local SDK runtime without network access", () => {
    const directory = mkdtempSync(join(tmpdir(), "verified-local-gateway-"));
    const local = createLocalGateway(directory, []);
    try {
      expect(local.gateway.doctor()).toMatchObject({
        schemaVersion: "1.1.0",
        providers: [],
        storage: {
          databasePath: join(directory, "metadata.sqlite"),
          snapshotCount: 0,
          factSetCount: 0,
          providerRequestCount: 0,
          cacheEntryCount: 0,
        },
      });
    } finally {
      local.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forwards an explicit Provider timeout budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "verified-local-gateway-"));
    const local = createLocalGateway(directory, [], {
      providerTimeoutMs: 123_456,
    });
    try {
      expect(local.gateway).toHaveProperty("providerTimeoutMs", 123_456);
    } finally {
      local.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
