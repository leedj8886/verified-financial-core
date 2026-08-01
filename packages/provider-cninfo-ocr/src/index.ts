import chiSim from "@tesseract.js-data/chi_sim";
import type {
  PdfTextExtractionResult,
  PdfTextExtractor,
} from "@verified-financial/provider-cninfo";
import { createWorker, PSM } from "tesseract.js";
import {
  extractText,
  getDocumentProxy,
  renderPageAsImage,
} from "unpdf";

const DEFAULT_SCALE = 3;
const DEFAULT_MINIMUM_BLANK_RUN_PAGES = 6;
const DEFAULT_MAXIMUM_OCR_PAGES = 24;

export interface OcrRecognition {
  text?: string;
  blocks?: unknown;
}

export interface OcrRecognizer {
  engine: string;
  version: string;
  language: string;
  recognize(
    image: Uint8Array,
    mode?: "layout" | "single-block",
  ): Promise<OcrRecognition>;
  terminate(): Promise<void>;
}

export type RenderPageImplementation = (
  data: Uint8Array<ArrayBuffer>,
  pageNumber: number,
  scale: number,
) => Promise<Uint8Array>;

export interface CninfoOcrTextExtractorOptions {
  scale?: number;
  minimumBlankRunPages?: number;
  maximumOcrPages?: number;
  pageNumbers?: readonly number[];
  extractTextImplementation?: PdfTextExtractor;
  renderPageImplementation?: RenderPageImplementation;
  createRecognizerImplementation?: () => Promise<OcrRecognizer>;
}

interface PositionedLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeForDetection(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

export function findOcrCandidatePages(
  pages: readonly string[],
  options: Pick<
    CninfoOcrTextExtractorOptions,
    "minimumBlankRunPages" | "maximumOcrPages"
  > = {},
): number[] {
  const minimum = options.minimumBlankRunPages
    ?? DEFAULT_MINIMUM_BLANK_RUN_PAGES;
  const maximum = options.maximumOcrPages ?? DEFAULT_MAXIMUM_OCR_PAGES;
  const runs: Array<{ start: number; end: number; score: number }> = [];
  let start = -1;
  for (let index = 0; index <= pages.length; index += 1) {
    const blank = index < pages.length && pages[index]!.trim().length === 0;
    if (blank && start < 0) start = index;
    if (blank || start < 0) continue;
    const length = index - start;
    if (length >= minimum && length <= maximum) {
      const nearbyBefore = pages
        .slice(Math.max(0, start - 3), start)
        .some((page) => /备查文件目录/.test(normalizeForDetection(page)));
      const nearbyAfter = pages
        .slice(index, Math.min(pages.length, index + 3))
        .some((page) =>
          /(?:年度)?财务报表附注/.test(normalizeForDetection(page))
        );
      runs.push({
        start,
        end: index,
        score: length + (nearbyBefore ? 100 : 0) + (nearbyAfter ? 200 : 0),
      });
    }
    start = -1;
  }
  const selected = runs.sort((left, right) =>
    right.score - left.score
    || right.start - left.start
  )[0];
  return selected === undefined
    ? []
    : Array.from(
        { length: selected.end - selected.start },
        (_, offset) => selected.start + offset + 1,
      );
}

function collectPositionedLines(blocks: unknown): PositionedLine[] {
  if (!Array.isArray(blocks)) return [];
  const result: PositionedLine[] = [];
  for (const blockValue of blocks) {
    const block = objectValue(blockValue);
    const paragraphs = block?.["paragraphs"];
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraphValue of paragraphs) {
      const paragraph = objectValue(paragraphValue);
      const lines = paragraph?.["lines"];
      if (!Array.isArray(lines)) continue;
      for (const lineValue of lines) {
        const line = objectValue(lineValue);
        const bbox = objectValue(line?.["bbox"]);
        const text = typeof line?.["text"] === "string"
          ? line["text"].replace(/\s*\n\s*/g, " ").trim()
          : "";
        const x0 = numericValue(bbox?.["x0"]);
        const y0 = numericValue(bbox?.["y0"]);
        const x1 = numericValue(bbox?.["x1"]);
        const y1 = numericValue(bbox?.["y1"]);
        if (
          text.length === 0
          || x0 === undefined
          || y0 === undefined
          || x1 === undefined
          || y1 === undefined
        ) {
          continue;
        }
        result.push({ x0, y0, x1, y1, text });
      }
    }
  }
  return result;
}

