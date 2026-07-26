# Verified Financial Core 与 A/H Gateway 设计

- 状态：已确认，待实施计划
- 日期：2026-07-26
- 首个市场范围：A 股与 H 股
- 实现语言：TypeScript
- 首批客户端：Dexter、AI Berkshire
- 后续产品：Research CI、Cross-Agent Arena

## 1. 背景

Dexter 已经通过独立的 A/H 股数据 Worker 证明：不依赖 Financial
Datasets，也可以支持 A/H 股行情、财务报表、核心指标、分红和估值查询。
AI Berkshire 也已有 A 股行情工具、精确计算工具和报告抽检流程。

但两套实现仍分别存在以下问题：

- 数据截止日、报告期、公告时间和 TTM 口径不统一。
- 证券代码、公司主体和 A/H share class 没有统一身份模型。
- 数据源、原始字段、单位、币种和转换过程不能逐字段追溯。
- AkShare、东方财富、百度、腾讯等接口结果没有统一契约。
- 单一来源、来源冲突和部分失败有时不会被明确暴露。
- 研究 Agent 与报告审计工具可能各自抓取、映射和计算出不同数字。
- 现有 Dexter Python Worker 依赖 Conda、AkShare 和未锁定的 Python 环境。

本项目将这些一次性实现提取为独立、可审计、可复用的 TypeScript
财务事实核心。

## 2. 核心判断

系统采用“一个可信核心、两个产品入口”的结构：

1. `verified-financial-core` 统一负责原始数据、标准事实、期间与 TTM、
   provenance、验证和 Golden Corpus。
2. A/H Gateway 位于研究前和研究中，回答“这个数据包是否可靠”。
3. Research CI 位于报告生成后、发布前，回答“报告是否正确使用了可靠数据”。
4. Research CI 不拥有独立数据层，只能消费冻结的 `VerifiedFactSet`。
5. Cross-Agent Arena 以后使用相同 FactSet 作为公开评测基准。

## 3. 目标

MVP 必须实现：

- SH、SZ、BJ、HK 证券解析和 A/H 同主体关联。
- 行情快照、历史价格、三张财务报表、核心指标、分红和估值。
- 字段级来源、原始快照、原始字段、期间、币种、单位和转换链。
- 单季、YTD、年度和 TTM 的严格区分与确定性转换。
- 双源验证、官方来源裁决和机器可读状态。
- TypeScript SDK 与 JSON CLI。
- Dexter SDK 适配和 AI Berkshire CLI 适配。
- 无 Tushare Token 时仍可启动和查询。
- 默认测试完全离线。

## 4. 非目标

MVP 不实现：

- 通用 PDF 全文理解或全文搜索。
- 常驻 HTTP 服务或 MCP Server。
- Research CI 的完整报告解析产品。
- Cross-Agent Arena。
- 投资建议、估值观点或自然语言研究结论。
- 对所有上市公司和所有会计科目的首版全覆盖。

MVP 可以实现受限的官方关键字段提取，但不扩展为通用文档解析平台。

## 5. 总体架构

```text
Source Providers
  -> Raw Snapshots
  -> Source Records
  -> Canonical Observations
  -> Compatibility Filtering
  -> Cross-source Validation
  -> Official Adjudication
  -> Deterministic Derivations
  -> Verified FactSet
       -> A/H Gateway SDK / JSON CLI
            -> Dexter
            -> AI Berkshire
       -> Research CI
       -> Cross-Agent Arena
```

职责边界：

- Provider 负责抓取、保存和解析源数据结构。
- Core 负责 canonical concept、期间、口径、验证和公式。
- Gateway 负责 Provider 调度、缓存策略和 FactSet 组装。
- 客户端只负责查询、展示和工作流编排。
- Research CI 只负责报告声明映射与发布门禁。

## 6. TypeScript 技术边界

新仓库全部采用 TypeScript，不包含 Python 或 Conda 运行依赖。

技术基线：

- TypeScript strict、ESM。
- Node.js 22+，同时兼容 Bun。
- pnpm workspace。
- Zod 用于运行时验证与 JSON Schema 导出。
- `decimal.js` 用于金额、比例和验证计算。
- `better-sqlite3` 用于缓存、索引和审计元数据。
- SHA-256 内容寻址文件用于保存原始 JSON、HTML 和 PDF。
- Vitest 用于单元、合约和 Golden Corpus 测试。
- tsup 用于 SDK 和 CLI 构建。

