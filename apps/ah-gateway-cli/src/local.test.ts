import { describe, expect, it } from "vitest";
import { createDefaultProviders } from "./local.js";

describe("local Gateway providers", () => {
  it("registers five token-free public and official sources by default", () => {
    expect(createDefaultProviders().map((provider) => provider.providerId))
      .toEqual([
        "eastmoney-direct",
        "cninfo-direct",
        "hkex-direct",
        "tencent-direct",
        "baidu-direct",
      ]);
  });
});