export function normalizeOcrNumericSeparators(text: string): string {
  return text.replace(/(?<=\d)[,.]{2,}(?=\d)/g, ",")
    .replace(/[+-]?\d+(?:[,.]\d+)+/g, (token) => {
    if (/^\d{4}[.-]\d{1,2}[.-]\d{1,2}$/.test(token)) return token;
    const sign = token.startsWith("-") || token.startsWith("+")
      ? token[0]!
      : "";
    const unsigned = sign.length === 0 ? token : token.slice(1);
    const groups = unsigned.split(/[,.]/);
    const finalGroup = groups.at(-1)!;
    const hasDecimal = finalGroup.length <= 2;
    const integerGroups = hasDecimal ? groups.slice(0, -1) : groups;
    const integer = integerGroups.join(",");
    return `${sign}${integer}${hasDecimal ? `.${finalGroup}` : ""}`;
    });
}

function restoreOcrIncomeStatementStructure(text: string): string {
  let lines = text.split("\n");
  const compactLines = lines.map(normalizeForDetection);
  const hasSemanticIncomeHeading = compactLines.some((line) =>
    /^(?:合并|合并及公司|合并及母公司)利润表/.test(line)
  );
  const hasParserReadyIncomeHeading = lines.some((line) =>
    /^(?:合并|合并及公司|合并及母公司)利润表$/.test(line.trim())
  );
  const compact = compactLines.join("\n");
  if (
    !hasParserReadyIncomeHeading
    && (hasSemanticIncomeHeading || /营业(?:总)?收入/.test(compact))
    && /归属于母公司(?:股东|所有者)的净(?:利润|亏损)/.test(compact)
  ) {
    const combinedColumns = /合并.*公司.*公司/.test(compact.slice(0, 1200));
    lines = [combinedColumns ? "合并及公司利润表" : "合并利润表", ...lines];
  }
  const normalizedLines = lines.map(normalizeForDetection);
  const isIncomeStatement = normalizedLines.some((line) =>
    /^(?:合并|合并及公司|合并及母公司)利润表/.test(line)
  );
  if (
    isIncomeStatement
    && !normalizedLines.some((line) => /营业(?:总)?收入/.test(line))
  ) {
    const headerIndex = normalizedLines.findIndex((line) =>
      /本[期朝].{0,3}金额.*上[期朝].{0,3}金额/.test(line)
    );
    if (headerIndex >= 0) {
      const valueIndex = lines.findIndex((line, index) =>
        index > headerIndex
        && (line.match(/[+-]?\d[\d,.]*\d/g)?.length ?? 0) >= 2
      );
      if (valueIndex >= 0) {
        lines[valueIndex] = `一、营业收入 ${lines[valueIndex]}`;
      }
    }
  }
  return lines.join("\n");
}

function statementUnit(text: string): string | undefined {
  const compact = normalizeForDetection(text);
  if (/人民币(?:百万元|[刊白自]万元)/.test(compact)) return "百万元";
  return /人民币(万元|千元|元)/.exec(compact)?.[1];
}

function looksLikeConsolidatedIncomeStatement(text: string): boolean {
  const compact = normalizeForDetection(text);
  return /营业(?:总)?收入/.test(compact)
    && /归属于母公司(?:股东|所有者)的净(?:利润|亏损)/.test(compact);
}

export function reconstructOcrPage(blocks: unknown): string {
  const lines = collectPositionedLines(blocks).sort((left, right) =>
    (left.y0 + left.y1) / 2 - (right.y0 + right.y1) / 2
    || left.x0 - right.x0
  );
  const rows: Array<{
    center: number;
    y0: number;
    y1: number;
    lines: PositionedLine[];
  }> = [];
  for (const line of lines) {
    const center = (line.y0 + line.y1) / 2;
    const height = Math.max(1, line.y1 - line.y0);
    const row = rows
      .filter((candidate) => {
        const overlap = Math.min(candidate.y1, line.y1)
          - Math.max(candidate.y0, line.y0);
        const candidateHeight = Math.max(1, candidate.y1 - candidate.y0);
        return overlap >= Math.min(height, candidateHeight) * 0.35
          || Math.abs(candidate.center - center)
            <= Math.min(height, candidateHeight) * 0.35;
      })
      .sort((left, right) =>
        Math.abs(left.center - center) - Math.abs(right.center - center)
      )[0];
    if (row === undefined) {
      rows.push({ center, y0: line.y0, y1: line.y1, lines: [line] });
      continue;
    }
    row.lines.push(line);
    row.y0 = Math.min(row.y0, line.y0);
    row.y1 = Math.max(row.y1, line.y1);
    row.center = row.lines.reduce(
      (total, item) => total + (item.y0 + item.y1) / 2,
      0,
    ) / row.lines.length;
  }
  return restoreOcrIncomeStatementStructure(normalizeOcrNumericSeparators(
    rows.sort((left, right) => left.center - right.center)
      .map((row) => row.lines.sort((left, right) => left.x0 - right.x0)
        .map((line) => line.text)
        .join(" "))
      .join("\n"),
  ));
}