禁止使用 JavaScript `number` 执行决策敏感的金额、比例、估值和差异计算。
公共 JSON 中的精确数值使用十进制字符串。

## 7. 仓库结构

```text
verified-financial-core/
├── packages/
│   ├── schema/
│   ├── core/
│   ├── storage/
│   ├── provider-contract/
│   ├── provider-eastmoney/
│   ├── provider-baidu/
│   ├── provider-tencent/
│   ├── provider-tushare/
│   ├── provider-cninfo/
│   ├── provider-hkex/
│   └── sdk/
├── apps/
│   ├── ah-gateway-cli/
│   └── research-ci/
├── adapters/
│   ├── dexter/
│   └── ai-berkshire/
├── tests/
│   ├── fixtures/
│   ├── contracts/
│   └── golden/
└── docs/
```

依赖方向必须单向：

```text
schema -> core
schema -> provider-contract
provider-contract -> provider packages
core + providers + storage -> sdk
sdk -> CLI and adapters
sdk -> Research CI
```

`core` 不得依赖具体 Provider、Dexter、AI Berkshire 或 Research CI。

## 8. 身份模型

公司主体与上市证券分离：

```ts
interface Company {
  companyId: string;
  legalName: string;
  jurisdiction: string;
}

interface Instrument {
  instrumentId: string;
  companyId: string;
  exchangeMic: "XSHG" | "XSHE" | "XBSE" | "XHKG";
  symbol: string;
  shareClass: "A" | "H";
  tradingCurrency: "CNY" | "HKD";
}
```

推荐 instrument ID：

- `XSHG:600519`
- `XSHE:000001`
- `XBSE:430047`
- `XHKG:00700`

公司级财务事实关联 `companyId`。股价、股本、市值、每股指标和分红必须关联
具体 `instrumentId`。核心拒绝跨 share class 组合价格与股本。

## 9. Canonical Observation

Provider 不能直接生成最终可信事实，只能生成 Observation：

```ts
interface Observation {
  observationId: string;
  companyId: string;
  instrumentId?: string;
  concept: string;
  value: string;
  unit: string;
  scale: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
  availability: Availability;
  provenance: Provenance;
}
```

Provider 未能映射的字段进入 `UnmappedObservation`，不得丢弃或伪装成
canonical fact。

### Canonical Concept Registry

`concept` 不是任意字符串。`packages/schema` 维护版本化的 Concept Registry：

```ts
interface ConceptDefinition {
  conceptId: string;
  valueType: "decimal" | "text" | "date" | "boolean";
  scope: "company" | "instrument";
  periodKind: "instant" | "duration";
  canonicalUnit: string;
  allowedPresentations: ReportingPeriod["presentation"][];
}
```

MVP 至少包含：

```text
market.price.close
market.shares.outstanding
market.cap
valuation.peTtm
valuation.pb
income.revenue
income.operatingProfit
income.netProfit
income.netProfitParent
income.epsBasic
balance.assets
balance.liabilities
balance.equity
balance.cash
cashFlow.operatingCashFlow
cashFlow.capex
cashFlow.freeCashFlow
distribution.dividendPerShare
```

Source-specific mapping 位于对应 Provider package，并声明 mapping 版本：

```ts
interface SourceFieldMapping {
  upstreamSchema: string;
  rawField: string;
  conceptId: string;
  unit: string;
  scale: string;
  transformIds: string[];
}
```

Provider mapping 必须通过 Concept Registry 校验。Provider 可以拥有源字段知识，
但不能在自己的 mapping 中发明公共 concept 或更改其会计含义。

## 10. Reporting Period 与 Availability

报告期间和数据可得时间必须分开：

```ts
interface ReportingPeriod {
  kind: "instant" | "duration";
  startDate?: string;
  endDate: string;
  fiscalYear: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  presentation: "quarter" | "ytd" | "annual" | "ttm";
}

interface Availability {
  filingDate?: string;
  publishedAt?: string;
  sourceAsOf?: string;
  fetchedAt: string;
}
```

历史查询只允许：

```text
publishedAt <= request.asOf
```

只有报告截止日而没有可靠公告日期的 Observation，不得进入历史时点的
`verified` Fact。它可以进入当前查询，但必须带时间完整性警告。

## 11. 会计口径

```ts
interface AccountingBasis {
  standard: "CAS" | "IFRS" | "OTHER";
  scope: "consolidated" | "standalone";
  presentation: "reported" | "adjusted";
  attribution?: "parent" | "all-shareholders";
  currency: string;
}
```

只有以下维度兼容时才允许交叉验证：

