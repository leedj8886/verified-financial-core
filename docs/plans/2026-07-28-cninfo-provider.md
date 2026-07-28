# CNINFO Official Filing Provider

## Goal

Add an official A-share source without creating a second financial-data
model. CNINFO observations must use the existing Provider contract, canonical
facts, compatibility rules, verification, provenance, snapshot storage, and
Gateway cache.

## Delivered

- [x] Resolve XSHG/XSHE symbols to CNINFO issuer `orgId` values.
- [x] Query annual, first-quarter, half-year, and third-quarter filings with an
      exact `asOf` cutoff.
- [x] Prefer the latest full Chinese report while excluding summaries,
      English editions, and correction notices.
- [x] Store issuer search JSON, announcement-list JSON, and the source PDF as
      immutable snapshots.
- [x] Extract text in TypeScript with `unpdf` and bundled CJK maps.
- [x] Restrict matching to consolidated balance-sheet, income-statement, and
      cash-flow sections.
- [x] Map revenue, operating profit, net profit, parent-attributable net
      profit, assets, liabilities, equity, cash, operating cash flow, and
      capex.
- [x] Attach official source type, announcement ID, PDF URL, filing date,
      extraction steps, and raw field to every observation.
- [x] Fail closed for future, missing, unreadable, unsupported, or unmapped
      documents.
- [x] Register CNINFO in the default local Gateway with no token or interface
      ledger.

## Boundaries

The Provider supports explicit annual and YTD periods for A shares. It does
not infer standalone-quarter values from YTD reports, OCR image-only filings,
or parse arbitrary footnotes. H-share filings remain the responsibility of a
separate HKEX Provider.
