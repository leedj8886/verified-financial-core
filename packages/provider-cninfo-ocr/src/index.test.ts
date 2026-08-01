import { describe, expect, it, vi } from "vitest";
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
      "20,095.672,181.49 17.937.857.423 3,416,.652,099 0.34",
    )).toBe(
      "20,095,672,181.49 17,937,857,423 3,416,652,099 0.34",
    );
  });

  it("marks combined consolidated/company OCR statements as four-column tables", () => {
    const text = reconstructOcrPage(blocks(
      line(800, 100, "2023 年 度 利 润 表"),
      line(800, 140, "合 并 公 司 公 司"),
      line(250, 300, "一 、 营 业 收 入"),
      line(1000, 300, "113,741 46,305 74,937 32,213"),
      line(250, 340, "归 属 于 母 公 司 股 东 的 净 亏 损"),
      line(1000, 340, "(8,168) (37,356)"),
    ));

    expect(text.startsWith("合并及公司利润表\n")).toBe(true);
  });

  it("returns hybrid pages and auditable OCR metadata", async () => {
    const renderPage = vi.fn(async (data, pageNumber: number) => {
      expect([...data]).toEqual([1, 2, 3]);
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
    expect(result.pages[1]).toContain("合并利润表\n营 业 收 入 2 1,000 900");
    expect(renderPage).toHaveBeenCalledTimes(6);
    expect(recognize).toHaveBeenCalledTimes(12);
    expect(terminate).toHaveBeenCalledOnce();
  });
});
