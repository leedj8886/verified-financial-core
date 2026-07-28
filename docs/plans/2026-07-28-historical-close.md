# Historical Daily Close

## Goal

Make a historical `asOf` request return the last daily close that was actually
available at that time. The result must use the existing market-price concept,
immutable snapshots, provenance, availability filtering, and FactSet status.

## Delivered

- [x] Route `market.price.close` to Tencent and Eastmoney daily K-line history
      when the request's Hong Kong/China calendar date is earlier than the
      Gateway run date.
- [x] Use Tencent's unadjusted `day` series as the live primary path, and
      request Eastmoney with `klt=101` and `fqt=0` as a compatible secondary
      path.
- [x] Map Tencent day-row field `[2]` and Eastmoney field `f53` to the
      canonical close-price concept.
- [x] Select the latest trading row whose conservative market-close timestamp
      does not exceed the exact `asOf`.
- [x] Treat mainland closes as available at 15:30 +08:00 and Hong Kong closes
      as available at 16:30 +08:00.
- [x] Preserve the complete upstream JSON and record the adjustment and
      availability policy in the transformation chain.
- [x] Cover weekends, same-day pre-close filtering, exact close-time
      availability, and offline behavior without requiring a token.

## Boundaries

This phase provides daily closes, not historical intraday ticks. Same-calendar-
day requests continue to use the current quote path. Tencent and Eastmoney use
independent endpoints and compatible unadjusted-close semantics; a temporarily
unavailable secondary source can reduce confidence without preventing the
primary historical close from being returned.

The history window is bounded to 370 calendar days before `asOf`. A security
with no trading row in that window fails closed instead of returning an
arbitrarily old price.
