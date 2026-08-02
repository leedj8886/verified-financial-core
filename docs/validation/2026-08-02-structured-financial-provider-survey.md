# 百度股市通与 AKShare 结构化财务通道调查

日期：2026-08-02

基线：`8c865e6`

本轮目标是确认并接入东方财富之外的结构化财务数据，减少 CNINFO/HKEX
原始公告解析与单一第三方结构化来源同时失败时的覆盖缺口。本文前半部分保留
候选接口调查，后半部分记录同日完成的 TypeScript Provider、版本安全规则和
真实网络验收结果。

## 结论

1. 百度股市通同时提供 A 股和港股的结构化利润表、资产负债表与现金流量表，
   可以进入实验 Provider 阶段。
2. 百度没有可靠的首次披露日期或版本序列，同一平台的摘要层与明细层还可能
   分别保留原始值和后来比较值，因此暂时只能用于 current-knowledge 交叉验证，
   不能独立支持严格 point-in-time。
3. AKShare 本身不是新的数据源。它把东方财富、新浪、同花顺等网页内部接口
   包装成 DataFrame，没有提供跨来源验证、版本选择、TTM 或 provenance。
4. AKShare 暴露出的两个非东财 A 股候选是新浪财经和同花顺。新浪有三张表及
   公告/更新时间字段；同花顺有精确到元的三张表和累计/单季度值，但没有披露
   日期。两者都只提供当前选中版本，不能单独重建历史版本。
5. 在 AKShare 当前股票文档中，港股财务指标仍来自东方财富；新浪和同花顺的
   实现都是 A 股接口。港股非东财结构化通道目前以百度更有价值。
6. 不应在本项目中依赖 Python AKShare。应参考它定位的上游端点，使用
   TypeScript 实现独立 Provider，并保留原始响应、字段映射和来源身份。

## 百度股市通实测

### 入口与数据形态

固定入口：

```text
GET https://finance.pae.baidu.com/api/stockwidget
  ?code=600519
  &market=ab
  &type=stock
  &widgetType=finance
  &finClientType=pc
```

入口响应的 `Result.content` 包含：

- `profitSheet` / `profitSheetV2`
- `balanceSheet` / `balanceSheetV2`
- `cashFlowSheet` / `cashFlowSheetV2`
- 每张表的 `asynUrl`
- `chartInfo`、`listInfo`、报告期、展示单位和字段名

明细接口由入口动态给出，当前形式为：

```text
GET https://finance.pae.baidu.com/selfselect/openapi
  ?srcid=5539
  &group=income_detail|balance_detail|cash_flow_detail
  &...
```

港股使用 `market=hk`，明细组名带 `_hk` 后缀。蜜雪集团 `02097` 实测返回了
`income_detail_hk` 等入口以及“总营收”“股东应占溢利”“除税后溢利”等港股
字段。

### 覆盖和精度

| 能力 | A 股 | 港股 |
| --- | --- | --- |
| 利润表 | 有 | 有 |
| 资产负债表 | 有 | 有 |
| 现金流量表 | 有 | 有 |
| 历史报告期 | 有 | 有，但取决于上市及披露历史 |
| 单季度展示值 | 有 | 视公司披露频率而定 |
| 首次公告日期 | 无 | 无 |
| 修订版本序列 | 无 | 无 |
| 数值精度 | 主要为亿/万级展示值 | 主要为亿/万级展示值 |

贵州茅台 `600519` 的明细响应实测返回 2021 三季报至 2026 一季报共 19 个报告
期。南方航空 `600029` 的关键输入与官方数值量级一致：

| 报告期 | 营收 | 归母净利润 |
| --- | ---: | ---: |
| 2023H1 | 718.30 亿元 | -28.75 亿元 |
| 2023FY | 1,599.29 亿元 | -42.09 亿元 |
| 2024H1 | 847.90 亿元 | -12.28 亿元 |
| 2025Q1 | 434.07 亿元 | -7.47 亿元 |
| 2025FY | 1,822.56 亿元 | 8.57 亿元 |

中国东航 `600115` 的 2023FY 营收返回 1,137.88 亿元，不存在此前 CNINFO OCR
路径出现的百万倍单位错误。这说明百度数据可用于识别官方 PDF 解析中的量级、
符号和列选择错误。

### 百度内部版本冲突

中信证券 `600030` 的 2024H1 是必须保留的回归样例：

| 百度内部层 | 营收 | 利润字段 |
| --- | ---: | ---: |
| `profitSheetV2` | 301.83 亿元 | 归母净利润 105.70 亿元 |
| `selfselect/openapi` | 274.33 亿元 | 合并净利润 109.82 亿元 |