- canonical concept。
- 证券或公司作用域。
- 报告期间与 presentation。
- 币种、单位和 scale。
- 会计准则。
- 合并或母公司范围。
- reported 或 adjusted。
- 归母或全体股东口径。

GAAP 与 Non-GAAP、归母利润与集团净利润即使数值接近，也不能判定一致。

## 12. Provenance

```ts
interface Provenance {
  providerId: string;
  upstreamSourceId: string;
  sourceType: "official" | "first-party" | "aggregator";
  documentId?: string;
  sourceUrl: string;
  rawSnapshotId: string;
  rawField: string;
  extractionMethod: "api" | "html" | "pdf" | "derived";
  fetchedAt: string;
  transformations: TransformationStep[];
}
```

`providerId` 与 `upstreamSourceId` 必须分开。通过 AkShare 调用东方财富和直接
调用东方财富只能算一个独立上游。

每个 Fact 必须能够反向定位到：

1. Observation。
2. Provider 和真实上游。
3. 原始字段。
4. 原始响应哈希。
5. 转换步骤。
6. 抓取时间和公告时间。

## 13. Canonical Fact 与验证状态

```ts
interface CanonicalFact {
  factId: string;
  companyId: string;
  instrumentId?: string;
  concept: string;
  value: string;
  unit: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
  status: "verified" | "warning" | "failed";
  usable: boolean;
  reasonCodes: string[];
  observationIds: string[];
  verification: VerificationResult;
  derivation?: Derivation;
}
```

状态规则：

| 状态 | 规则 |
|---|---|
| `verified` | 至少两个独立、兼容来源，差异不超过 1% |
| `warning` | 单一来源；差异为 1%–5%；公告时间缺失；或官方值已裁决但存在明显冲突 |
| `failed` | 差异超过 5% 且无法裁决；期间、币种或口径冲突；关键转换输入缺失 |
| `unmapped` | 原始字段存在，但尚未映射到 canonical concept |

`unmapped` 属于 Observation 处理状态，不创建伪 Fact。

官方披露可以裁决最终数值，但不能隐藏冲突。官方值覆盖第三方冲突时，Fact
标记为：

```text
status = warning
usable = true
reasonCodes += OFFICIAL_OVERRIDE_SOURCE_CONFLICT
```

## 14. 派生指标与 TTM

```ts
interface Derivation {
  formulaId: string;
  formulaVersion: string;
  inputFactIds: string[];
  expression: string;
  rounding?: string;
}
```

流量型 TTM 默认公式：

```text
当前 YTD
+ 上一完整年度
- 上年同期 YTD
```

只有三个输入 Fact 的 concept、公司作用域、期间、币种、会计准则、合并范围和
归属口径完全兼容时才计算。

以下公式必须分别版本化：

- `ttm.flow.v1`
- `roe.average-equity.v1`
- `fcf.ocf-minus-capex.v1`
- `market-cap.price-times-shares.v1`
- `pe.price-divided-by-eps.v1`

FCF 不得使用“经营现金流加全部投资现金流”的旧 Dexter 简化定义。ROE
不得默认使用 YTD 净利润除期末权益。

## 15. Verified FactSet

查询必须区分必需字段和可选字段：

```ts
interface FactRequest {
  instrument: string;
  concepts: Array<{
    conceptId: string;
    required: boolean;
  }>;
  periods: string[];
  asOf: string;
  freshness?: FreshnessPolicy;
}
```

```ts
interface VerifiedFactSet {
  schemaVersion: string;
  factSetId: string;
  request: {
    companyId?: string;
    instrumentId?: string;
    asOf: string;
  };
  generatedAt: string;
  company: Company;
  instruments: Instrument[];
  facts: CanonicalFact[];
  unmapped: UnmappedObservation[];
  validations: VerificationResult[];
  rawSnapshotIds: string[];
  summary: {
    verified: number;
    warnings: number;
    failed: number;
    unmapped: number;
    overallStatus: "verified" | "warning" | "failed";
  };
}
```

`overallStatus` 汇总规则：

- 任一必需 concept 没有可用 Fact，或其 Fact 为 `failed`：`failed`。
- 所有必需 Fact 可用，但任一必需 Fact 为 `warning`：`warning`。
- 所有必需 Fact 均为 `verified`，但可选 Fact 有 warning、failed 或 unmapped：
  `warning`。
- 所有返回 Fact 均为 `verified`，且没有未解决错误：`verified`。
- 请求没有产生任何 Fact：`failed`，reason code 为 `EMPTY_FACT_SET`。