async function extractPdfText(
  data: Uint8Array<ArrayBuffer>,
): Promise<string[]> {
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  const result = await extractText(pdf, { mergePages: false });
  return result.text;
}

async function renderPdfPage(
  data: Uint8Array<ArrayBuffer>,
  pageNumber: number,
  scale: number,
): Promise<Uint8Array> {
  const rendered = await renderPageAsImage(
    new Uint8Array(data),
    pageNumber,
    {
      canvasImport: () => import("@napi-rs/canvas"),
      scale,
    },
  );
  if (typeof rendered === "string") {
    throw new Error("CNINFO OCR renderer returned an unexpected data URL");
  }
  return new Uint8Array(rendered);
}

async function createTesseractRecognizer(): Promise<OcrRecognizer> {
  const worker = await createWorker("chi_sim", undefined, {
    langPath: chiSim.langPath,
    gzip: chiSim.gzip,
    cacheMethod: "none",
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  return {
    engine: "tesseract.js",
    version: "7.0.0",
    language: "chi_sim",
    async recognize(image, mode = "layout") {
      await worker.setParameters({
        tessedit_pageseg_mode: mode === "single-block"
          ? PSM.SINGLE_BLOCK
          : PSM.AUTO,
      });
      const result = await worker.recognize(
        Buffer.from(image),
        {},
        { text: true, blocks: mode === "layout" },
      );
      return {
        text: result.data.text,
        blocks: result.data.blocks,
      };
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

function validExplicitPages(
  pages: readonly number[],
  totalPages: number,
  maximum: number,
): number[] {
  return [...new Set(pages)]
    .filter((pageNumber) =>
      Number.isInteger(pageNumber)
      && pageNumber >= 1
      && pageNumber <= totalPages
    )
    .sort((left, right) => left - right)
    .slice(0, maximum);
}

export function createCninfoOcrTextExtractor(
  options: CninfoOcrTextExtractorOptions = {},
): PdfTextExtractor {
  const baseExtractor = options.extractTextImplementation ?? extractPdfText;
  const renderPage = options.renderPageImplementation ?? renderPdfPage;
  const createRecognizer = options.createRecognizerImplementation
    ?? createTesseractRecognizer;
  const scale = options.scale ?? DEFAULT_SCALE;
  const maximum = options.maximumOcrPages ?? DEFAULT_MAXIMUM_OCR_PAGES;
  return async (data): Promise<PdfTextExtractionResult> => {
    // PDF.js may transfer and detach its input buffer while extracting text.
    // Keep an independent copy for the later page-rendering pass.
    const renderData = new Uint8Array(data);
    const baseResult = await baseExtractor(data);
    const pages = Array.isArray(baseResult)
      ? [...baseResult]
      : [...baseResult.pages];
    const pageNumbers = options.pageNumbers === undefined
      ? findOcrCandidatePages(pages, options)
      : validExplicitPages(options.pageNumbers, pages.length, maximum);
    if (pageNumbers.length === 0) return { pages };

    const recognizer = await createRecognizer();
    const recognizedPages: number[] = [];
    try {
      for (const pageNumber of pageNumbers) {
        const image = await renderPage(renderData, pageNumber, scale);
        const recognition = await recognizer.recognize(image, "layout");
        const reconstructed = reconstructOcrPage(recognition.blocks);
        let text = reconstructed.length > 0
          ? reconstructed
          : normalizeOcrNumericSeparators(recognition.text?.trim() ?? "");
        if (
          looksLikeConsolidatedIncomeStatement(text)
          && statementUnit(text) === undefined
        ) {
          const supplemental = await recognizer.recognize(
            image,
            "single-block",
          );
          const unit = statementUnit(supplemental.text ?? "");
          if (unit !== undefined) {
            text = `金额单位为人民币${unit}\n${text}`;
          }
        }
        if (text.length === 0) continue;
        pages[pageNumber - 1] = text;
        recognizedPages.push(pageNumber);
      }
    } finally {
      await recognizer.terminate();
    }
    return {
      pages,
      ...(recognizedPages.length === 0
        ? {}
        : {
            ocr: {
              engine: recognizer.engine,
              version: recognizer.version,
              language: recognizer.language,
              pageNumbers: recognizedPages,
            },
          }),
    };
  };
}
