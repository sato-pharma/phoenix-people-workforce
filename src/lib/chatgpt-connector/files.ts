/**
 * The two file tools: ChatGPT hands Phoenix the rows it gathered (from the other tools) and Phoenix
 * builds the file itself — an Excel workbook in the house identity, or a PDF in the house document
 * identity (SATO-DIS-2026-01: black ink, Brand Deep headings, hairlines, the 6% zebra and nothing else
 * filled). Owner's choice, 17 Nov 2026: "Phoenix makes them".
 *
 * The file is stored in the private `job-exports` bucket under connector/<hrId or login>/<id> with a
 * `connector_files` row, and the answer is a Phoenix link that only the SAME signed-in person can
 * open, for 7 days (app/api/connector/files/[id]/route.ts). Nothing is emailed or shared.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";
import { z } from "zod";

import type { AccessContext } from "@/lib/auth/permissions";
import { JOB_EXPORTS_BUCKET } from "@/lib/background-jobs/service";
import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { withChromiumPage } from "@/lib/pdf/chromium";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { connectorOrigin } from "./oauth";
import { defineTool, ToolRefusal, type ConnectorTool } from "./types";

export const CONNECTOR_FILE_DAYS = 7;
const MAX_SHEET_ROWS = 50_000;
const MAX_PDF_ROWS = 3_000;
const MAX_COLUMNS = 60;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const column = z.object({
  key: z.string().min(1).max(80).describe("The row field this column reads."),
  label: z.string().min(1).max(120).describe("The column heading, in words a person reads."),
  numeric: z.boolean().optional().describe("True for numbers: right-aligned, and totalled in a sheet unless noTotal."),
  noTotal: z.boolean().optional().describe("A number that must not be added down the rows (a rate, a percentage, a stock snapshot)."),
});
const table = {
  columns: z.array(column).min(1).max(MAX_COLUMNS),
  rows: z.array(z.record(z.string(), cell)).max(MAX_SHEET_ROWS),
};

export type StoredConnectorFile = { id: string; url: string; fileName: string; sizeBytes: number; expiresAt: string };

/** What the connector stores: the two built files, and the screenshot and video captures (browser/). */
export type ConnectorFileKind = "xlsx" | "pdf" | "png" | "mp4" | "webm";
export const CONNECTOR_FILE_CONTENT_TYPES: Record<ConnectorFileKind, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  png: "image/png",
  mp4: "video/mp4",
  webm: "video/webm",
};

function safeFileName(title: string, extension: ConnectorFileKind) {
  const base = title.replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Phoenix";
  return `${base}.${extension}`;
}

function ownerFolder(ctx: AccessContext) {
  return String(ctx.hrId ?? ctx.loginId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function storeConnectorFile(
  ctx: AccessContext,
  input: { kind: ConnectorFileKind; title: string; body: Buffer },
  db = getSupabaseAdmin(),
): Promise<StoredConnectorFile> {
  if (!ctx.loginId) throw new ToolRefusal("Sign in to Phoenix again.");
  const id = randomUUID();
  const fileName = safeFileName(input.title, input.kind);
  const storagePath = `connector/${ownerFolder(ctx)}/${id}.${input.kind}`;
  const contentType = CONNECTOR_FILE_CONTENT_TYPES[input.kind];
  const { error: uploadError } = await db.storage.from(JOB_EXPORTS_BUCKET).upload(storagePath, input.body, { contentType, upsert: false });
  if (uploadError) throw uploadError;
  const expiresAt = new Date(Date.now() + CONNECTOR_FILE_DAYS * 86_400_000).toISOString();
  const { error } = await db.from("connector_files").insert({
    id,
    login_id: ctx.loginId,
    hr_id: ctx.hrId ?? null,
    kind: input.kind,
    title: input.title.slice(0, 200),
    file_name: fileName,
    storage_path: storagePath,
    size_bytes: input.body.byteLength,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { id, url: `${connectorOrigin()}/api/connector/files/${id}`, fileName, sizeBytes: input.body.byteLength, expiresAt };
}

function exportColumns(columns: z.infer<typeof column>[]): ExportColumn[] {
  return columns.map((c) => ({ key: c.key, label: c.label, numeric: c.numeric === true, excludeFromTotal: c.noTotal === true }));
}

function exportRows(rows: Array<Record<string, string | number | boolean | null>>): ExportRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "Yes" : "No") : v])));
}

