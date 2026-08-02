import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../packages/local-gateway/src/index.js";
import { CninfoProvider } from "../../packages/provider-cninfo/src/index.js";
import { EastmoneyProvider } from "../../packages/provider-eastmoney/src/index.js";
import { TencentProvider } from "../../packages/provider-tencent/src/index.js";
import { describe, expect, it } from "vitest";

describe("gateway temporal live regressions", () => {
  it("keeps Songfa's 2024-08-30 market cap when knowledge includes later disclosures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vfc-songfa-dual-time-"));
    const local = createLocalGateway(
      directory,
      [
        new EastmoneyProvider(),
        new CninfoProvider(),
        new TencentProvider(),
      ],
      { providerTimeoutMs: 25_000 },
    );

    try {
      const factSet = await local.gateway.getFacts({
        instrument: "603268.SH",
        requirements: [{ conceptId: "market.cap", required: true }],
        asOf: "2024-08-30T23:59:59+08:00",
        knowledgeAsOf: "2026-08-02T23:59:59+08:00",
        freshness: {
          maxAgeSeconds: 0,
          allowStaleOnProviderFailure: false,
        },
      });

      expect(factSet.temporalContext).toMatchObject({
        effectiveAsOf: "2024-08-30T23:59:59+08:00",
        knowledgeAsOf: "2026-08-02T23:59:59+08:00",
        mode: "post-disclosure",
      });
      expect(factSet.facts).toEqual([
        expect.objectContaining({
          concept: "market.cap",
          value: "1555835064",
          period: expect.objectContaining({
            kind: "instant",
            endDate: "2024-08-30",
          }),
          derivation: expect.objectContaining({
            formulaId: "market-cap.price-times-shares.v1",
            expression: "price * shares",
          }),
        }),
      ]);

      const marketCap = factSet.facts[0]!;
      const explanation = await local.gateway.explainFact(marketCap.factId);
      expect(explanation.inputs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fact: expect.objectContaining({
            concept: "market.price.close",
            value: "12.53",
            period: expect.objectContaining({ endDate: "2024-08-30" }),
          }),
        }),
        expect.objectContaining({
          fact: expect.objectContaining({
            concept: "market.shares.outstanding",
            value: "124168800",
            period: expect.objectContaining({ endDate: "2024-08-30" }),
          }),
        }),
      ]));
    } finally {
      local.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
