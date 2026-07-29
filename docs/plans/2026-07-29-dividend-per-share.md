# Annual Dividend Per Share

## Goal

Return traceable annual cash dividends per share for A-share and Hong Kong
instruments without requiring a Tushare token. Preserve the upstream response,
the event-to-fiscal-year aggregation, currency, scale, and conservative
availability policy.

## Delivered

- [x] Route `distribution.dividendPerShare` through the existing `dividends`
      Provider capability.
- [x] Read implemented A-share cash distributions from
      `RPT_SHAREBONUS_DET`.
- [x] Keep the A-share source amount as cash per 10 shares with scale `0.1`,
      so the canonical Fact is exact cash per share.
- [x] Read Hong Kong cash distributions from
      `RPT_HKF10_MAIN_DIVBASIC`.
- [x] Parse the explicit per-share currency and amount from `PLAN_EXPLAIN`.
- [x] Exclude proposals without an amount and non-cash special
      distributions.
- [x] Aggregate multiple implemented cash distributions assigned to the same
      fiscal year and currency.
- [x] Treat the latest implementation/update announcement date as available
      only at 23:59:59 +08:00.
- [x] Preserve the complete response snapshot and record every parse,
      aggregation, scale, and availability transformation.
- [x] Cover A/H fiscal-year filtering and source-shape drift with offline
      fixtures and live canaries.
- [x] Cross-check A-share implemented distributions against CNINFO's official
      structured dividend ledger.
- [x] Cross-check Hong Kong distributions against HKEX's official EF001 cash
      dividend announcements.
- [x] Use the later of the HKEX release minute and shareholder approval date
      as the conservative availability boundary.
- [x] Produce a `verified` Fact when the official and structured aggregator
      observations agree exactly after applying their recorded scales.

## Boundaries

This phase provides annual cash dividend per share. It does not yet expose
record date, ex-dividend date, payment date, stock dividends, split ratios, or
price-adjustment factors as separate canonical concepts.

The Eastmoney Hong Kong endpoint exposes a fiscal-year label but no exact
fiscal start/end dates. HKEX arbitration therefore only emits a matching
annual Fact when the official EF001 form explicitly states a 31 December
financial year end. Non-calendar-year issuers require company fiscal-calendar
metadata before their dividend period can be treated as fully supported.

CNINFO/HKEX and Eastmoney emit the same canonical concept through the shared
verification core. Official data does not create a separate dividend store.
Ambiguous CNINFO fiscal-period labels, non-cash HKEX notices, unreadable
official documents, and unsupported fiscal calendars fail closed.