function linkAnswer(file: StoredConnectorFile, what: string) {
  return {
    summary: `${what} is ready: ${file.fileName}. Download it here (it opens for you only, while you are signed in to Phoenix, until ${cairoDateTimeSortable(file.expiresAt)} Cairo): ${file.url}`,
    data: { download_url: file.url, file_name: file.fileName, size_bytes: file.sizeBytes, expires_at: file.expiresAt },
  };
}

const makeSheetTool = defineTool({
  name: "phoenix_make_sheet",
  title: "Make an Excel sheet",
  description:
    "Build an Excel workbook (.xlsx) in the Sato house style from rows you already have, and return a download link only this person can open. Use it whenever the person asks for a sheet, a spreadsheet, an Excel file or a table to download. Get the figures from the other Phoenix tools first, then pass them here. Up to 10 tabs; each tab has columns and rows. Mark number columns numeric so they total; mark rates, percentages and achievement noTotal.",
  input: {
    title: z.string().min(1).max(150).describe("The workbook's title, printed at the top of each tab."),
    subtitle: z.string().max(300).optional().describe("One line under the title: the period, the scope."),
    sheets: z
      .array(z.object({ name: z.string().min(1).max(31).describe("The tab name."), ...table }))
      .min(1)
      .max(10),
  },
  async run(ctx, input) {
    const total = input.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
    if (total > MAX_SHEET_ROWS) throw new ToolRefusal(`A workbook holds up to ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows; this one has ${total.toLocaleString("en-US")}. Split it.`);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();
    const subtitle = input.subtitle ?? `Phoenix Workforce · built ${cairoDateTimeSortable(new Date().toISOString())} Cairo`;
    for (const sheet of input.sheets) {
      addPhoenixTableSheet(workbook, {
        title: input.title,
        subtitle,
        sheetName: sheet.name,
        columns: exportColumns(sheet.columns),
        rows: exportRows(sheet.rows),
        theme: "house",
      });
    }
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = await storeConnectorFile(ctx, { kind: "xlsx", title: input.title, body });
    return linkAnswer(file, "The sheet");
  },
});

const escape = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

let markHtml: string | undefined;
function houseMark(): string {
  if (markHtml !== undefined) return markHtml;
  try {
    const svg = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-light.svg"), "utf8");
    markHtml = `<img class="mark" alt="Sato Pharma" src="data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}">`;
  } catch {
    markHtml = `<span class="markword">SATO PHARMA</span>`;
  }
  return markHtml;
}

const formatNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : escape(value);

type PdfSection = {
  heading?: string;
  text?: string;
  columns?: z.infer<typeof column>[];
  rows?: Array<Record<string, string | number | boolean | null>>;
};

