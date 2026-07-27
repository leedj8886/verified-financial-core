import { createHash } from "node:crypto";
import {
  parseProviderBatch,
  type FetchImplementation,
  type SnapshotWriter,
} from "@verified-financial/provider-contract";
import { describe, expect, it } from "vitest";
import { TencentProvider } from "./provider.js";

const snapshots: SnapshotWriter = {
  async put(input) {
    const body = typeof input.body === "string"
      ? new TextEncoder().encode(input.body)
      : input.body;
    return {
      snapshotId: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      providerId: input.providerId,
      sourceUrl: input.sourceUrl,
      mediaType: input.mediaType,
      fetchedAt: input.fetchedAt,
      byteLength: body.byteLength,
    };
  },
};

function quoteFixture(): string {
  const fields = Array<string>(60).fill("");
  fields[1] = "MOUTAI";
  fields[2] = "600519";
  fields[3] = "1288.82";
  fields[30] = "20260727104141";
  fields[39] = "19.48";
  fields[45] = "16111.30";
  fields[46] = "6.92";
  return `v_sh600519="${fields.join("~")}";`;
}

describe("TencentProvider", () => {
  it("keeps quote ratios exact and expresses market cap with a source scale", async () => {
    const fetchImplementation: FetchImplementation = async () =>
      new Response(quoteFixture());
    const provider = new TencentProvider({
      fetchImplementation,
      retries: 0,
    });
    const batch = parseProviderBatch(provider, await provider.fetch({
      instrument: {
        instrumentId: "XSHG:600519",
        companyId: "company:XSHG:600519",
        exchangeMic: "XSHG",
        symbol: "600519",
        shareClass: "A",
        tradingCurrency: "CNY",
      },
      requirements: [
        { conceptId: "market.price.close", required: true },
        { conceptId: "market.cap", required: true },
        { conceptId: "valuation.peTtm", required: true },
        { conceptId: "valuation.pb", required: true },
      ],
      asOf: "2026-07-27T23:59:59+08:00",
      offline: false,
    }, {
      signal: new AbortController().signal,
      now: "2026-07-27T10:45:00+08:00",
      snapshots,
    }));

    expect(batch.company.legalName).toBe("MOUTAI");
    expect(batch.rawSnapshots[0]?.byteLength).toBeGreaterThan(0);
    expect(batch.observations.find((item) => item.concept === "market.cap"))
      .toMatchObject({ value: "16111.30", scale: "100000000" });
    expect(batch.observations.find((item) => item.concept === "valuation.peTtm"))
      .toMatchObject({ value: "19.48", scale: "1" });
    expect(batch.observations.find((item) => item.concept === "valuation.pb"))
      .toMatchObject({ value: "6.92", scale: "1" });
  });
});
