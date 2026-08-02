import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
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

const DEFAULT_SCALE = 4;
const DEFAULT_MINIMUM_BLANK_RUN_PAGES = 6;
const DEFAULT_MAXIMUM_OCR_PAGES = 24;
const DEFAULT_CACHE_IDENTITY = "tesseract.js@7.0.0:chi_sim";
const OCR_CACHE_FORMAT = "verified-financial-cninfo-ocr-cache/v14";

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
    mode?: "layout" | "single-block" | "sparse-text",
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
  /** Persistent cache location. Disabled when omitted. */
  cacheDirectory?: string;
  /**
   * Stable OCR engine/model identity used for cache invalidation. Required
   * when cacheDirectory and a custom recognizer implementation are combined.
   */
  cacheIdentity?: string;
  extractTextImplementation?: PdfTextExtractor;
  renderPageImplementation?: RenderPageImplementation;
  createRecognizerImplementation?: () => Promise<OcrRecognizer>;
  cropHeaderImplementation?: (
    image: Uint8Array,
  ) => Promise<Uint8Array>;
}

interface CachedOcrPage {
  pageNumber: number;
  text: string;
}

interface CachedOcrDocument {
  format: typeof OCR_CACHE_FORMAT;
  cacheIdentity: string;
  scale: number;
  pageCount: number;
  requestedPageNumbers: number[];
  engine: string;
  version: string;
  language: string;
  pages: CachedOcrPage[];
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

function hasOnlyLowInformationText(value: string): boolean {
  const compact = normalizeForDetection(value);
  if (compact.length === 0) return true;
  if (
    compact.length <= 120
    && /财务报表附注.*金额单位为?人民币(?:百万元|万元|千元|元)[）)]?\d{1,4}$/
      .test(compact)
  ) {
    return true;
  }
  if (
    /财务报表附注|审[计阅]报告|备查文件目录|第[八九十\d]+节财务报告/.test(
      compact,
    )
    || /^(?:contents?|目录)$/i.test(compact)
    || /^\D{0,40}\d{4}年(?:年)?度?报告(?:全文)?$/.test(compact)
    || compact.length > 96
  ) {
    return false;
  }
  const punctuationCount = compact.match(/[，。；：]/g)?.length ?? 0;
  const statementRows = compact.match(
    /营业(?:总)?收入|归属于母公司|资产总计|经营活动产生的现金流量净额/g,
  )?.length ?? 0;
  return punctuationCount <= 1 && statementRows === 0;
}

