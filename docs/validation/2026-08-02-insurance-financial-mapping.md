# A 股保险公司财务映射复测

日期：2026-08-02

版本：CNINFO mapping `cninfo@1.16.0`、validation rules `1.22.0`、
CNINFO OCR cache `verified-financial-cninfo-ocr-cache/v14`

本轮保持官方来源优先、`>5%` 冲突 fail-closed 和至少两个独立上游来源的
要求不变，没有写入主通道预期值，也没有降低任何验证门槛。

## 根因与实现

保险公司财务报表与普通公司存在四类通用版式差异：

1. 半年报可能命名为“中期报告”，合并利润表可能命名为“中期合并利润表”，
   或嵌在带公司名、页码、章节编号和“……的合并利润表”的运行页眉中。旧逻辑
   因此错误返回 `REPORT_NOT_AVAILABLE_AS_OF` 或 `STATEMENT_NOT_FOUND`。
2. 新保险合同准则下，`保险服务收入`、利息收入等是营业收入的组成项。
   canonical `income.revenue` 继续采用与 Eastmoney、THS 可比的合并
   `营业总收入`；仅当报表以 `营业收入合计` 表示同一总额时使用该标签，不能
   退化为保险服务收入。
3. 单位表头常写作“金额单位均为人民币百万元”。旧单位规则漏掉“均”，会把
   百万元数值当作元。当前规则识别该变体，并将 `scale=1000000` 保留在
   Observation 血缘中。
4. 中国人保部分年度 PDF 的原生文本层保留行标签但丢失全部金额。此前“标签
   可读”会阻止 OCR；现在只有在精确利润表标题、目标标签存在而金额缺失时，
   才对相应报表页进行 OCR。OCR 后再修复常见标题/单位字形，并在有单位表头的
   情况下拆分相邻两列被合并成的数字 token，仍由表头日期、合并范围和表边界
   选择当前列与比较列。

同时拒绝把同时列出多个报表标题但没有报表金额的目录页或审计封面当作利润表
起点，避免跨十余页继承错误的单位和列布局。

## 回归样本

新增中国平安、中国人保、中国太保的 2023 年报、2024 中报、2025 年报和
2026 一季报真实页面顺序 fixture，共 12 组；覆盖合并/母公司边界、跨页报表、
保险专用收入结构、当前/上年同期列、中国人保年度报告损坏文本层，以及页级
OCR 的列合并。另增加中国平安“中期报告”公告解析 fixture。

## 全新数据目录复测

复测使用 `maxAgeSeconds=0` 和全新 SQLite/data-dir：

- 财务知识截止：`2026-08-02T23:59:59+08:00`
- 基准财务有效期：`2024Q2TTM`
- 最新财务有效期：`2026Q1TTM`
- 市值截面：`2024-08-30`、`2026-07-29`

| 指标 | 公司覆盖 | 金额覆盖 | 双独立来源公司覆盖 | 双独立来源金额覆盖 |
| --- | ---: | ---: | ---: | ---: |
| 基准 TTM 营收 | 5/5 | 100% | 5/5 | 100% |
| 最新 TTM 营收 | 5/5 | 100% | 5/5 | 100% |
| 基准 TTM 归母净利润 | 5/5 | 100% | 5/5 | 100% |
| 最新 TTM 归母净利润 | 5/5 | 100% | 5/5 | 100% |
| 基准总市值 | 5/5 | 100% | 5/5 | 100% |
| 最新总市值 | 5/5 | 100% | 5/5 | 100% |

发布门禁为 `PASS`，`failedMetrics=[]`，行业及三家目标公司均无 unresolved
reason。三家目标公司的四个财务节点均由 `cninfo + eastmoney + ths`
交叉验证，两个市值节点均由 `cninfo + tencent` 交叉验证。

| 公司 | 基准营收 | 最新营收 | 基准归母净利润 | 最新归母净利润 | 与主通道差异 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 中国平安 | 919,972 百万元 | 1,036,110 百万元 | 90,443 百万元 | 132,784 百万元 | 0% |
| 中国人保 | 564,738 百万元 | 660,991 百万元 | 25,579 百万元 | 42,611 百万元 | 0% |
| 中国太保 | 343,040 百万元 | 433,986 百万元 | 34,057 百万元 | 53,919 百万元 | 0% |

严格历史市值与主通道的最大相对差异小于 `0.001%`。

## 派生事实与 FactSet