`factSetId` 由规范化请求、参与的原始快照哈希、mapping 版本、公式版本和验证
规则版本共同确定。同样输入和同样版本必须产生相同 FactSet。

## 16. Provider 契约

```ts
interface SourceProvider {
  providerId: string;
  upstreamSourceId: string;
  capabilities: ProviderCapability[];
  fetch(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderBatch>;
}
```

Provider 负责：

- 请求构造。
- 限流、超时和重试。
- 原始响应保存。
- 源数据解析。
- 原始字段和来源元数据。

Provider 不负责：

- 选择最终可信值。
- 隐藏来源冲突。
- 独立计算 TTM。
- 强行合并不兼容口径。

## 17. 数据源策略

MVP 数据源：

| 数据类型 | A 股 | H 股 | 官方裁决 |
|---|---|---|---|
| 证券身份 | 东方财富、腾讯 | 东方财富、腾讯 | 交易所证券列表 |
| 行情快照 | 腾讯、东方财富 | 腾讯、东方财富 | 后续增强 |
| 历史价格 | 东方财富 | 东方财富、腾讯 | — |
| 估值 | 百度、东方财富 | 东方财富、可用的 Tushare 能力 | 核心重新验算 |
| 三张报表 | 东方财富、可选 Tushare | 东方财富、可选 Tushare | 巨潮、HKEX |
| 分红 | 巨潮、东方财富 | HKEX、东方财富 | 巨潮、HKEX |
| 公告元数据 | 巨潮 | HKEX | 本身为官方来源 |

长期方向是提高官方披露覆盖率，降低第三方结构化数据对最终裁决的影响。

## 18. Tushare 可选约束

Tushare 是可选加速 Provider，不是系统地基：

```yaml
providers:
  tushare:
    enabled: auto
    tokenEnv: TUSHARE_TOKEN
    required: false
```

规则：

- 没有 Token 时不注册 Provider。
- 权限不足返回 `AUTH_REQUIRED`。
- 配额不足返回 `RATE_LIMITED`。
- Tushare 接口目录和字段映射只存在于 `provider-tushare`。
- Tushare 字段不得泄漏到公共 Schema。
- 默认测试不得需要 Token。
- 无 Tushare 时，系统仍返回完整 FactSet 结构。
- 来源不足时诚实返回 `warning`，不能冒充 `verified`。

## 19. 官方关键字段提取

为避免基础开源版永久依赖 Tushare，MVP 包含受限官方关键字段提取：

- 营业收入。
- 归母净利润。
- 总资产。
- 总负债。
- 股东权益。
- 经营现金流。
- 资本开支。

官方 Provider 同时负责：

- 公告列表和发布时间。
- 文档 ID、URL 和 SHA-256。
- 原始 PDF 下载。
- 历史 `asOf` 可得性。

如果官方文档存在但无法自动提取目标字段，系统不猜测修正值，而是返回官方
文档引用和 `OFFICIAL_DOCUMENT_UNREADABLE`。

## 20. 缓存与存储

原始快照不可变：

```text
data/raw/{sha256}.json.gz
data/raw/{sha256}.html.gz
data/raw/{sha256}.pdf
```

SQLite 保存：

- `snapshots`
- `provider_requests`
- `companies`
- `instruments`
- `fact_sets`
- `fact_set_facts`
- `validation_runs`
- `mapping_versions`

默认新鲜度：

| 数据 | max age |
|---|---:|
| 行情快照 | 60 秒 |
| 日线历史 | 交易日内 15 分钟 |
| 财报与分红 | 24 小时 |
| 公告索引 | 30 分钟 |
| 已下载官方 PDF | 永久，以哈希区分版本 |

离线缓存必须增加 `STALE_CACHE` 或 `OFFLINE_SNAPSHOT` reason code。

## 21. 错误模型

```ts
type ProviderErrorCode =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "UPSTREAM_SCHEMA_CHANGED"
  | "EMPTY_RESPONSE"
  | "PARSE_FAILED"
  | "UNSUPPORTED_INSTRUMENT"
  | "OFFICIAL_DOCUMENT_UNREADABLE";
```

处理规则：

- 一个 Provider 失败、另一个成功：Fact 为 `warning`。
- 两个独立来源成功且一致：Fact 为 `verified`。
- 来源冲突且官方尚未裁决：关键 Fact 为 `failed`。
- 所有 Provider 失败：FactSet 为 `failed`。
- 非关键字段失败不删除其他 Fact，但必须出现在 summary。
- Gateway 不因部分成功而丢弃错误。
- 空 FactSet 不能被任何下游视作成功。

