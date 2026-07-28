# HKEX Official Filing Provider

## Goal

Add an official H-share filing source through the existing Provider contract.
HKEX observations must reuse the canonical facts, period model, provenance,
snapshot storage, validation rules, Gateway cache, and fail-closed behavior.

## Delivered

- [x] Resolve active XHKG symbols through HKEX's predictive stock search.
- [x] Query title search with an exact historical `asOf` cutoff.
- [x] Prefer full annual/interim reports and fall back to earlier annual or
      interim results announcements when the full report was not yet public.
- [x] Preserve HKEX's minute-level release timestamp, news ID, PDF URL, search
      responses, and source PDF.
- [x] Extract text in TypeScript with `unpdf`.
- [x] Restrict matching to consolidated income, financial-position, and
      cash-flow statement boundaries.
- [x] Map revenue, operating profit, net profit, parent-attributable net
      profit, assets, liabilities, equity, cash, operating cash flow, and
      capex.
- [x] Detect CNY, HKD, or USD and the statement's units, including thousands,
      millions, and billions.
- [x] Sum property/equipment and intangible-asset cash outflows when capex is
      reported as separate statement rows.
- [x] Fail closed for future, missing, unreadable, unsupported, or unmapped
      documents.
- [x] Register HKEX in the default local Gateway without a token.
- [x] Prefer company metadata from a Provider that supplied observations so an
      unsupported Provider cannot overwrite the resolved H-share identity.

## Boundaries

The Provider supports calendar-year annual periods and first-half YTD periods.
It does not infer standalone quarters, OCR image-only filings, parse arbitrary
footnotes, or infer a non-calendar fiscal year from prose. It currently
resolves active securities; historical delisted-security lookup remains a
later extension.

HKEX is an official source, but source authority is not source independence.
Until another compatible H-share statement Provider is added, these financial
facts correctly remain `warning` with `SINGLE_INDEPENDENT_SOURCE`.