`301.83` 亿元是原始中报口径，`274.33` 亿元是后续报告中的同期比较口径。
百度的两个结构化层没有给出足够的版本说明，且明细层在该证券公司样例中没有
提供“归母净利润”行。

因此百度接入必须：

- 同时读取摘要层和明细层，但不能把它们计为两个独立来源；
- 数值超过阈值时输出 `PROVIDER_INTERNAL_VERSION_CONFLICT`；
- 不允许一个层静默覆盖另一个层；
- 缺少公告日期时不填 `reportingVersion`，也不伪造 `publishedAt`；以实际抓取
  时刻作为 current-view 证据可用时间；
- 只在 current-knowledge 模式中参与交叉验证；
- strict-as-disclosed 模式必须由 CNINFO/HKEX 原始披露或带版本日期的证据裁决。

百度接口是网页内部接口，不是公开承诺的开发者 API。Provider 需要超时、限速、
原始响应缓存、fixture 回归和 feature flag，不应假设端点长期稳定。

## AKShare 是怎样取得结构化财务数据的

调查基于 AKShare `main` 分支提交
[`c6f7105`](https://github.com/akfamily/akshare/tree/c6f71056f99e45a571c15c29c1b90e55cf410969)
以及当前[股票数据文档](https://akshare.akfamily.xyz/data/stock/stock.html)。

AKShare 没有统一财务数据仓库。每个函数直接请求目标财经网站的网页内部接口，
再用 `requests`、`pandas` 和少量 HTML 解析转换成 DataFrame：

```text
调用者
  -> AKShare Python 函数
     -> 东财 / 新浪 / 同花顺网页内部 HTTP 接口
        -> JSON 或 HTML
           -> pandas.DataFrame
```

它不执行以下工作：

- 不判断多个来源是否独立；
- 不保存每次响应形成版本历史；
- 不区分原始披露值、后来比较值和正式重述值；
- 不以知识截止日选择版本；
- 不做跨来源冲突 fail-closed；
- 不产生可递归 explain 的 Fact/Observation/derivation lineage。

### 东方财富路径

AKShare 的东财个股三张表实现先请求日期列表，再以最多五个日期一组请求表格：

```text
zcfzbDateAjaxNew -> zcfzbAjaxNew
lrbDateAjaxNew   -> lrbAjaxNew
xjllbDateAjaxNew -> xjllbAjaxNew
```

`reportDateType=0/1/2` 分别用于按报告期、年度或单季度展示。相关实现见
[`stock_three_report_em.py`](https://github.com/akfamily/akshare/blob/c6f71056f99e45a571c15c29c1b90e55cf410969/akshare/stock_feature/stock_three_report_em.py)。

另一组 `stock_zcfz_em`、`stock_lrb_em`、`stock_xjll_em` 使用东财
`datacenter-web.eastmoney.com/api/data/v1/get`，按报告期批量拉取全市场截面，
并包含 `NOTICE_DATE`。这仍然属于东方财富数据族，不能解决当前项目的东财
单点依赖。

### 新浪财经路径

`stock_financial_report_sina` 直接调用：

```text
GET https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022

paperCode=sh600030
source=fzb|lrb|llb
type=0
page=1
num=1000
```

源码见
[`stock_finance_sina.py`](https://github.com/akfamily/akshare/blob/c6f71056f99e45a571c15c29c1b90e55cf410969/akshare/stock_fundamental/stock_finance_sina.py#L24)。

响应按报告期返回完整项目列表，并附带：

- `data_source`
- `is_audit`
- `publish_date`
- `rCurrency`
- `rType`
- `update_time`

数值以元为单位字符串返回，覆盖 A 股三张表历史数据。`hk02097` 实测返回
`data=null`，当前接口不能作为港股财务通道。

新浪的版本语义仍有风险。中信证券 2024H1 实测返回：

```text
营业收入 = 27,433,010,105.09
publish_date = 2025-08-29
```

结合数值与日期可以推断，接口选中了 2025 年后续报告里的 2024H1 比较值，
而不是 2024 年中报最初披露的 301.83 亿元。南方航空未发生金额变化的
2024H1 记录同样带
`publish_date=2025-08-29`。因此：

- `publish_date` 更接近“当前选中这版比较值的证据日期”，不能直接当作报告期
  的首次公告日期；
- `update_time` 与 `publish_date` 可能处于不同年份，不能把更新时间当作可靠
  的版本序列；
- 接口只返回每个报告期当前选中的一版，没有同时保留原始版和后续版。

新浪适合提供带当前版本日期的 A 股第二结构化观察值，但 strict-as-disclosed
仍需官方公告补原始版本。

### 同花顺路径

AKShare 的新版同花顺函数统一调用：

```text
GET https://basic.10jqka.com.cn/basicapi/finance/index/v1/app_data/

code=600030
market=17|33|151
type=stock
page=1
size=50
period=0|1|2|3|4
id=client_stock_debt|client_stock_benefit|client_stock_cash
```

源码见
[`stock_finance_ths.py`](https://github.com/akfamily/akshare/blob/c6f71056f99e45a571c15c29c1b90e55cf410969/akshare/stock_fundamental/stock_finance_ths.py#L291)。

每个报告期包含：

- `date`、`report_name`、`report`、`quarter_name`
- `index_list` 中的英文稳定字段名
- 每个字段的累计值 `value`
- 单季度值 `single`
- `yoy`、`mom`、`single_yoy`

与当前核心直接相关的字段包括：

| canonical fact | 同花顺字段 |
| --- | --- |
| 营业总收入 | `operating_income_total` |
| 归母净利润 | `parent_holder_net_profit` |
| 合并净利润 | `net_profit` |
| 归母权益 | `parent_holder_equity_total` |
| 经营现金流净额 | `act_cash_flow_net` |

中信证券 2024H1 实测返回：

```text
operating_income_total = 27,433,010,105.09
parent_holder_net_profit = 10,569,764,458.88
net_profit = 10,981,937,854.85
```

数值精确到元，且证券、航空等行业字段覆盖比从 PDF 做通用 OCR 更容易标准化。
但接口没有公告日期、更新时间、修订标识或原始来源链接，只能表示当前知识。

此外，AKShare 当前实现固定 `page=1,size=50`，没有根据返回的 `total` 翻页。
中信证券实测 `total=99`，因此文档所称“所有历史数据”实际上会截断为最近
50 个报告期。TypeScript Provider 若采用该端点必须完整分页。

同花顺的市场映射函数只识别 A 股/北交所代码前缀，不支持港股。
端点还会拒绝缺少浏览器 `User-Agent` 的请求，因此 Provider 必须显式设置
请求头，并把 `403`/`Nginx forbidden` 归类为上游访问限制而不是数据缺失。

## 已实现的 Provider 架构

本轮按“A 股同花顺、H 股百度股市通”完成了两个无 token 的 TypeScript
Provider，并加入默认本地 Gateway：

| Provider | 范围 | 已映射财务事实 | 精度 |
| --- | --- | --- | --- |
| `ths-financial-direct` | `XSHG` / `XSHE` / `XBSE` | 营收、营业利润、合并/归母净利润、资产、负债、总权益、现金、经营现金流、资本开支 | 元 |
| `baidu-hk-financial-direct` | `XHKG` | 营收、经营溢利、除税后/股东应占溢利、资产、负债、总权益、现金及等价物、经营现金流 | 页面展示单位，通常亿元 |

实现约束：

- 同花顺按接口返回的 `total/size` 完整分页，不继承 AKShare 固定第一页的截断；
- 同花顺显式使用浏览器 `User-Agent` 和站点 `Referer`；
- 百度只消费港股 `*SheetV2` 表，不把同一平台的摘要层和明细层计为两个来源；
- 两者都保存每页原始 JSON 和字段级 provenance；
- 两者都省略无法证明的 `reportingVersion`，并把 `publishedAt/sourceAsOf`
  设置为实际抓取时刻，因此不能穿越进较早的 strict point-in-time 请求；
- Gateway 先按公司、概念、期间、币种和会计口径寻找已知披露版本。current-view
  数值若与某一版本差异不超过 1%，只加入最新的匹配版本；若没有近似匹配，
  则加入最新已知版本并执行原有 1%/5% 冲突规则，超过 5% 仍 fail-closed；
- HKEX 原始财报观察值现在显式标记为 `original-filing`，让百度 current-view
  可以安全地对齐官方原始版本。
- Provider 能力路由现在按“市场 + 单项 requirement”过滤。东方财富继续处理港股
  行情、估值和分红，但不再为纯港股财务请求制造无意义的空响应警告；港股财务
  由 HKEX 与百度处理。
- 同花顺 Provider 不直接响应 `presentation=ttm`。TTM 只能由核心使用
  `currentYtd + previousAnnual - previousYtd` 派生，避免把半年累计值误标成 TTM。
- Gateway 验证规则版本升至 `1.15.0`，避免旧缓存复用变更前的分组和验证结果。

### 真实网络验收

数据抓取时间：2026-08-02。验收使用默认 Gateway，而不是直接比较两个临时
HTTP 响应。

中信证券 `600030.SH`，有效时点 2024-08-30，知识截止 2026-08-02：

| 事实 | 结果 | 验证上游 | 最大差异 |
| --- | ---: | --- | ---: |
| 2024H1 营收 | 274.3301010509 亿元 | CNINFO、东方财富、同花顺 | 0% |
| 2024H1 归母净利润 | 105.6976445888 亿元 | CNINFO、东方财富、同花顺 | 0% |

两个事实都被正确归入 `later-comparative`。同一营收请求不提供
`knowledgeAsOf`、严格停在 2024-08-30 时，同花顺观察值产生
`NOT_AVAILABLE_AS_OF:ths-financial-direct`，系统保留当时巨潮原始值
301.8344243374 亿元，证明 current-view 没有改写历史。

蜜雪冰城 `02097.HK`，2024FY，有效时点 2024-12-31，知识截止 2026-08-02：

| 事实 | HKEX 选择值 | 验证上游 | 最大差异 |
| --- | ---: | --- | ---: |
| 营收 | 248.28874 亿元人民币 | HKEX、百度 | 0.00051% |
| 归母净利润 | 44.36504 亿元人民币 | HKEX、百度 | 0.01118% |
| 总资产 | 197.83322 亿元人民币 | HKEX、百度 | 0.00163% |
| 总权益 | 150.60820 亿元人民币 | HKEX、百度 | 0.00120% |
| 经营现金流 | 60.08708 亿元人民币 | HKEX、百度 | 0.00486% |

五项事实均为 `verified` 且 `usable=true`。小幅差异来自百度按“亿元”保留两位
小数，最终值仍由精度更高的 HKEX 官方观察值提供。

## 三行业全量复算

复算范围为航空机场 13 家、航海装备Ⅱ 10 家、证券Ⅱ 49 家，共 72 家公司；
基准财务知识截止日和最新财务知识截止日均为 2026-08-02，基准市场有效时点为
2024-08-30，最新市场有效时点为 2026-07-31。财务节点分别请求
`2024Q2TTM` 和 `2026Q1TTM`，金额覆盖率分母沿用应用项目的主通道行业汇总。

| 行业 | 财务四项完整 | 财务四项至少双源 | 严格市值两项完整/双源 | 六项金额覆盖率 | 门禁 |
| --- | ---: | ---: | ---: | ---: | --- |
| 航空机场 | 13/13 | 13/13 | 13/13 | 100% | PASS |
| 航海装备Ⅱ | 10/10 | 10/10 | 10/10 | 100% | PASS |
| 证券Ⅱ | 49/49 | 49/49 | 49/49 | 100% | PASS |

这里的“完整/双源”指 `usable=true` 且至少两个上游，不等于所有 Fact 都是
`verified`：存在单项 1%～5% 差异、官方提取异常或部分官方输入缺失时，派生
Fact 会保持 `warning`。下游若声明只接受 `verified`，仍应按自己的发布门禁
阻断这些公司，而不能把 100% 覆盖率解释为 100% 无警告。

A 股财务事实的来源贡献如下：

- 航空机场和航海装备的四个财务节点均由 CNINFO、东方财富、同花顺覆盖全部
  公司和 100% 金额；
- 证券的东方财富、同花顺均覆盖四个节点的 49/49 家和 100% 金额；
- 证券 CNINFO 因 PDF 提取异常分别覆盖基准营收 47/49（94.10%）、最新营收
  47/49（98.72%）、基准利润 47/49（95.18%）、最新利润 46/49（94.46%）；
- 两个市值节点均由 CNINFO 的 point-in-time 总股本和腾讯历史收盘价覆盖，三
  个行业均为公司数与金额 100%。

### 官方提取异常的通用处理

v1.14 复算时，证券仍有 5 家缺营收。逐个检查 lineage 后确认并非东财或同花顺
缺数据，而是同一版本下两家 API 数值一致，CNINFO PDF 却取到了附注编号、错误
列或错误单位。例如国信证券 2024H1 的两个结构化值均约为 72.94 亿元，CNINFO
提取值却为 -4.64 亿元；中原证券 2024H1 则把约 11.99 亿元解析成几十元量级。

验证核心增加了不依赖公司名称的 `OFFICIAL_EXTRACTION_OUTLIER` 规则：

1. 官方观察值必须来自 `pdf` 或 `ocr` 提取，官方 API 不适用；
2. 必须至少有两个不同上游的非官方 API 观察值；
3. 这些 API 值彼此差异不超过 1%，且每个值与官方提取值差异都超过 5%；
4. 满足时保留全部 Observation，以结构化共识值生成 `warning`、`usable=true`
   的 Fact，并显式输出 reason code；否则沿用 `OFFICIAL_OVERRIDE_SOURCE_CONFLICT`
   fail-closed。

该规则恢复了 10 个异常输入 Fact，使证券从 44/49 提升到 49/49。复算数据库中
288 个营收/归母净利润 TTM Fact 全部带 `ttm.flow.v1` derivation，直接来源 TTM
为 0，说明覆盖提升没有重新引入“累计值冒充 TTM”的问题。

审计产物保存在本地 `work/industry-audit-structured-v15-20260802.json`；`work/`
不进入 Git，避免把较大的应用侧验证数据和缓存提交到核心仓库。

### 仍然存在的边界

- 这两个端点都是网页内部接口，不是有稳定 SLA 的公开开发者 API；需要持续
  fixture 和 live smoke test，不能替代官方源。
- current-view 结构化值不能独立证明首次披露日，也不能单独完成严格历史验证。
- 百度港股展示精度低于官方报表，不适合当金额主值，只适合检测量级、符号、
  字段和明显冲突。
- “独立来源”目前按上游站点身份计算；同花顺、百度的底层数据供应链未披露，
  因此业务报告应表述为“独立上游端点交叉验证”，不要声称独立采编。
- 三行业 72 家本轮已达到 100% 公司数和金额覆盖，但这代表指定日期、指标和
  当前端点状态下的验证结果，不等同于全 A/H 市场永久覆盖承诺。

## 对 Provider 架构的建议

### 推荐来源组合

| 市场 | 主结构化通道 | 候选第二通道 | 补充通道 | 官方裁决 |
| --- | --- | --- | --- | --- |
| A 股 | 东方财富 | 同花顺 | 新浪、百度 | CNINFO |
| 港股 | 东方财富 | 百度 | 腾讯仅行情/估值 | HKEX |

同花顺优先于新浪作为 A 股实验 Provider，原因是字段名稳定、数值精度高、同时
给出累计值和单季度值。新浪的优势是有 `publish_date`、审计、币种和合并类型，
适合作为第三观察值和版本日期线索。两者都不能代替官方披露的 point-in-time
裁决。

### 两种知识口径的使用规则

严格历史口径：

```text
effectiveAsOf == knowledgeAsOf
```

- 只使用截至当日已经披露的报告；
- 同花顺和百度不能单独证明可用性；
- 新浪 `publish_date` 只能描述当前选中版本，不能补回已经被覆盖的原始版本；
- 官方原始报告 Fact 优先，结构化值只有在版本与官方证据匹配时参与验证。

当前知识回看口径：

```text
effectiveAsOf < knowledgeAsOf
```

- 东方财富、同花顺、新浪、百度都可提供当前版本观察值；
- 必须先对齐“原始 / 后来比较 / 正式重述”版本，不能把不同版本当来源冲突；
- 同一平台的多个内部接口只算一个上游来源；
- 上游数据供应商未披露时，独立性标记为 `unverified`。

### 后续顺序

1. 将本轮 10 个官方提取异常的真实版式去敏后扩充 golden corpus，逐步修复
   CNINFO 列选择和单位识别；`OFFICIAL_EXTRACTION_OUTLIER` 是安全兜底，不是放弃
   官方解析质量。
2. 再评估 `provider-sina`，把 `publish_date` 保存为当前版本证据日期，不把
   `update_time` 推断成首次披露日期。
3. 为网页端点 schema drift 建立定期
   smoke test；若全量审计暴露系统性误差，再考虑从默认 Gateway 回退为显式开关。

## 可复现请求

百度 A 股入口：

```bash
curl -sS \
  'https://finance.pae.baidu.com/api/stockwidget?code=600519&market=ab&type=stock&widgetType=finance&finClientType=pc'
```

新浪利润表：

```bash
curl -sS --get \
  'https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022' \
  --data-urlencode 'paperCode=sh600030' \
  --data-urlencode 'source=lrb' \
  --data-urlencode 'type=0' \
  --data-urlencode 'page=1' \
  --data-urlencode 'num=1000'
```

同花顺利润表：

```bash
curl -sS --get \
  --header 'User-Agent: Mozilla/5.0' \
  --header 'Referer: https://basic.10jqka.com.cn/' \
  'https://basic.10jqka.com.cn/basicapi/finance/index/v1/app_data/' \
  --data-urlencode 'code=600030' \
  --data-urlencode 'id=client_stock_benefit' \
  --data-urlencode 'market=17' \
  --data-urlencode 'type=stock' \
  --data-urlencode 'page=1' \
  --data-urlencode 'size=50' \
  --data-urlencode 'period=0'
```
