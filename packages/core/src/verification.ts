import { createHash } from "node:crypto";
import {
  CanonicalFactSchema,
  type CanonicalFact,
  type Observation,
  type VerificationResult,
} from "@verified-financial/schema";
import { Decimal } from "decimal.js";
import { compareCompatibility } from "./compatibility.js";
import { independentUpstreamSourceIds } from "./independence.js";

function discrepancyPercent(
  left: Observation,
  right: Observation,
): Decimal {
  const leftValue = new Decimal(left.value).mul(left.scale);
  const rightValue = new Decimal(right.value).mul(right.scale);
  const denominator = Decimal.min(leftValue.abs(), rightValue.abs());
  if (denominator.isZero()) {
    return leftValue.eq(rightValue) ? new Decimal(0) : new Decimal(Infinity);
  }
  return leftValue.minus(rightValue).abs().div(denominator).mul(100);
}

function sourceRank(observation: Observation): number {
  if (observation.provenance.sourceType === "official") return 0;
  if (observation.provenance.sourceType === "first-party") return 1;
  return 2;
}

function revisionTimestamp(observation: Observation): number {
  const value = observation.availability.sourceAsOf
    ?? observation.availability.publishedAt
    ?? observation.availability.fetchedAt;
  return Date.parse(value);
}

function latestRevisionsByUpstream(
  observations: readonly Observation[],
): Observation[] {
  const latest = new Map<string, Observation>();
  for (const observation of observations) {
    const upstream = observation.provenance.upstreamSourceId;
    const existing = latest.get(upstream);
    if (
      existing === undefined
      || revisionTimestamp(observation) > revisionTimestamp(existing)
      || (
        revisionTimestamp(observation) === revisionTimestamp(existing)
        && observation.observationId.localeCompare(existing.observationId) < 0
      )
    ) {
      latest.set(upstream, observation);
    }
  }
  return [...latest.values()];
}

function maximumDiscrepancyPercent(
  observations: readonly Observation[],
): Decimal {
  let maximum = new Decimal(0);
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      maximum = Decimal.max(
        maximum,
        discrepancyPercent(observations[left]!, observations[right]!),
      );
    }
  }
  return maximum;
}

export function verifyObservations(
  observations: readonly Observation[],
): VerificationResult {
  if (observations.length === 0) {
    throw new Error("verifyObservations requires at least one observation");
  }
  const activeRevisions = latestRevisionsByUpstream(observations);
  const ordered = [...activeRevisions].sort(
    (left, right) => sourceRank(left) - sourceRank(right)
      || left.provenance.upstreamSourceId.localeCompare(
        right.provenance.upstreamSourceId,
      )
      || left.observationId.localeCompare(right.observationId),
  );
  const primary = ordered[0]!;
  const incompatibleReasons = ordered.slice(1).flatMap(
    (observation) => compareCompatibility(primary, observation).reasonCodes,
  );
  const upstreams = independentUpstreamSourceIds(ordered);
  const official = ordered.find(
    (observation) => observation.provenance.sourceType === "official",
  );
  const maximum = maximumDiscrepancyPercent(ordered);

  let status: VerificationResult["status"] = "verified";
  let usable = true;
  let reasonCodes: string[] = [];
  const chosenObservationId = official?.observationId ?? primary.observationId;

  if (incompatibleReasons.length > 0) {
    status = "failed";
    usable = false;
    reasonCodes = [...new Set(incompatibleReasons)];
  } else if (upstreams.length < 2) {
    status = "warning";
    reasonCodes = ["SINGLE_INDEPENDENT_SOURCE"];
  } else if (maximum.gt(5) && official === undefined) {
    status = "failed";
    usable = false;
    reasonCodes = ["UNRESOLVED_SOURCE_CONFLICT"];
  } else if (maximum.gt(5)) {
    status = "failed";
    usable = false;
    reasonCodes = ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"];
  } else if (maximum.gt(1)) {
    status = "warning";
    reasonCodes = ["SOURCE_DISCREPANCY"];
  }

  const observationIds = observations
    .map((item) => item.observationId)
    .sort();
  const payload = JSON.stringify({
    observationIds,
    status,
    chosenObservationId,
  });
  const verificationId = `vr:${createHash("sha256")
    .update(payload)
    .digest("hex")}`;
  return {
    verificationId,
    status,
    usable,
    observationIds,
    independentUpstreamSourceIds: upstreams,
    ...(maximum.isFinite()
      ? { discrepancyPercent: maximum.toString() }
      : {}),
    chosenObservationId,
    reasonCodes,
  };
}

export function verifyAndMaterializeFact(
  observations: readonly Observation[],
): CanonicalFact {
  const verification = verifyObservations(observations);
  const chosen = observations.find(
    (observation) =>
      observation.observationId === verification.chosenObservationId,
  );
  if (chosen === undefined) throw new Error("CHOSEN_OBSERVATION_NOT_FOUND");
  const value = new Decimal(chosen.value).mul(chosen.scale).toString();
  const payload = JSON.stringify({
    verificationId: verification.verificationId,
    chosenObservationId: chosen.observationId,
    value,
  });
  const factId = `fact:${createHash("sha256").update(payload).digest("hex")}`;
  return CanonicalFactSchema.parse({
    factId,
    companyId: chosen.companyId,
    ...(chosen.instrumentId === undefined
      ? {}
      : { instrumentId: chosen.instrumentId }),
    concept: chosen.concept,
    value,
    unit: chosen.unit,
    period: chosen.period,
    basis: chosen.basis,
    status: verification.status,
    usable: verification.usable,
    reasonCodes: verification.reasonCodes,
    observationIds: verification.observationIds,
    verification,
  });
}
