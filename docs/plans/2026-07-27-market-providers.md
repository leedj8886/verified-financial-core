# Public A/H Provider Phase

## Goal

Add token-free public market sources behind the shared Provider contract while
keeping Tushare optional and preserving exact values, source snapshots, field
mapping versions, and availability timestamps.

## Delivered

- [x] Shared retry, timeout, rate-limit, authentication, and upstream failure
  policy.
- [x] Eastmoney A/H quote adapter and A-share annual/YTD statement adapter.
- [x] Tencent A/H quote adapter with GB18030 decoding and explicit 亿元 scale.
- [x] Baidu A/H quote adapter with conservative A-share-only PE TTM mapping.
- [x] Source field mapping ledgers and immutable snapshot references.
- [x] Offline fixture tests and opt-in live endpoint canaries.
- [x] Default local Gateway registration without tokens.

## Source policy

- Eastmoney `f162` is treated as dynamic PE and remains unmapped; it is not
  mislabeled as `valuation.peTtm`.
- Tencent market cap remains in its raw 亿元 value with
  `scale=100000000`; canonical materialization applies the scale exactly.
- Baidu HK PE is intentionally not exposed because live cross-source checks
  showed a material semantic/value conflict.
- Eastmoney financial availability uses `NOTICE_DATE` conservatively at the
  end of the reported day.
- Public aggregators accelerate the MVP. Official disclosures remain the
  long-term freshness and conflict-arbitration source.
