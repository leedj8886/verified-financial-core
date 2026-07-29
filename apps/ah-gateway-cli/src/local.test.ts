import { describe, expect, it } from "vitest";
import { createDefaultProviders } from "./local.js";

describe("local Gateway providers", () => {
  it("registers five token-free public and official sources by default", () => {
    const providers = createDefaultProviders();
    expect(providers.map((provider) => provider.providerId))
      .toEqual([
        "eastmoney-direct",
        "cninfo-direct",
        "hkex-direct",
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
});
