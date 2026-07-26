import type { Observation } from "@verified-financial/schema";

export function independentUpstreamSourceIds(
  observations: readonly Observation[],
): string[] {
  return [...new Set(observations.map(
    (observation) => observation.provenance.upstreamSourceId,
  ))].sort();
}
