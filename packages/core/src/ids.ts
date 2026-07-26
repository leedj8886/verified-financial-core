import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new Error("UNSUPPORTED_CANONICAL_JSON");
  }
  return serialized;
}

export function stableId(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
  return `${prefix}:${digest}`;
}
