# Point-in-time、历史 TTM 与派生血缘复测

日期：2026-07-30

基线：`6a7c42d`

本轮没有改动基线已经通过的 CNINFO 负号、主表定位、重述 TTM 和
`>5%` 冲突 fail-closed 规则。松发股份继续以 point-in-time 股本为正确
案例，没有使用当前主通道的最新股本回溯历史市值。

## 实现范围

1. CNINFO `p_stock2215` 成为 A 股 point-in-time 总股本来源。只有
   `effectiveDate <= asOf` 且 `disclosureDate <= asOf` 的最近记录可用。
2. 历史价格 Fact 的 period 表示估值截面，实际最后交易日写入
   `availability.effectiveDate`。这覆盖周末和停牌期间，并允许历史价格与
   同一估值截面的股本严格派生市值。
3. 腾讯历史行情请求窗口限制在 180 天/200 行内，避免上游实际行数上限从
   尾部截断近期交易日。
4. TTM 缺口输出概念、截止日、presentation、provider 和上游原因；CNINFO
   未披露、接口失败和已取到但未映射不再合并成一个笼统原因。若年报在
   “备查文件目录”和财务报表附注之间存在连续空文本页，或年度报告中存在
   至少六页的连续空文本主表区段，则进一步标记为
   `STATEMENT_IMAGE_ONLY`，仍不回退到报告摘要或附注取数。
5. 派生过程的所有 input Facts 都写入 SQLite。`explainFact` 递归展开输入
   Fact、Observation 和 raw snapshot；任何 `inputFactId` 缺失都会显式
   报错。
6. 新增 TypeScript 行业审计脚本，统一计算公司覆盖率、绝对金额覆盖率和
   未解决 reason code。

## Point-in-time 样例

以下 2024-08-30 市值均由“截至当日最后可用未复权收盘价 × 当时已披露且
已生效总股本”派生：

| 公司 | 总股本 | 收盘价 | 严格历史市值 |
| --- | ---: | ---: | ---: |
| 中国国航 | 16,593,720,146 | 6.98 | 115,824,166,619.08 |
| 白云机场 | 2,366,718,283 | 9.13 | 21,608,137,923.79 |
| 中国船舶 | 4,472,428,758 | 38.37 | 171,607,091,444.46 |
| 松发股份 | 124,168,800 | 12.53 | 1,555,835,064.00 |

国信证券在 2024-08-30 处于停牌期。其估值截面仍为 2024-08-30，价格
`effectiveDate` 为最后交易日 2024-08-21；修复后可与 2024-08-30
point-in-time 股本配对。

## 三行业覆盖结果

复测截面：

- 基准：`2024Q2TTM`，`asOf=2024-08-30T23:59:59+08:00`
- 最新：`2026Q1TTM`，`asOf=2026-07-29T23:59:59+08:00`

财务完整公司要求两个截面的营收和归母净利润全部可用。市场完整公司要求
两个截面的市值均由 `market-cap.price-times-shares.v1` 严格派生。完整
公司同时满足财务与市场条件。

| 行业 | 公司数 | 财务完整 | 严格市值完整 | 全部完整 |
| --- | ---: | ---: | ---: | ---: |
| 航空机场 | 13 | 5（38.46%） | 13（100%） | 5（38.46%） |
| 航海装备Ⅱ | 10 | 8（80%） | 10（100%） | 8（80%） |
| 证券Ⅱ | 49 | 25（51.02%） | 48（97.96%） | 25（51.02%） |

金额覆盖率以 primary 通道绝对金额为分母，避免亏损正负抵消。每个单元格
依次为“基准 / 最新”：

| 行业 | 营收金额覆盖 | 归母净利润金额覆盖 | 市值金额覆盖 |
| --- | ---: | ---: | ---: |
| 航空机场 | 31.61% / 71.90% | 21.34% / 68.27% | 100% / 100% |
| 航海装备Ⅱ | 11.72% / 100% | 21.53% / 100% | 100% / 100% |
| 证券Ⅱ | 53.20% / 94.36% | 53.91% / 100% | 95.12% / 100% |

证券Ⅱ唯一严格市值缺口是招商证券基准截面的 CNINFO 瞬时
`TIMEOUT`；它不是 point-in-time 口径缺陷。

## 未解决原因

以下公司数允许重叠，因为一个 TTM 可能同时缺少多个输入：

| 行业 | 财务不完整 | 截至当日尚未披露 | CNINFO PDF 字段未映射 | 不可用输入 |
| --- | ---: | ---: | ---: | ---: |
| 航空机场 | 8 | 4 | 3 | 3 |
| 航海装备Ⅱ | 2 | 1 | 1 | 0 |
| 证券Ⅱ | 24 | 14 | 16 | 2 |

所有财务不完整公司同时遇到本次环境中的 Eastmoney
`UPSTREAM_UNAVAILABLE`，因此无法由结构化第三方通道补齐。主要剩余工作
是：

1. 对 `REPORT_NOT_AVAILABLE_AS_OF` 保持 fail-closed；若 primary 基准使用
   了估值日后披露的数据，应修正基准而不是放宽 core。
2. 为扫描件或特殊财务报表版式增加可审计的官方结构化/XBRL 或 OCR
   adapter；不允许回退到报告摘要或附注中的相似数字。
3. 将 Eastmoney 空响应替换或补充为稳定的可选结构化 provider，但不得让
   Research CI 拥有独立数据层。

## 复现

```bash
pnpm audit:industry -- \
  --industry 航空机场=/path/to/航空机场_compare.json \
  --industry 航海装备Ⅱ=/path/to/航海装备Ⅱ_compare.json \
  --industry 证券Ⅱ=/path/to/证券Ⅱ_primary.json \
  --data-dir /tmp/vfc-industry-audit \
  --output work/industry-coverage-audit.json \
  --baseline-financial-as-of 2024-08-30T23:59:59+08:00 \
  --baseline-market-as-of 2024-08-30T23:59:59+08:00 \
  --latest-financial-as-of 2026-07-29T23:59:59+08:00 \
  --latest-market-as-of 2026-07-29T23:59:59+08:00 \
  --amount-coverage-threshold 0.8 \
  --transient-retries 2 \
  --transient-retry-delay-ms 1000 \
  --concurrency 2
```

财务和市场截止日默认对齐。若为了事后经济周期比较而使用披露完成后的财务
截止日，应单独设置 `--baseline-financial-as-of`，输出会标记为
`split-as-of-post-disclosure`；不得将其描述为估值日当时可知口径。审计结果
同时给出可用金额覆盖率、双独立来源金额覆盖率，以及基准营收和归母净利润
未达到阈值时的 `FAIL` 发布门禁。只有必需事实缺失且出现 `TIMEOUT`、
`AUTH_REQUIRED`、`RATE_LIMITED` 或 `UPSTREAM_UNAVAILABLE` 时才执行审计层
重试；时点不可得和字段未映射不会重试。

最终机器结果保存在本地
`work/industry-coverage-audit-20260730-final.json`，未纳入 Git。