## 22. TypeScript SDK

MVP SDK：

```ts
interface FinancialGateway {
  resolveInstrument(input: string): Promise<InstrumentResolution>;
  getFacts(request: FactRequest): Promise<VerifiedFactSet>;
  getFactSet(factSetId: string): Promise<VerifiedFactSet>;
  explainFact(factId: string): Promise<FactExplanation>;
}
```

数据质量问题通过 FactSet 状态表达。只有无效配置、存储损坏等系统错误抛异常。

## 23. JSON CLI

```bash
ah-context resolve 600519.SH

ah-context facts 600519.SH \
  --concept income.revenue \
  --period 2025FY \
  --as-of 2026-07-26 \
  --format json

ah-context explain fact_01K... --format json
ah-context doctor
```

约束：

- JSON 只写 stdout。
- 日志和诊断只写 stderr。
- Token 必须脱敏。
- 支持 `--offline`。
- 支持 `--require-status verified`。

退出码：

| code | 含义 |
|---:|---|
| 0 | 查询完成并满足要求 |
| 2 | FactSet 已生成，但未满足要求状态 |
| 3 | 输入、配置或认证错误 |
| 4 | 存储或不可恢复系统错误 |

可选 Provider 的认证或配额错误属于 FactSet 数据质量信息，不单独触发退出码
`3`；只有用户显式要求该 Provider 或配置本身无效时才视为 CLI 认证错误。

## 24. Dexter 适配

Dexter 保留：

- LangChain Tool。
- 自然语言二级路由。
- 进度事件。
- 面向 LLM 的紧凑 formatter。

Dexter 删除：

- Python Worker 运行链。
- Conda 环境配置。
- 重复 ticker 规则。
- 独立 TTM 和验证逻辑。

旧的 China Tool 名称在迁移期保留，但内部统一调用 TypeScript SDK。

Formatter 必须展示 FactSet 状态、数据截止日、币种、期间、关键 warning 和
来源，不得把 `failed` Fact 当成普通数值。

## 25. AI Berkshire 适配

AI Berkshire 通过 JSON CLI 消费 FactSet：

```bash
ah-context facts 0700.HK \
  --concept income.revenue \
  --period 2025FY \
  --as-of 2026-07-26 \
  --require-status verified \
  --format json
```

首先更新 canonical `skills/financial-data.md`，再生成 Codex skill。不要手工修改
生成文件。

现有 Python 验算工具可以在迁移期保留，但重复的 TTM、ROE、FCF、市值和跨源
验证逻辑最终迁入 TypeScript Core。

## 26. Research CI 契约

Research CI 固定输入：

```ts
interface ResearchCiInput {
  markdown: string;
  factSet: VerifiedFactSet;
  policy: AuditPolicy;
}
```

Research CI 不接受 ticker 后自行抓取另一套数据。如果用户只提供报告和 ticker，
系统必须先显式生成 FactSet，并把 FactSet ID 固化到审计记录。

```ts
interface ClaimAudit {
  claimId: string;
  reportLocation: {
    line: number;
    text: string;
  };
  matchedFactIds: string[];
  reportedValue: string;
  expectedValue?: string;
  verdict: "PASS" | "WARN" | "FAIL";
  impact: "low" | "medium" | "high";
  reasonCodes: string[];
  suggestedCorrection?: string;
}
```

报告保存：

```yaml
verified_context:
  fact_set_id: fs_01K...
  schema_version: 1.0.0
  generated_at: 2026-07-26T10:00:00+08:00
  as_of: 2026-07-26
```

审计针对冻结 FactSet，不用未来重新抓取的数据改写历史结论。

## 27. 测试策略

默认 `pnpm test` 完全离线，分为：

1. Schema 测试。
2. Core 单元测试。
3. Core property test。
4. Provider contract test。
5. Golden Corpus。
6. Consumer contract test。

必须永久保证：

- `publishedAt > asOf` 的 Observation 不进入历史 FactSet。
- A/H 价格和错误 share class 股本不能组合。
- GAAP 与 Non-GAAP 不能因数值接近而一致。
- 同一真实上游的不同包装不能算两个来源。
- 单一来源不能为 `verified`。
- 不完整 TTM 输入不能生成 TTM Fact。
- 同一快照和规则版本产生相同 FactSet。
- 空 FactSet 不能被 Research CI 判为 PASS。

## 28. Golden Corpus

首批样本：

