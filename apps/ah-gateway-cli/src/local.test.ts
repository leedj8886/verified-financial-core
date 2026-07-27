import { describe, expect, it } from "vitest";
import { createDefaultProviders } from "./local.js";

describe("local Gateway providers", () => {
  it("registers three token-free public sources by default", () => {
    expect(createDefaultProviders().map((provider) => provider.providerId))
      .toEqual([
        "eastmoney-direct",
        "tencent-direct",
        "baidu-direct",
      ]);
  });
});