/** The PDF's HTML. Exported for the tests (the ink rule: nothing filled but the zebra). */
export function connectorPdfHtml(input: { title: string; subtitle?: string; sections: PdfSection[] }, builtAt = new Date()): string {
  const sections = input.sections
    .map((section) => {
      const heading = section.heading ? `<h2>${escape(section.heading)}</h2>` : "";
      const text = section.text
        ? section.text
            .split(/\n{2,}/)
            .map((para) => `<p dir="auto">${escape(para).replace(/\n/g, "<br>")}</p>`)
            .join("")
        : "";
      let tableHtml = "";
      if (section.columns?.length && section.rows) {
        const head = section.columns.map((c) => `<th class="${c.numeric ? "num" : ""}">${escape(c.label)}</th>`).join("");
        const body = section.rows
          .map(
            (row) =>
              `<tr>${section.columns!
                .map((c) => {
                  const value = row[c.key];
                  const shown = typeof value === "boolean" ? (value ? "Yes" : "No") : c.numeric ? formatNumber(value) : escape(value);
                  return `<td class="${c.numeric ? "num" : ""}" dir="auto">${shown}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("");
        tableHtml = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      return `<section>${heading}${text}${tableHtml}</section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(input.title)}</title><style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: ${HOUSE_COLORS.body}; font-size: 9.5pt; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1.2pt solid ${HOUSE_COLORS.blue}; padding-bottom: 4mm; margin-bottom: 6mm; }
  .mark { width: 34mm; }
  .markword { font-weight: 700; letter-spacing: 0.08em; color: ${HOUSE_COLORS.ink}; }
  h1 { font-size: 17pt; color: ${HOUSE_COLORS.deep}; margin: 0; }
  .sub { color: ${HOUSE_COLORS.muted}; margin: 1.5mm 0 0; }
  h2 { font-size: 11.5pt; color: ${HOUSE_COLORS.deep}; margin: 6mm 0 2mm; border-bottom: 0.5pt solid ${HOUSE_COLORS.hair}; padding-bottom: 1mm; }
  p { margin: 0 0 2.5mm; line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; table-layout: auto; margin-top: 2mm; }
  th { color: ${HOUSE_COLORS.deep}; text-align: left; font-weight: 700; border-top: 1pt solid ${HOUSE_COLORS.deep}; border-bottom: 1pt solid ${HOUSE_COLORS.deep}; padding: 1.6mm 1.8mm; }
  td { border-bottom: 0.5pt solid ${HOUSE_COLORS.hair}; padding: 1.4mm 1.8mm; vertical-align: top; overflow-wrap: anywhere; }
  tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  footer { margin-top: 8mm; border-top: 0.5pt solid ${HOUSE_COLORS.hair}; padding-top: 2mm; color: ${HOUSE_COLORS.muted}; font-size: 7.5pt; display: flex; justify-content: space-between; }
</style></head><body>
<header><div><h1 dir="auto">${escape(input.title)}</h1>${input.subtitle ? `<p class="sub" dir="auto">${escape(input.subtitle)}</p>` : ""}</div>${houseMark()}</header>
${sections}
<footer><span>Phoenix Workforce · built ${escape(cairoDateTimeSortable(builtAt.toISOString()))} Cairo</span><span>SATO-DIS-2026-01 v1.0</span></footer>
</body></html>`;
}

const makePdfTool = defineTool({
  name: "phoenix_make_pdf",
  title: "Make a PDF",
  description:
    "Build a PDF report in the Sato house document style from text and tables you already have, and return a download link only this person can open. Use it whenever the person asks for a PDF, a report to print or a document to send. Get the figures from the other Phoenix tools first. Give it a title, an optional subtitle, and sections; each section may have a heading, paragraphs of text (blank line between paragraphs) and a table (columns + rows). Landscape suits tables wider than about 7 columns.",
  input: {
    title: z.string().min(1).max(150),
    subtitle: z.string().max(300).optional(),
    landscape: z.boolean().optional(),
    sections: z
      .array(
        z.object({
          heading: z.string().max(200).optional(),
          text: z.string().max(20_000).optional(),
          columns: z.array(column).max(MAX_COLUMNS).optional(),
          rows: z.array(z.record(z.string(), cell)).max(MAX_PDF_ROWS).optional(),
        }),
      )
      .min(1)
      .max(30),
  },
  async run(ctx, input) {
    const total = input.sections.reduce((sum, section) => sum + (section.rows?.length ?? 0), 0);
    if (total > MAX_PDF_ROWS) throw new ToolRefusal(`A PDF holds up to ${MAX_PDF_ROWS.toLocaleString("en-US")} table rows; this one has ${total.toLocaleString("en-US")}. Use a sheet for the full list.`);
    const html = connectorPdfHtml(input);
    let body: Buffer;
    try {
      body = await withChromiumPage(async (page) => {
        await page.setContent(html, { waitUntil: "load" });
        await page.emulateMediaType("print");
        return Buffer.from(await page.pdf({ format: "A4", landscape: input.landscape === true, printBackground: true, preferCSSPageSize: !input.landscape }));
      });
    } catch {
      throw new ToolRefusal("Phoenix's PDF printer is busy or unavailable right now. Try again in a minute, or ask for a sheet instead.");
    }
    const file = await storeConnectorFile(ctx, { kind: "pdf", title: input.title, body });
    return linkAnswer(file, "The PDF");
  },
});

export const FILE_TOOLS: ConnectorTool[] = [makeSheetTool, makePdfTool] as unknown as ConnectorTool[];
