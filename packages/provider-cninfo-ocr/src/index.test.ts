import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractFinancialColumns } from "@verified-financial/provider-cninfo";
import {
  createCninfoOcrTextExtractor,
  findOcrCandidatePages,
  normalizeOcrNumericSeparators,
  reconstructOcrPage,
} from "./index.js";

function line(x0: number, y0: number, text: string) {
  return {
    bbox: { x0, y0, x1: x0 + 100, y1: y0 + 20 },
    text,
  };
}

function blocks(...lines: ReturnType<typeof line>[]) {
  return [{
    paragraphs: [{ lines }],
  }];
}

describe("CNINFO OCR adapter", () => {
  it("selects only the bounded longest blank statement run", () => {
    expect(findOcrCandidatePages([
      "2023 年年度报告",
      "",
      "",
      "contents",
      "第九节 备查文件目录",
      "",
      "",
      "",
      "",
      "",
      "",
      "2023 年度财务报表附注",
    ])).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it("selects statement pages whose text layer contains only page counters", () => {
    expect(findOcrCandidatePages([
      "第九节 财务报告\n二、财务报表",
      "目录\n（一）合并资产负债表 第 2 页\n（三）合并利润表 第 4 页",
      "审阅报告",
      "第 2 页 共 153 页",
      "第 3 页 共 153 页",
      "第 4 页 共 153 页",
      "第 5 页 共 153 页",
      "第 6 页 共 153 页",
      "第 7 页 共 153 页",
      "财务报表附注 2024 年 1-6 月",
    ])).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it("selects image statements hidden behind repeated notes headers", () => {
    const notesHeader = (page: number) =>
      `西部证券股份有限公司财务报表附注\n`
      + "2024 年 1 月 1 日至 2024 年 6 月 30 日\n"
      + `（除特别注明外，金额单位为人民币元）\n${page}`;
    expect(findOcrCandidatePages([
      "第九节 财务报告\n一、财务报表（附后）",
      `第十节 债券相关情况正文${"。正常文本".repeat(24)}`,
      "",
      ...Array.from({ length: 9 }, (_, index) => notesHeader(index + 69)),
      `${notesHeader(78)}\n财务报表附注\n一、公司基本情况及正文。`,
    ])).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("does not OCR low-information front matter without statement anchors", () => {
    expect(findOcrCandidatePages([
      "2023 年年度报告",
      "006 2023 68,906,236.24 4,827,256,868",
      "007 2023",
      "008 2023 289.8",
      "009 2023 90",
      "010 2023 6,243.07 1,046.03",
      "011 2023 6,000 ETF REIT",
      "012 2023 6,670 700 AI",
      "公司治理及业务回顾正文。这里开始正常的可提取文本。",
    ])).toEqual([]);
  });

  it("skips OCR when the text layer already contains the main income statement", () => {
    expect(findOcrCandidatePages([
      [
        "合并利润表",
        "2024 年 1-6 月",
        "一、营业总收入 100 90",
        "五、净利润 10 9",
        "归属于母公司所有者的净利润 8 7",
      ].join("\n"),
      "二、财务报表\n（三）合并利润表 第 4 页",
      "第 2 页 共 153 页",
      "第 3 页 共 153 页",
      "第 4 页 共 153 页",
      "第 5 页 共 153 页",
      "第 6 页 共 153 页",
      "第 7 页 共 153 页",
      "财务报表附注 2024 年 1-6 月",
    ])).toEqual([]);
  });

  it("reconstructs split label and amount columns by vertical position", () => {
    const text = reconstructOcrPage(blocks(
      line(800, 100, "合 并 利 润 表"),
      line(1050, 250, "本 朝 金 额"),
      line(1320, 250, "上 期 金 额"),
      line(1050, 300, "20,095.672,181.49"),
      line(1320, 300, "8.210.348.380.23"),
      line(250, 340, "归 属 于 母 公 司 所 有 者 的 净 利 润"),
      line(1050, 340, "751.302.210.52"),
      line(1320, 340, "-4.147.879.747.71"),
    ));

    expect(text).toContain(
      "一、营业收入 20,095,672,181.49 8,210,348,380.23",
    );
    expect(text).toContain(
      "归 属 于 母 公 司 所 有 者 的 净 利 润 751,302,210.52 -4,147,879,747.71",
    );
  });

  it("normalizes OCR grouping punctuation without changing decimals", () => {
    expect(normalizeOcrNumericSeparators(
      "20,095.672,181.49 17.937.857.423 3,416,.652,099 0.34 "
        + "6,896,205,555 83 | 6,371,577,00631 2,855,003,783. 80",
    )).toBe(
      "20,095,672,181.49 17,937,857,423 3,416,652,099 0.34 "
        + "6,896,205,555.83 | 6,371,577,006.31 2,855,003,783.80",
    );
  });

  it("marks combined consolidated/company OCR statements as four-column tables", () => {
    const text = reconstructOcrPage(blocks(
      line(800, 100, "2023 年 度 利 润 表"),
      line(800, 140, "合 并 公 司"),
      line(800, 160, "2024 年 度 2023 年 度 2024 年 度 2023 年 度"),
      line(250, 300, "一 、 营 业 收 入"),
      line(1000, 300, "113,741 46,305 74,937 32,213"),
      line(250, 340, "归 属 于 母 公 司 股 东 的 净 亏 损"),
      line(1000, 340, "(8,168) (37,356)"),
    ));

    expect(text.startsWith("合并及公司利润表\n")).toBe(true);
  });

  it("upgrades a generic income heading when OCR reveals four columns", () => {
    const text = reconstructOcrPage(blocks(
      line(800, 100, "合 并 利 润 表"),
      line(800, 120, "金 额 单 位 为 人 民 币 百 万 元"),
      line(800, 140, "合 并 公 司"),
      line(800, 160, "2024 年 度 2023 年 度 2024 年 度 2023 年 度"),
      line(250, 220, "一 、 营 业 收 入"),
      line(900, 220, "132,120 113,788 87,786 74,937"),
      line(250, 260, "归 属 于 母 公 司 股 东 的 净 亏 损"),
      line(900, 260, "(2,768) (8,190)"),
    ));

    expect(text.startsWith("合并及公司利润表\n")).toBe(true);
    expect(extractFinancialColumns([text], {
      fiscalYear: 2024,
      presentation: "annual",
    })).toMatchObject({
      comparative: { "income.revenue": "113788" },
    });
  });

  it("recovers China Eastern later-comparative columns behind a stamped heading", async () => {
    const recognize = vi.fn(async (
      _image: Uint8Array,
      mode?: "layout" | "single-block" | "sparse-text",
    ) => mode === "layout"
      ? {
          blocks: blocks(
            line(800, 100, "司 并 公 司"),
            line(
              700,
              140,
              "截 至 2025 年 6 月 30 日 截 至 2024 年 6 月 30 日 截 至 2025 年 6 月 30 日 截 至 2024 年 6 月 30 日",
            ),
            line(200, 220, "一 、 菅 业 收 入 四 (44)、 十 四 (4)"),
            line(900, 220, "66,822 64,199 45,305 42,119"),
            line(200, 260, "- 归 属 于 母 公 司 股 东 的 净 亏 损"),
            line(900, 260, "(1,431) (2,768)"),
          ),
        }
      : { text: "（除特别注明外，金额单位为人民币百万元）" });
    const extractor = createCninfoOcrTextExtractor({
      pageNumbers: [1],
      extractTextImplementation: async () => [""],
      renderPageImplementation: async () => new Uint8Array([1]),
      createRecognizerImplementation: async () => ({
        engine: "fake-ocr",
        version: "1.0.0",
        language: "chi_sim",
        recognize,
        terminate: async () => undefined,
      }),
    });

    const result = await extractor(new Uint8Array([1]));
    if (Array.isArray(result)) throw new Error("Expected structured result");
    expect(result.pages[0]).toContain("合并及公司利润表");
    expect(extractFinancialColumns(result.pages, {
      fiscalYear: 2025,
      fiscalQuarter: 2,
      presentation: "ytd",
    })).toMatchObject({
      current: {
        "income.revenue": "66822",
        "income.netProfitParent": "-1431",
      },
      comparative: {
        "income.revenue": "64199",
        "income.netProfitParent": "-2768",
      },
      comparativeEvidence: {
        "income.revenue": { scale: "1000000" },
        "income.netProfitParent": { scale: "1000000" },
      },
    });
  });

  it("returns hybrid pages and auditable OCR metadata", async () => {
    const renderPage = vi.fn(async (data, pageNumber: number, scale: number) => {
      expect([...data]).toEqual([1, 2, 3]);
      expect(scale).toBe(4);
      return new Uint8Array([pageNumber]);
    });
    const terminate = vi.fn(async () => undefined);
    const recognize = vi.fn(async (
      image: Uint8Array,
      mode?: "layout" | "single-block",
    ) => mode === "single-block"
      ? { text: "金 额 单 位 为 人 民 币 刊 万 元" }
      : {
          blocks: blocks(
            line(250, 300, `营 业 收 入 ${image[0]}`),
            line(1050, 300, "1,000"),
            line(1320, 300, "900"),
            line(250, 340, "归 属 于 母 公 司 股 东 的 净 利 润"),
            line(1050, 340, "100"),
            line(1320, 340, "90"),
          ),
        });
    const extractor = createCninfoOcrTextExtractor({
      extractTextImplementation: async (data) => {
        structuredClone(data.buffer, { transfer: [data.buffer] });
        return [
          "2023 年年度报告",
          "",
          "",
          "",
          "",
          "",
          "",
          "2023 年度财务报表附注",
        ];
      },
      renderPageImplementation: renderPage,
      createRecognizerImplementation: async () => ({
        engine: "fake-ocr",
        version: "1.2.3",
        language: "chi_sim",
        recognize,
        terminate,
      }),
    });

    const result = await extractor(new Uint8Array([1, 2, 3]));

    expect(result).toMatchObject({
      ocr: {
        engine: "fake-ocr",
        version: "1.2.3",
        language: "chi_sim",
        pageNumbers: [2, 3, 4, 5, 6, 7],
      },
    });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("Expected structured result");
    expect(result.pages[1]).toContain("金额单位为人民币百万元");
    expect(result.pages[1]).toContain(
      "合并利润表\n金额单位为人民币百万元\n营业收入 2 1,000 900",
    );
    expect(renderPage).toHaveBeenCalledTimes(6);
    expect(recognize).toHaveBeenCalledTimes(12);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("recovers a missing statement unit with sparse-text OCR", async () => {
    const recognize = vi.fn(async (
      _image: Uint8Array,
      mode?: "layout" | "single-block" | "sparse-text",
    ) => mode === "layout"
      ? {
          blocks: blocks(
            line(250, 100, "2023 年度合并及公司利润表"),
            line(250, 220, "一、营业收入"),
            line(900, 220, "113,741 46,305 74,937 32,213"),
            line(250, 260, "归属于母公司股东的净亏损"),
            line(900, 260, "(8,168) (37,356)"),
            line(250, 280, "其他项目".repeat(400)),
            line(250, 300, "基本每股亏损（人民币元/股）"),
          ),
        }
      : mode === "sparse-text"
        ? { text: "除特别注明外，金额单位为人民币脱刊万元" }
        : { text: "中国东方航空股份有限公司 2023 年度利润表" });
    const extractor = createCninfoOcrTextExtractor({
      pageNumbers: [1],
      extractTextImplementation: async () => [""],
      renderPageImplementation: async () => new Uint8Array([1]),
      cropHeaderImplementation: async (image) => image,
      createRecognizerImplementation: async () => ({
        engine: "fake-ocr",
        version: "1.2.3",
        language: "chi_sim",
        recognize,
        terminate: async () => undefined,
      }),
    });

    const result = await extractor(new Uint8Array([1, 2, 3]));
    if (Array.isArray(result)) throw new Error("Expected structured result");
    expect(extractFinancialColumns(result.pages, {
      fiscalYear: 2023,
      presentation: "annual",
    })).toMatchObject({
      current: {
        "income.revenue": "113741",
        "income.netProfitParent": "-8168",
      },
      currentEvidence: {
        "income.revenue": { scale: "1000000" },
        "income.netProfitParent": { scale: "1000000" },
      },
    });
    expect(recognize).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "sparse-text",
    );
  });

  it("recovers a securities income statement from complementary OCR modes", async () => {
    const recognize = vi.fn(async (
      _image: Uint8Array,
      mode?: "layout" | "single-block",
    ) => mode === "single-block"
      ? {
          text: [
            "《 麒 伟 孝 合 并 利 涧 表",
            "2024 年 1-6 月",
            "会 证 0 表",
            "编 制 单 位 : 国 信 证 券 股 份 有 限 公 司 单 位 ; 人 民 币 元",
            "m e | 一 一",
            "E e 一 7, 757, 496,967.11 8,207,714 090.75",
            "手 续 费 及 佣 金 浑 收 入 3,035,882,852.74 3,302,035,744.97",
            "二 、 萍 业 怡 支 出 4,543,286,806.85 4,339,034,107.98",
            "1 归 属 于 母 公 司 所 有 者 的 浑 利 涕 3 138 731 142.10 3 589,563,661.48",
          ].join("\n"),
        }
      : {
          blocks: blocks(
            line(800, 100, "会 证 0 表"),
            line(800, 140, "本 期 数 上 年 同 期 数"),
            line(1050, 180, "7, 757, 496,967.11 8,207,714 090.75"),
            line(250, 220, "手 续 费 及 佣 金 浑 收 入"),
            line(250, 260, "二 、 萍 业 怡 支 出"),
          ),
        });
    const extractor = createCninfoOcrTextExtractor({
      pageNumbers: [1],
      extractTextImplementation: async () => [""],
      renderPageImplementation: async () => new Uint8Array([1]),
      createRecognizerImplementation: async () => ({
        engine: "fake-ocr",
        version: "1.2.3",
        language: "chi_sim",
        recognize,
        terminate: async () => undefined,
      }),
    });

    const result = await extractor(new Uint8Array([1, 2, 3]));
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error("Expected structured result");
    expect(extractFinancialColumns(result.pages, {
      fiscalYear: 2024,
      fiscalQuarter: 2,
      presentation: "ytd",
    })).toMatchObject({
      current: {
        "income.revenue": "7757496967.11",
        "income.netProfitParent": "3138731142.10",
      },
    });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("recovers a combined securities statement from contextual OCR errors", () => {
    const text = reconstructOcrPage(blocks(
      line(250, 100, "仕 芥 及 母 公 司 利 润 表"),
      line(250, 140, "单 位 : 人 民 币 元"),
      line(250, 180, "项 目 附 注 本 期 金 额 上 朝 入 颜"),
      line(800, 220, "骰 并 | 御 公 司 E 吊 公 司 E 古 公 司"),
      line(250, 260, "一 : 莲 丐 8 政 入"),
      line(900, 260, "2,855,003,783.80 2,480,994,198.30 831,658,317.39 3,008,106,039.00"),
      line(250, 300, "归 厨 于 公 司 阮 东 的 浑 利 湘"),
      line(900, 300, "786,782 176.62 1,106,074,769.62"),
    ));

    expect(extractFinancialColumns([text], {
      fiscalYear: 2024,
      fiscalQuarter: 2,
      presentation: "ytd",
    })).toMatchObject({
      current: {
        "income.revenue": "2855003783.80",
        "income.netProfitParent": "786782176.62",
      },
    });
  });

  it("keeps consolidated comparisons when OCR drops the trailing company column", () => {
    const text = reconstructOcrPage(blocks(
      line(250, 100, "合 并 利 润 表"),
      line(250, 140, "单 位 : 人 民 币 元"),
      line(250, 180, "项 目 附 注 本 期 金 额 上 期 金 额"),
      line(800, 220, "吾 并 | 母 公 司 吾 并 吾 并 母 公 司"),
      line(250, 260, "一 、 营 业 口 收 入"),
      line(900, 260, "2,855,003,783.80 2,480,994,198.30 3,831,659,317.39"),
      line(250, 300, "归 属 于 母 公 司 股 东 的 浑 利 涓"),
      line(900, 300, "786,782,176.62 1,106,074,769.62"),
    ));

    expect(extractFinancialColumns([text], {
      fiscalYear: 2024,
      fiscalQuarter: 2,
      presentation: "ytd",
    })).toMatchObject({
      current: {
        "income.revenue": "2855003783.80",
        "income.netProfitParent": "786782176.62",
      },
      comparative: {
        "income.revenue": "3831659317.39",
        "income.netProfitParent": "1106074769.62",
      },
    });
  });

  it("recovers annual values with lost decimal separators", () => {
    const text = reconstructOcrPage(blocks(
      line(250, 100, "合 并 利 润 表"),
      line(250, 140, "单 位 : 人 民 币 元"),
      line(250, 180, "附 注 本 期 金 额 上 期 金 额"),
      line(250, 220, "一 、 营 业 收 入"),
      line(900, 220, "6,896,205,555 83 | 6,371,577,00631"),
      line(250, 260, "归 属 于 母 公 司 股 东 的 净 利 济"),
      line(900, 260, "1,548,231,441.85 | 1,509,258,438.82"),
    ));

    expect(extractFinancialColumns([text], {
      fiscalYear: 2023,
      presentation: "annual",
    })).toMatchObject({
      current: {
        "income.revenue": "6896205555.83",
        "income.netProfitParent": "1548231441.85",
      },
    });
  });

  it("reuses content-addressed OCR results across extractor instances", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "cninfo-ocr-cache-"));
    const basePages = [
      "2023 年年度报告",
      "",
      "",
      "",
      "",
      "",
      "",
      "2023 年度财务报表附注",
    ];
    const renderPage = vi.fn(async (
      _data: Uint8Array<ArrayBuffer>,
      pageNumber: number,
    ) => new Uint8Array([pageNumber]));
    const recognize = vi.fn(async (image: Uint8Array) => ({
      blocks: blocks(line(250, 300, `已 识 别 页 ${image[0]}`)),
    }));
    const terminate = vi.fn(async () => undefined);

    try {
      const firstExtractor = createCninfoOcrTextExtractor({
        cacheDirectory,
        cacheIdentity: "fake-ocr@1.2.3:chi_sim",
        extractTextImplementation: async () => basePages,
        renderPageImplementation: renderPage,
        createRecognizerImplementation: async () => ({
          engine: "fake-ocr",
          version: "1.2.3",
          language: "chi_sim",
          recognize,
          terminate,
        }),
      });
      const firstResult = await firstExtractor(new Uint8Array([1, 2, 3]));

      const secondRecognizer = vi.fn(async () => {
        throw new Error("OCR must not run on a persistent cache hit");
      });
      const secondRenderer = vi.fn(async () => {
        throw new Error("Rendering must not run on a persistent cache hit");
      });
      const secondExtractor = createCninfoOcrTextExtractor({
        cacheDirectory,
        cacheIdentity: "fake-ocr@1.2.3:chi_sim",
        extractTextImplementation: async () => basePages,
        renderPageImplementation: secondRenderer,
        createRecognizerImplementation: secondRecognizer,
      });
      const secondResult = await secondExtractor(new Uint8Array([1, 2, 3]));

      expect(secondResult).toEqual(firstResult);
      expect(renderPage).toHaveBeenCalledTimes(6);
      expect(recognize).toHaveBeenCalledTimes(6);
      expect(terminate).toHaveBeenCalledOnce();
      expect(secondRenderer).not.toHaveBeenCalled();
      expect(secondRecognizer).not.toHaveBeenCalled();
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