| 样本 | 目标 |
|---|---|
| 贵州茅台 `600519.SH` | A 股年报、季报、股价、市值、TTM |
| 腾讯 `0700.HK` | HKD 股价、RMB 财报、IFRS/Non-IFRS |
| 中国神华 A/H | 同公司、不同证券、币种和 share class |
| 九号公司 `689009.SH` | 百度与东方财富估值冲突 |
| 招商银行 `600036.SH` | 银行业特殊报表字段 |
| 单来源 fixture | 必须为 warning |
| 未来公告 fixture | 防止前视偏差 |
| 单位错误 fixture | 元、万、亿转换 |
| 字段改名 fixture | `UPSTREAM_SCHEMA_CHANGED` |
| 空 FactSet fixture | 下游 fail-closed |

Golden 测试同时比较数值、状态、reason code、Observation 数量、独立上游数量、
原始快照引用、公式版本和数据可得时间。

## 29. Live Canary

真实网络测试单独运行：

```bash
pnpm test:live
pnpm test:live --provider eastmoney
pnpm test:live --instrument 600519.SH
```

Live Canary 不属于默认离线测试，不把实时数值写死。发现 schema drift 时先隔离
Provider，不允许静默继续产出错误事实。

## 30. 迁移计划

### 阶段一：冻结契约

- 建立 TypeScript monorepo。
- 实现 Schema、Core、Storage 和 Provider Contract。
- 导入 Dexter 与 AI Berkshire fixtures。
- 不修改 Dexter 运行链。

### 阶段二：建立 Gateway

- 实现东方财富、百度、腾讯 Provider。
- 实现巨潮/HKEX 公告元数据和官方关键字段提取。
- 实现可选 Tushare Provider。
- 发布 SDK 和 JSON CLI。

### 阶段三：迁移 Dexter

- 保留旧 Tool 名称。
- 内部切到 SDK。
- 新旧结果并行对照。
- 稳定后删除 Python Worker 与 Conda 配置。

### 阶段四：接入 AI Berkshire

- 更新 canonical financial-data skill。
- 重新生成 Codex skills。
- 用 FactSet 引用替代手工数据拼接。
- 逐步迁移重复计算。

### 阶段五：Research CI

- 只消费冻结 FactSet。
- 实现报告 Claim 映射与发布门禁。
- 空数据、单来源和关键字段冲突 fail-closed。

## 31. MVP 验收标准

MVP 完成必须同时满足：

- 新仓库全部代码为 TypeScript。
- 无 Python 或 Conda 运行依赖。
- 支持 SH、SZ、BJ、HK 证券解析。
- 支持行情、三表、核心指标、分红和估值。
- 每个 Fact 可追溯到原始快照和原始字段。
- 历史 `asOf` 查询不使用未来公告。
- TTM 只由兼容输入生成。
- 无 Tushare Token 时可以启动和查询。
- 单一来源不会被标成 `verified`。
- Provider 部分失败不会丢失错误。
- Dexter 可通过 SDK 获得 FactSet。
- AI Berkshire 可通过 CLI 获得相同 FactSet。
- 同一 FactSet 可作为 Research CI 固定输入。
- 默认测试完全离线。
- Golden Corpus 覆盖 A/H、币种、期间、口径和来源冲突。

## 32. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 第三方接口字段变化 | Provider 合约、fixture、Live Canary、schema drift 隔离 |
| Tushare 权限与配额 | Provider 可选，无 Token 验收 |
| 官方 PDF 难解析 | 受限关键字段、失败显式化、保留原文 |
| A/H 身份混用 | Company/Instrument 分离与 property test |
| 历史前视偏差 | `publishedAt <= asOf` 硬约束 |
| 公式漂移 | 公式 ID、版本和输入 Fact 血缘 |
| 两个可信产品数字不一致 | Research CI 强制消费冻结 FactSet |
| 迁移影响 Dexter | 保留旧 Tool 名，新旧结果对照 |

## 33. 已确认决策

- 采用契约优先方案，不直接搬出 Dexter Worker。
- 新项目采用独立 monorepo。
- 全部新代码采用 TypeScript。
- Python Worker 仅作为迁移参考，不作为运行依赖。
- Tushare 是可选 Provider。
- MVP 包含受限官方关键字段提取。
- Gateway 先于 Research CI 实现。
- Research CI 不拥有独立数据层。
- SDK 是业务入口，CLI 是 SDK 的 JSON 封装。
- HTTP、MCP、通用 PDF 解析和 Arena 延后。
