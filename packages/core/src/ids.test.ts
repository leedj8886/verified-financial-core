import { describe, expect, it } from "vitest";
import { canonicalJson, stableId } from "./ids.js";

describe("deterministic IDs", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("produces the same ID for semantically identical objects", () => {
    expect(stableId("fs", { b: 2, a: 1 }))
      .toBe(stableId("fs", { a: 1, b: 2 }));
  });

  it("rejects values that JSON cannot represent", () => {
    expect(() => canonicalJson(undefined)).toThrow(
      "UNSUPPORTED_CANONICAL_JSON",
    );
  });
});
