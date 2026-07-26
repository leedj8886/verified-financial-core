import { describe, expect, it } from "vitest";
import { DecimalStringSchema } from "./value.js";

describe("DecimalStringSchema", () => {
  it.each(["0", "-12", "123.4500", "1e8", "-2.5E-3"])(
    "accepts %s",
    (value) => {
      expect(DecimalStringSchema.parse(value)).toBe(value);
    },
  );

  it.each([1, Number.NaN, "", "1,000", "¥12", "Infinity"])(
    "rejects %p",
    (value) => {
      expect(() => DecimalStringSchema.parse(value)).toThrow();
    },
  );
});