function hasReadableConsolidatedIncomeStatement(
  pages: readonly string[],
): boolean {
  return pages.some((page, pageIndex) => {
    const normalized = page.normalize("NFKC");
    if (
      !/(?:^|\n)\s*合并(?:及(?:母)?公司)?利润表\s*(?:\n|$)/m.test(
        normalized,
      )
    ) {
      return false;
    }
    const context = normalizeForDetection(
      pages.slice(pageIndex, pageIndex + 3).join("\n"),
    );
    return /(?:营业总收入|营业收入合计)[^\n一-鿿]{0,20}[(-]?\d/.test(
      context,
    )
      && /归属于母公司(?:股东|所有者).{0,12}净(?:利润|亏损)[^\n一-鿿]{0,20}[(-]?\d/.test(
        context,
      );
  });
}

function corruptedIncomeStatementPages(
  pages: readonly string[],
  maximum: number,
): number[] {
  const candidates = pages.flatMap((page, pageIndex) => {
    const compact = normalizeForDetection(page);
    const hasStatementHeading = page.split(/\r?\n/).some((line) =>
      /^合并(?:及(?:母)?公司)?利润表(?:续)?$/.test(
        normalizeForDetection(line).replace(/[（()]/g, ""),
      )
    );
    const hasRelevantRow = /营业(?:总)?收入|归属于母公司(?:股东|所有者).{0,12}净(?:利润|亏损)/
      .test(compact);
    const hasReadableAmount = /(?:营业总收入|营业收入合计)[^\n一-鿿]{0,20}[(-]?\d/.test(
      compact,
    )
      || /归属于母公司(?:股东|所有者).{0,12}净(?:利润|亏损)[^\n一-鿿]{0,20}[(-]?\d/.test(
        compact,
      );
    return hasStatementHeading && hasRelevantRow && !hasReadableAmount
      ? [pageIndex + 1]
      : [];
  });
  return candidates.length <= maximum ? candidates : [];
}

export function findOcrCandidatePages(
  pages: readonly string[],
  options: Pick<
    CninfoOcrTextExtractorOptions,
    "minimumBlankRunPages" | "maximumOcrPages"
  > = {},
): number[] {
  if (hasReadableConsolidatedIncomeStatement(pages)) return [];
  const minimum = options.minimumBlankRunPages
    ?? DEFAULT_MINIMUM_BLANK_RUN_PAGES;
  const maximum = options.maximumOcrPages ?? DEFAULT_MAXIMUM_OCR_PAGES;
  const corruptedStatements = corruptedIncomeStatementPages(pages, maximum);
  if (corruptedStatements.length > 0) return corruptedStatements;
  const runs: Array<{ start: number; end: number; score: number }> = [];
  let start = -1;
  for (let index = 0; index <= pages.length; index += 1) {
    const lowInformation = index < pages.length
      && hasOnlyLowInformationText(pages[index]!);
    if (lowInformation && start < 0) start = index;
    if (lowInformation || start < 0) continue;
    const length = index - start;
    if (length >= minimum && length <= maximum) {
      const allBlank = pages.slice(start, index)
        .every((page) => page.trim().length === 0);
      const beforeContext = normalizeForDetection(
        pages.slice(Math.max(0, start - 4), start).join("\n"),
      );
      const nearbyBefore = /备查文件目录/.test(beforeContext);
      const financialTableBefore = /(?:二、财务报表|财务报表目录)/.test(
          beforeContext,
        )
        || /财务报表.{0,800}合并(?:及(?:母)?公司)?利润表/.test(
          beforeContext,
        );
      const nearbyAfter = pages
        .slice(index, Math.min(pages.length, index + 3))
        .some((page) =>
          /(?:年度)?财务报表附注/.test(normalizeForDetection(page))
        );
      if (
        allBlank
        || nearbyBefore
        || financialTableBefore
        || nearbyAfter
      ) {
        runs.push({
          start,
          end: index,
          score: length
            + (nearbyBefore ? 100 : 0)
            + (financialTableBefore ? 200 : 0)
            + (nearbyAfter ? 300 : 0),
        });
      }
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
  return text.replace(/(?<=\d)\.\s+(?=\d{1,2}(?:\D|$))/g, ".")
    .replace(
    /(\d{1,3}(?:,\d{3}){3})\s+(\d{2})(?=\s*[|‖]\s*\d{1,3}(?:,\d{3}){2,})/g,
    "$1.$2",
  )
    .replace(
      /(\d{1,3}(?:,\d{3}){2}),(\d{3})(\d{2})(?=\D|$)/g,
      "$1,$2.$3",
    )
    .replace(/(?<=\d),\s+(?=\d{3}(?:\D|$))/g, ",")
    .replace(
      /(\d{1,3},\d{3})\s+(\d{3}\.\d{1,2})(?=\s+\d{1,3}(?:,\d{3})+)/g,
      "$1,$2",
    )
    .replace(
      /[+-]?\d{1,3}(?:(?:,|\s+)\d{3}){3,}(?:\.\d+)?/g,
      (token) => token.replace(/\s+/g, ","),
    )
    .replace(/(?<=\d)[,.]{2,}(?=\d)/g, ",")
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

function repairOcrSemanticText(text: string): string {
  return text
    .replace(/^\s*司\s*并\s*公\s*司\s*$/gm, "合并 公司")
    .replace(/吾\s*并/g, "合并")
    .replace(/合\s*[凶并]\s*利\s*[凶K润]\s*表/g, "合并利润表")
    .replace(
      /金\s*[额四凶]\s*[单四凶]\s*位\s*均\s*[为囚四]\s*人\s*民\s*[币四凶]\s*百\s*万\s*元/g,
      "金额单位为人民币百万元",
    )
    .replace(/[营菅]\s*业\s*(?:口\s*)?收\s*入/g, "营业收入")
    .replace(
      /^(\s*一\s*、)\s*[^\d\n]{1,18}?收\s*入(?=\s*[(-]?\d)/gm,
      "$1营业总收入",
    )
    .replace(
      /仕\s*芥(?=\s*及\s*母\s*公\s*司\s*利\s*润\s*表)/g,
      "合并",
    )
    .replace(/利\s*涧\s*表/g, "利润表")
    .replace(
      /归\s*[厨属]\s*于\s*(?:母\s*)?公\s*司\s*[阮股]\s*东\s*的\s*浑\s*利\s*[湘洵涧润涕涓]/g,
      "归属于母公司股东的净利润",
    )
    .replace(/浑\s*利\s*[洵涧润涕]/g, "净利润")
    .replace(/净\s*利\s*[洵涧济]/g, "净利润")
    .replace(
      /^(\s*(?:1\s*[.、]\s*)?)[^\d\n]{0,12}母\s*公\s*司\s*股[^\d\n]{0,8}的[^\d\n]{0,8}利[^\d\n]{0,4}(?=\s*[(-]?\d)/gm,
      "$1归属于母公司股东的净利润",
    );
}

function restoreOcrIncomeStatementStructure(text: string): string {
  let lines = repairOcrSemanticText(text).split("\n");
  const compactLines = lines.map(normalizeForDetection);
  const hasSemanticIncomeHeading = compactLines.some((line) =>
    /(?:合并|合并及公司|合并及母公司)利润表/.test(line)
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
    const combinedColumns = /合并及母公司利润表/.test(compact.slice(0, 1200))
      || /合并.*公司.*公司/.test(compact.slice(0, 1200))
      || (
        /合并公司/.test(compact.slice(0, 1200))
        && (compact.slice(0, 1200).match(/\d{4}年(?:度)?/g)?.length ?? 0) >= 4
      );
    lines = [combinedColumns ? "合并及公司利润表" : "合并利润表", ...lines];
  }
  const headerContext = compact.slice(0, 1200);
  const combinedColumns = /合并.*公司.*公司/.test(headerContext)
    || (
      /合并公司/.test(headerContext)
      && (headerContext.match(/\d{4}年(?:度)?/g)?.length ?? 0) >= 4
    );
  if (hasParserReadyIncomeHeading && combinedColumns) {
    const headingIndex = lines.findIndex((line) =>
      /^合并利润表$/.test(line.trim())
    );
    if (headingIndex >= 0) lines[headingIndex] = "合并及公司利润表";
  }
  const normalizedLines = lines.map(normalizeForDetection);
  const isIncomeStatement = normalizedLines.some((line) =>
    /^(?:合并|合并及公司|合并及母公司)利润表/.test(line)
  );
  if (
    isIncomeStatement
    && !normalizedLines.some((line) => /营业(?:总)?收入/.test(line))
  ) {
    const securitiesLayout = normalizedLines.some((line) =>
        /手[续组]费及[佣偷感]金.{0,8}收入/.test(line)
      )
      && normalizedLines.some((line) => /[营萍]业.{0,2}支出/.test(line));
    const headerIndex = normalizedLines.findIndex((line) =>
      /本[期朝].{0,3}(?:金额|数|金[甄颜]).*上(?:年同)?[期朝].{0,4}(?:金额|数|[入金][颜额])/
        .test(line)
    );
    const unitIndex = normalizedLines.findIndex((line) =>
      /人民币(?:百万元|万元|千元|元)/.test(line)
    );
    const tableStartIndex = headerIndex >= 0
      ? headerIndex
      : securitiesLayout
        ? unitIndex
        : -1;
    if (tableStartIndex >= 0) {
      const valueIndex = lines.findIndex((line, index) =>
        index > tableStartIndex
        && (line.match(/[+-]?\d[\d,.]*\d/g)?.length ?? 0) >= 2
        && /\d(?:[,.]\d{3}){2,}/.test(line)
      );
      if (valueIndex >= 0) {
        lines[valueIndex] = `一、营业收入 ${lines[valueIndex]}`;
      }
    }
  }
  return lines.join("\n");
}

function statementUnit(text: string): string | undefined {
  const compact = normalizeForDetection(text.slice(0, 1200));
  if (
    /人民币(?:百万元|.{0,2}[刊白自]万元)/.test(compact)
    || /人民[币四凶]百万元/.test(compact)
  ) return "百万元";
  return /人民币(万元|千元|元)/.exec(compact)?.[1];
}

function attachStatementUnit(text: string, unit: string): string {
  const lines = text.split("\n");
  const headingIndex = lines.findIndex((line) =>
    /^(?:合并|合并及公司|合并及母公司)利润表$/.test(line.trim())
  );
  const unitLine = `金额单位为人民币${unit}`;
  if (headingIndex < 0) return `${unitLine}\n${text}`;
  lines.splice(headingIndex + 1, 0, unitLine);
  return lines.join("\n");
}

function looksLikeConsolidatedIncomeStatement(text: string): boolean {
  const compact = normalizeForDetection(text);
  return /营业(?:总)?收入/.test(compact)
    && /归属于母公司(?:股东|所有者)的净(?:利润|亏损)/.test(compact);
}

function looksLikePotentialIncomeStatement(text: string): boolean {
  const compact = normalizeForDetection(text);
  const substantiveRows = /[营萍]业.{0,2}支出/.test(compact)
    && /手[续组]费及[佣偷感]金.{0,8}收入/.test(compact);
  return substantiveRows
    || /(?:利润表|会证0?[2Z]?表)/.test(compact)
      && /(?:[营萍]业.{0,2}支出|归属于母公司)/.test(compact);
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

async function cropStatementHeader(
  image: Uint8Array,
): Promise<Uint8Array> {
  const decoded = await loadImage(Buffer.from(image));
  const sourceHeight = Math.max(1, Math.round(decoded.height * 0.32));
  const ratio = 0.7;
  const canvas = createCanvas(
    Math.max(1, Math.round(decoded.width * ratio)),
    Math.max(1, Math.round(sourceHeight * ratio)),
  );
  canvas.getContext("2d").drawImage(
    decoded,
    0,
    0,
    decoded.width,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return new Uint8Array(canvas.toBuffer("image/png"));
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
          : mode === "sparse-text"
            ? PSM.SPARSE_TEXT
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

function samePageNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length
    && left.every((pageNumber, index) => pageNumber === right[index]);
}

function parseCachedOcrDocument(
  value: unknown,
  expected: Pick<
    CachedOcrDocument,
    "cacheIdentity" | "scale" | "pageCount" | "requestedPageNumbers"
  >,
): CachedOcrDocument | undefined {
  const record = objectValue(value);
  if (
    record?.["format"] !== OCR_CACHE_FORMAT
    || record["cacheIdentity"] !== expected.cacheIdentity
    || record["scale"] !== expected.scale
    || record["pageCount"] !== expected.pageCount
    || typeof record["engine"] !== "string"
    || typeof record["version"] !== "string"
    || typeof record["language"] !== "string"
    || !Array.isArray(record["requestedPageNumbers"])
    || !record["requestedPageNumbers"].every(Number.isInteger)
    || !samePageNumbers(
      record["requestedPageNumbers"] as number[],
      expected.requestedPageNumbers,
    )
    || !Array.isArray(record["pages"])
  ) {
    return undefined;
  }
  const pages: CachedOcrPage[] = [];
  const seen = new Set<number>();
  for (const pageValue of record["pages"]) {
    const page = objectValue(pageValue);
    const pageNumber = page?.["pageNumber"];
    const text = page?.["text"];
    if (
      typeof pageNumber !== "number"
      || !Number.isInteger(pageNumber)
      || !expected.requestedPageNumbers.includes(pageNumber)
      || seen.has(pageNumber)
      || typeof text !== "string"
      || text.length === 0
    ) {
      return undefined;
    }
    seen.add(pageNumber);
    pages.push({ pageNumber, text });
  }
  return {
    format: OCR_CACHE_FORMAT,
    cacheIdentity: expected.cacheIdentity,
    scale: expected.scale,
    pageCount: expected.pageCount,
    requestedPageNumbers: [...expected.requestedPageNumbers],
    engine: record["engine"],
    version: record["version"],
    language: record["language"],
    pages,
  };
}

function ocrCacheKey(
  data: Uint8Array<ArrayBuffer>,
  cacheIdentity: string,
  scale: number,
  pageNumbers: readonly number[],
): string {
  const hash = createHash("sha256");
  hash.update(data);
  hash.update(JSON.stringify({
    format: OCR_CACHE_FORMAT,
    cacheIdentity,
    scale,
    pageNumbers,
  }));
  return hash.digest("hex");
}

function ocrCachePath(cacheDirectory: string, key: string): string {
  return join(cacheDirectory, key.slice(0, 2), `${key}.json`);
}

async function readCachedOcrDocument(
  cacheDirectory: string,
  key: string,
  expected: Parameters<typeof parseCachedOcrDocument>[1],
): Promise<CachedOcrDocument | undefined> {
  try {
    const serialized = await readFile(ocrCachePath(cacheDirectory, key), "utf8");
    return parseCachedOcrDocument(JSON.parse(serialized), expected);
  } catch {
    // A cache miss, stale schema, or corrupt file must never block extraction.
    return undefined;
  }
}

async function writeCachedOcrDocument(
  cacheDirectory: string,
  key: string,
  document: CachedOcrDocument,
): Promise<void> {
  const shardDirectory = join(cacheDirectory, key.slice(0, 2));
  const finalPath = ocrCachePath(cacheDirectory, key);
  const temporaryPath = join(
    shardDirectory,
    `.${key}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(shardDirectory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(document));
    await rename(temporaryPath, finalPath);
  } catch {
    // Cache persistence is an optimization; the verified result remains valid.
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function applyCachedOcrDocument(
  pages: string[],
  document: CachedOcrDocument,
): PdfTextExtractionResult {
  for (const page of document.pages) {
    pages[page.pageNumber - 1] = page.text;
  }
  return {
    pages,
    ...(document.pages.length === 0
      ? {}
      : {
          ocr: {
            engine: document.engine,
            version: document.version,
            language: document.language,
            pageNumbers: document.pages.map((page) => page.pageNumber),
          },
        }),
  };
}

export function createCninfoOcrTextExtractor(
  options: CninfoOcrTextExtractorOptions = {},
): PdfTextExtractor {
  const baseExtractor = options.extractTextImplementation ?? extractPdfText;
  const renderPage = options.renderPageImplementation ?? renderPdfPage;
  const createRecognizer = options.createRecognizerImplementation
    ?? createTesseractRecognizer;
  const cropHeader = options.cropHeaderImplementation ?? cropStatementHeader;
  const scale = options.scale ?? DEFAULT_SCALE;
  const maximum = options.maximumOcrPages ?? DEFAULT_MAXIMUM_OCR_PAGES;
  const cacheIdentity = options.cacheIdentity
    ?? (options.createRecognizerImplementation === undefined
      ? DEFAULT_CACHE_IDENTITY
      : undefined);
  const inFlight = new Map<string, Promise<CachedOcrDocument>>();
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

    const effectiveCacheIdentity = cacheIdentity ?? "extractor-local";
    const key = ocrCacheKey(
      renderData,
      effectiveCacheIdentity,
      scale,
      pageNumbers,
    );
    const expectedCache = {
      cacheIdentity: effectiveCacheIdentity,
      scale,
      pageCount: pages.length,
      requestedPageNumbers: pageNumbers,
    };
    if (options.cacheDirectory !== undefined && cacheIdentity !== undefined) {
      const cached = await readCachedOcrDocument(
        options.cacheDirectory,
        key,
        expectedCache,
      );
      if (cached !== undefined) return applyCachedOcrDocument(pages, cached);
    }

    let recognitionPromise = inFlight.get(key);
    const ownsRecognition = recognitionPromise === undefined;
    if (recognitionPromise === undefined) {
      recognitionPromise = (async () => {
        const recognizer = await createRecognizer();
        const recognizedPages: CachedOcrPage[] = [];
        try {
          for (const pageNumber of pageNumbers) {
            const image = await renderPage(renderData, pageNumber, scale);
            const recognition = await recognizer.recognize(image, "layout");
            const reconstructed = reconstructOcrPage(recognition.blocks);
            let text = reconstructed.length > 0
              ? reconstructed
              : normalizeOcrNumericSeparators(recognition.text?.trim() ?? "");
            const parserReady = looksLikeConsolidatedIncomeStatement(text);
            if (
              (parserReady && statementUnit(text) === undefined)
              || (!parserReady && looksLikePotentialIncomeStatement(text))
            ) {
              const supplemental = await recognizer.recognize(
                image,
                "single-block",
              );
              const supplementalText = restoreOcrIncomeStatementStructure(
                normalizeOcrNumericSeparators(
                  supplemental.text?.trim() ?? "",
                ),
              );
              if (
                !parserReady
                && looksLikeConsolidatedIncomeStatement(supplementalText)
              ) {
                text = supplementalText;
              }
              let unit = statementUnit(supplementalText);
              if (unit === undefined && parserReady) {
                try {
                  const headerImage = await cropHeader(image);
                  const headerRecognition = await recognizer.recognize(
                    headerImage,
                    "single-block",
                  );
                  const headerText = normalizeOcrNumericSeparators(
                    headerRecognition.text?.trim() ?? "",
                  );
                  unit = statementUnit(headerText);
                  if (unit === undefined) {
                    const sparseRecognition = await recognizer.recognize(
                      headerImage,
                      "sparse-text",
                    );
                    unit = statementUnit(normalizeOcrNumericSeparators(
                      sparseRecognition.text?.trim() ?? "",
                    ));
                  }
                } catch {
                  // Unit recovery is best effort; unresolved units remain
                  // unscaled and are expected to fail source verification.
                }
              }
              if (unit !== undefined) {
                text = attachStatementUnit(text, unit);
              }
            }
            text = restoreOcrIncomeStatementStructure(
              normalizeOcrNumericSeparators(text),
            );
            if (text.length === 0) continue;
            recognizedPages.push({ pageNumber, text });
          }
        } finally {
          await recognizer.terminate();
        }
        return {
          format: OCR_CACHE_FORMAT,
          cacheIdentity: effectiveCacheIdentity,
          scale,
          pageCount: pages.length,
          requestedPageNumbers: [...pageNumbers],
          engine: recognizer.engine,
          version: recognizer.version,
          language: recognizer.language,
          pages: recognizedPages,
        };
      })();
      inFlight.set(key, recognitionPromise);
    }
    try {
      const recognized = await recognitionPromise;
      if (
        ownsRecognition
        && options.cacheDirectory !== undefined
        && cacheIdentity !== undefined
      ) {
        await writeCachedOcrDocument(options.cacheDirectory, key, recognized);
      }
      return applyCachedOcrDocument(pages, recognized);
    } finally {
      if (ownsRecognition) inFlight.delete(key);
    }
  };
}