| 公司 | 节点 | FactSet | 营收 Fact | 归母净利润 Fact |
| --- | --- | --- | --- | --- |
| 中国平安 | 2024Q2TTM | `fs:60b4d62b2e1cde560b0d5e781d75e9b2f370c55b8baa2664f8d7c4192f4d19ee` | `fact:38a54abcaf41cf29d1fa336fff16d9bad2bb47efb422a8a1cc33ad76fff37b41` | `fact:8cdac313d9eb48b0b7b50bf91b91538ebc42dda27a26f560e056fd26ce9fce0d` |
| 中国平安 | 2026Q1TTM | `fs:0f15a3a251c5b4044abe8b90c1b603033e1e7cf29e47a2f3f95071c5969e22c2` | `fact:5d5416d5e2cc1e995bca4d3abb0760352ca956cead6b2d1108794392d5e95999` | `fact:403d4c1477ce9ecad0f2574c06239e74a6eb243272d2102672553644e2aa3a1e` |
| 中国人保 | 2024Q2TTM | `fs:c9e0f907b109300aaf09706e141f3f734134a93b5a9b3920db580bd79f5f75d5` | `fact:9c8d90477e35c60962ad4ac26ac0bf7f0487b7ad35116631fca5d65beca52901` | `fact:0a6e6061a8a4b027230eb9078b58b76e219484d6ed96958d4c2cfcbc93909161` |
| 中国人保 | 2026Q1TTM | `fs:37a64c688e9d05d68f8c9a6da76838ead70c079a0f42707bdc84a767a755d366` | `fact:30ef7053be02409dfeadf35530799b3c4c6cbba53ec39631fd217ce82079c4d3` | `fact:985db4c917c4d65c3124cf9488b6d9b1eef2a1e740ce3a7187667f1c4a5e5dee` |
| 中国太保 | 2024Q2TTM | `fs:cea4828ce3e3d22d04167a0aa2a460ffb91750f64990226ecfdbca194317bdc6` | `fact:82279d996a807a648d730bcf2549e3eeb5205f778fc15ac8a52285afa4171971` | `fact:e49c6e9715f686a3c9c61570909d1797571f834eee166301a8af58066cc9dcf2` |
| 中国太保 | 2026Q1TTM | `fs:2a9a192df83ebf4017a3bb03f9120ed9a1973706cb69e102d4649d3df8a9118b` | `fact:cdfd0d3d5739e52262bfe36ba7b8ac5b9910311ba4a224c115e29a19071cc8b0` | `fact:2b15c6433eb9cb7b4a227127c3c8173c08bc9a6bcd4f113bce94ae09acfff436` |

每个派生 Fact 的 `derivation.inputFactIds` 和 `observationIds` 都已持久化。
以下每行给出一个目标公司原始 CNINFO Observation 及对应 raw snapshot，完整
输入链可通过 `explainFact` 从上表 Fact ID 递归展开：

| 公司 | 报告输入 | Observation | rawSnapshot |
| --- | --- | --- | --- |
| 中国平安 | 2023FY 营收 | `obs:8f2cab9b3592c2c48342b49a9ca95d2adff4c2d82e145128de656cc40204e4a6` | `sha256:6ffff1cade59c64c8178494c083cac8a4011ef5ae2fed32f85dd488a64a809b2` |
| 中国平安 | 2024H1 营收 | `obs:46317bdd44a86d8188eee2910f18a7a93b1517105e32662a32a6c544f5a44134` | `sha256:318810d1b887d90d15946043450b1fedc5941ed982dac030a2edabf5a16054a6` |
| 中国平安 | 2026Q1 营收 | `obs:4de9984a7a980863955397cae6191122db926329d77281501fbf8b17d32aedd5` | `sha256:d5567e038cc150220ee431869b83d88b194fef0d6e5ca12ac976b1b7116d986f` |
| 中国人保 | 2023FY 营收 | `obs:704f3384171dbaba1d3a38f52478fb9179913348e38d1ac43191cdadae5c35a5` | `sha256:7ede132c8af8d5215b24ecf7b0375374649555e55d058b2eebed02f2e9aac978` |
| 中国人保 | 2024H1 营收 | `obs:cbe2098c803f96ce84191919cb38f7c7e2fd10725ee9c079acb3421854cf9892` | `sha256:b09fd6b5933936f7442aac0656cbf8bc12146b2e02a34eddb9725c38b19d3f92` |
| 中国人保 | 2025FY 营收 | `obs:c271e2df90a8bbb65adb4f2c9dd1ccdab521231d1601f9f9980d7aa81eca1701` | `sha256:6b2c0a1cf5b0f2932644e140d067b698451d19120da738be3489acc66f25ac0e` |
| 中国太保 | 2023FY 营收 | `obs:54b55e4aaff5a5d60bccb69d8b38d990b548f1b2a1af179bf6cf8d9d1681abd7` | `sha256:90d594e772763c99cc4bc302cd7b070082239f07809cdf1df25f8dafc7b853b5` |
| 中国太保 | 2024H1 营收 | `obs:a5d926a128cba4ea9762266f1a70e346a5fd50c357b0d3b4b6204350b27d0a18` | `sha256:993d19cdf2e86b20292ecb092190378159797a3780b520b85c5d69b1bc05b836` |
| 中国太保 | 2025FY 营收 | `obs:f5124610f1ec0ca987d3507dad7554987ad64806a6dddcec851fb696fa959d5e` | `sha256:3787b6a6ec1bf480be2092e7bae156bd0f1d1b7f9f28bd9226d038951c788dee` |

## 复现

```bash
node scripts/audit-industry-coverage.ts \
  --cninfo-ocr \
  --industry '保险Ⅱ=/path/to/保险Ⅱ_20240830_20260731_primary.json' \
  --data-dir /tmp/vfc-insurance-rules-1.22 \
  --output /tmp/insurance-rules-1.22.json \
  --baseline-financial-as-of 2026-08-02T23:59:59+08:00 \
  --baseline-market-as-of 2024-08-30T23:59:59+08:00 \
  --latest-financial-as-of 2026-08-02T23:59:59+08:00 \
  --latest-market-as-of 2026-07-29T23:59:59+08:00 \
  --amount-coverage-threshold 0.8 \
  --max-age-seconds 0 \
  --transient-retries 2 \
  --transient-retry-delay-ms 1000 \
  --concurrency 2
```

本地机器结果位于 `tmp/insurance-20260802-rules-1.22-current-knowledge-ocr.json`
和 `tmp/insurance-audit-rules-1.22/metadata.sqlite`，不纳入 Git。
