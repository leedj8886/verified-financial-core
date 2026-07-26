import { z } from "zod";

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const DecimalStringSchema = z
  .string()
  .min(1)
  .regex(DECIMAL_PATTERN, "Expected an exact decimal string");

export type DecimalString = z.infer<typeof DecimalStringSchema>;
