import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";

import { PHOENIX_RAIL_MARK_PNG_BASE64 } from "@/lib/export/phoenix-pdf-assets";
import type { EmployeePlan } from "@/lib/weekly-planning/service";

// Premium Phoenix-identity exporters for weekly / monthly plans.
//
// Both formats reproduce the on-screen workspace: one polished card per plan with
// a dark brand band, the Date · Type · Region · Area · Medical Rep day grid, the
// orange date spine, and the orange-tinted Notes strip under each day. Colours and
// layout mirror src/components/employee-portal/plans-workspace.tsx so a printed /
// downloaded plan looks exactly like what the user approved on screen.

export type PlanExportRepOption = {
  areaName: string | null;
  fullName: string;
  hrId: string;
};

export type PlanExportOptions = {
  /** Same-line Medical Rep directory used to auto-resolve the rep for non-Double-Visit rows. */
  medicalRepOptions?: PlanExportRepOption[];
  /** Human label for the export scope (e.g. "My Plans", "Manager review"). */
  scopeLabel?: string;
  /** Stamp used in the brand band. Defaults to now. */
  generatedAt?: Date;
};

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

function compactText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Helvetica (the PDF standard font) only encodes WinAnsi and throws on anything
 * outside it. Transliterate the typography we deliberately use (middle dots, dashes,
 * ellipsis, curly quotes, the return arrow) to ASCII, then drop anything still
 * unsupported so a non-Latin name can never crash the export.
 */
function asciiSafe(value: unknown) {
  return compactText(value)
    .replace(/[•·]/g, "-")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/↩/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E]/g, "");
}

function statusLabel(value: string | null | undefined) {
  if (!value) return "";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatStamp(date: Date) {
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDayName(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(parsed);
}

function formatDayDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", timeZone: "UTC" }).format(parsed);
}

type StatusToneKey = "red" | "amber" | "emerald" | "sky" | "slate";

function statusToneKey(status: string): StatusToneKey {
  if (status.includes("rejected")) return "red";
  if (status.includes("returned")) return "amber";
  if (status === "final_approved" || status === "hr_acknowledged") return "emerald";
  if (status === "submitted" || status === "manager_approved") return "sky";
  return "slate";
}

type PlanItem = EmployeePlan["items"][number];

/** Resolve the Medical Rep label exactly as the workspace grid shows it. */
function medicalRepDisplay(item: PlanItem, options: PlanExportRepOption[] | undefined) {
  if (item.activityType === "Double Visit") {
    const name = compactText(item.doubleVisitMedicalRepName);
    return name ? `${name} (DV)` : "Double Visit — rep not set";
  }
  const area = compactText(item.area).toLowerCase();
  if (area && options && options.length > 0) {
    const match = options.find((rep) => compactText(rep.areaName).toLowerCase() === area);
    if (match) return match.fullName;
  }
  return "";
}

function planItems(plan: EmployeePlan): PlanItem[] {
  if (plan.items.length > 0) return plan.items;
  return [
    {
      activityDate: plan.periodStartDate,
      activityTitle: "",
      activityType: "Office",
      area: null,
      attendees: null,
      doubleVisitMedicalRepHrId: null,
      doubleVisitMedicalRepName: null,
      endTime: null,
      id: `${plan.id}-empty`,
      locationText: null,
      notes: "",
      objective: null,
      returnNotes: [],
      sortOrder: 0,
      startTime: null,
    },
  ];
}

// ===========================================================================
// XLSX — premium per-plan cards
// ===========================================================================

const X = {
  black: "FF000000",
  slate900: "FF0F172A",
  slate800: "FF1E293B",
  slate700: "FF334155",
  slate500: "FF64748B",
  slate400: "FF94A3B8",
  slate300: "FFCBD5E1",
  slate200: "FFE2E8F0",
  slate50: "FFF8FAFC",
  white: "FFFFFFFF",
  orange600: "FFEA580C",
  orange500: "FFF97316",
  orange400: "FFFB923C",
  orangeLine: "FFF8B56B",
  orange100: "FFFFEDD5",
  orange50: "FFFFF7ED",
  sky400: "FF38BDF8",
  emerald400: "FF34D399",
  violet400: "FFA78BFA",
  violet700: "FF6D28D9",
  violet50: "FFF5F3FF",
  amber50: "FFFFFBEB",
  amber700: "FFB45309",
} as const;

const X_TONE: Record<StatusToneKey, { fill: string; text: string }> = {
  amber: { fill: "FFFFFBEB", text: "FFB45309" },
  emerald: { fill: "FFECFDF5", text: "FF047857" },
  red: { fill: "FFFEF2F2", text: "FFB91C1C" },
  sky: { fill: "FFF0F9FF", text: "FF0369A1" },
  slate: { fill: "FFF1F5F9", text: "FF334155" },
};

const XLSX_COLUMNS = [
  { label: "Day", width: 10, accent: X.slate300 },
  { label: "Date", width: 13, accent: X.slate300 },
  { label: "Type", width: 16, accent: X.sky400 },
  { label: "Region", width: 22, accent: X.emerald400 },
  { label: "Area", width: 20, accent: X.orange400 },
  { label: "Medical Rep", width: 30, accent: X.violet400 },
  { label: "Notes", width: 52, accent: X.orange400 },
] as const;

const XLSX_COL_COUNT = XLSX_COLUMNS.length;

function fill(color: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

function thinGrid(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: X.orangeLine } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

export async function buildEmployeePlansWorkbook(
  plans: EmployeePlan[],
  options: PlanExportOptions = {},
) {
  const generatedAt = options.generatedAt ?? new Date();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = generatedAt;

  const sheet = workbook.addWorksheet("Weekly Monthly Plans", {
    views: [{ state: "frozen", ySplit: 2 }],
    properties: { defaultRowHeight: 16 },
  });

  XLSX_COLUMNS.forEach((col, index) => {
    sheet.getColumn(index + 1).width = col.width;
  });

  // --- Brand band (rows 1-2) ------------------------------------------------
  sheet.mergeCells(1, 1, 1, XLSX_COL_COUNT);
  const brand = sheet.getCell(1, 1);
  brand.value = {
    richText: [
      { text: "PHOENIX", font: { name: "Calibri", size: 16, bold: true, color: { argb: X.orange500 } } },
      { text: "   Weekly / Monthly Plans", font: { name: "Calibri", size: 16, bold: true, color: { argb: X.white } } },
    ],
  };
  brand.alignment = { vertical: "middle", horizontal: "left", indent: 5 };
  brand.fill = fill(X.black);
  sheet.getRow(1).height = 34;

  sheet.mergeCells(2, 1, 2, XLSX_COL_COUNT);
  const sub = sheet.getCell(2, 1);
  const scopeText = options.scopeLabel ? `${options.scopeLabel} · ` : "";
  sub.value = `Phoenix Workforce · ${scopeText}${plans.length} plan(s) · exported ${formatStamp(generatedAt)}`;
  sub.font = { name: "Calibri", size: 10, italic: true, color: { argb: X.slate400 } };
  sub.alignment = { vertical: "middle", horizontal: "left", indent: 5 };
  sub.fill = fill(X.black);
  sheet.getRow(2).height = 18;

  try {
    const imageId = workbook.addImage({ base64: PHOENIX_RAIL_MARK_PNG_BASE64, extension: "png" });
    sheet.addImage(imageId, {
      tl: { col: 0.12, row: 0.18 },
      ext: { width: 30, height: 30 },
      editAs: "oneCell",
    });
  } catch {
    // Emblem is decorative — never block the export if the image fails to embed.
  }

  let cursor = 4; // leave row 3 as a spacer

  if (plans.length === 0) {
    sheet.mergeCells(cursor, 1, cursor, XLSX_COL_COUNT);
    const empty = sheet.getCell(cursor, 1);
    empty.value = "No plans available for this export.";
    empty.font = { name: "Calibri", size: 11, italic: true, color: { argb: X.slate500 } };
    empty.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(cursor).height = 26;
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  for (const plan of plans) {
    cursor = writePlanCardXlsx(sheet, plan, cursor, options.medicalRepOptions);
    cursor += 1; // blank spacer between cards
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function writePlanCardXlsx(
  sheet: ExcelJS.Worksheet,
  plan: EmployeePlan,
  startRow: number,
  repOptions: PlanExportRepOption[] | undefined,
) {
  let row = startRow;

  // --- Plan meta band (employee + period) -----------------------------------
  sheet.mergeCells(row, 1, row, 4);
  sheet.mergeCells(row, 5, row, XLSX_COL_COUNT);
  const nameCell = sheet.getCell(row, 1);
  nameCell.value = {
    richText: [
      { text: `${plan.employeeName}  `, font: { name: "Calibri", size: 12, bold: true, color: { argb: X.white } } },
      { text: `HR ${plan.employeeHrId}`, font: { name: "Calibri", size: 10, color: { argb: X.slate300 } } },
    ],
  };
  nameCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  nameCell.fill = fill(X.slate900);
  const periodCell = sheet.getCell(row, 5);
  periodCell.value = `${plan.planKind === "weekly" ? "Weekly" : "Monthly"} · ${plan.periodKey}`;
  periodCell.font = { name: "Calibri", size: 11, bold: true, color: { argb: X.orange400 } };
  periodCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
  periodCell.fill = fill(X.slate900);
  sheet.getRow(row).height = 24;
  row += 1;

  // --- Plan meta sub-band (manager + status) --------------------------------
  sheet.mergeCells(row, 1, row, 4);
  sheet.mergeCells(row, 5, row, XLSX_COL_COUNT);
  const mgrCell = sheet.getCell(row, 1);
  mgrCell.value = `Manager: ${plan.managerName ?? "—"}    ·    Revision ${plan.revision}`;
  mgrCell.font = { name: "Calibri", size: 10, color: { argb: X.slate300 } };
  mgrCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  mgrCell.fill = fill(X.slate800);
  const tone = X_TONE[statusToneKey(plan.status)];
  const statusCell = sheet.getCell(row, 5);
  statusCell.value = statusLabel(plan.status);
  statusCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: tone.text } };
  statusCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
  statusCell.fill = fill(tone.fill);
  sheet.getRow(row).height = 18;
  row += 1;

  // --- Column header --------------------------------------------------------
  const headerRow = sheet.getRow(row);
  XLSX_COLUMNS.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.label;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: col.accent } };
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    cell.fill = fill(X.slate900);
    cell.border = thinGrid();
  });
  headerRow.height = 20;
  row += 1;

  // --- Day rows -------------------------------------------------------------
  const items = planItems(plan);
  items.forEach((item, index) => {
    const dataRow = sheet.getRow(row);
    const zebra = index % 2 === 1;
    const returnNotesText = item.returnNotes
      .map((note) => `↩ ${note.actorRole ?? "Reviewer"}: ${note.note}`)
      .join("\n");
    const notes = [compactText(item.notes), returnNotesText].filter(Boolean).join("\n");

    const values = [
      formatDayName(item.activityDate),
      formatDayDate(item.activityDate),
      item.activityType,
      compactText(item.locationText),
      compactText(item.area),
      medicalRepDisplay(item, repOptions),
      notes,
    ];

    values.forEach((value, colIndex) => {
      const cell = dataRow.getCell(colIndex + 1);
      cell.value = value;
      cell.border = thinGrid();
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: colIndex === XLSX_COL_COUNT - 1 };
      if (colIndex === 0) {
        cell.font = { name: "Calibri", size: 9, bold: true, color: { argb: X.orange600 } };
      } else if (colIndex === 1) {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: X.slate700 } };
      } else if (colIndex === 5 && item.activityType === "Double Visit") {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: X.violet700 } };
      } else {
        cell.font = { name: "Calibri", size: 10, color: { argb: X.slate700 } };
      }
      if (item.returnNotes.length > 0) {
        cell.fill = fill(X.amber50);
      } else if (zebra) {
        cell.fill = fill(X.orange50);
      } else {
        cell.fill = fill(X.white);
      }
    });

    // Orange date spine — emphasise the left edge of the Day cell.
    dataRow.getCell(1).border = {
      ...thinGrid(),
      left: { style: "medium", color: { argb: X.orange500 } },
    } as ExcelJS.Borders;

    const noteLines = notes ? notes.split("\n").length : 1;
    dataRow.height = Math.max(20, noteLines * 14 + 4);
    row += 1;
  });

  return row;
}

// ===========================================================================
// PDF — premium per-plan cards (pdf-lib)
// ===========================================================================

function hx(hex: string) {
  const n = hex.replace("#", "");
  return rgb(
    parseInt(n.slice(0, 2), 16) / 255,
    parseInt(n.slice(2, 4), 16) / 255,
    parseInt(n.slice(4, 6), 16) / 255,
  );
}

const P = {
  black: hx("#000000"),
  slate900: hx("#0F172A"),
  slate800: hx("#1E293B"),
  slate700: hx("#334155"),
  slate600: hx("#475569"),
  slate500: hx("#64748B"),
  slate400: hx("#94A3B8"),
  slate300: hx("#CBD5E1"),
  slate200: hx("#E2E8F0"),
  slate100: hx("#F1F5F9"),
  slate50: hx("#F8FAFC"),
  white: hx("#FFFFFF"),
  orange600: hx("#EA580C"),
  orange500: hx("#F97316"),
  orange400: hx("#FB923C"),
  orange100: hx("#FFEDD5"),
  orange50: hx("#FFF7ED"),
  sky400: hx("#38BDF8"),
  emerald400: hx("#34D399"),
  violet400: hx("#A78BFA"),
  violet700: hx("#6D28D9"),
  violet200: hx("#DDD6FE"),
  violet50: hx("#F5F3FF"),
  amber700: hx("#B45309"),
  amber200: hx("#FDE68A"),
  amber50: hx("#FFFBEB"),
};

const PDF_TONE: Record<StatusToneKey, { bg: ReturnType<typeof rgb>; text: ReturnType<typeof rgb> }> = {
  amber: { bg: hx("#FFFBEB"), text: hx("#B45309") },
  emerald: { bg: hx("#ECFDF5"), text: hx("#047857") },
  red: { bg: hx("#FEF2F2"), text: hx("#B91C1C") },
  sky: { bg: hx("#F0F9FF"), text: hx("#0369A1") },
  slate: { bg: hx("#F1F5F9"), text: hx("#334155") },
};

const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 34;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = MARGIN + 18; // reserve space for footer

// Date · Type · Region · Area · Medical Rep (mirrors the workspace grid).
const PDF_COLS = [
  { label: "Date", width: 68, accent: P.slate400 },
  { label: "Type", width: 84, accent: P.sky400 },
  { label: "Region", width: 118, accent: P.emerald400 },
  { label: "Area", width: 110, accent: P.orange400 },
  { label: "Medical Rep", width: CONTENT_W - 68 - 84 - 118 - 110, accent: P.violet400 },
];

export async function buildEmployeePlansPdf(
  plans: EmployeePlan[],
  options: PlanExportOptions = {},
) {
  const generatedAt = options.generatedAt ?? new Date();
  const doc = await PDFDocument.create();
  doc.setTitle("Phoenix Workforce — Weekly / Monthly Plans");
  doc.setCreator("Phoenix Workforce");
  doc.setProducer("Phoenix Workforce");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let emblem: PDFImage | null = null;
  try {
    emblem = await doc.embedPng(Buffer.from(PHOENIX_RAIL_MARK_PNG_BASE64, "base64"));
  } catch {
    emblem = null;
  }

  const subtitle = `${options.scopeLabel ? `${options.scopeLabel} · ` : ""}${plans.length} plan(s) · ${formatStamp(generatedAt)}`;

  const ctx = new PdfRenderer(doc, font, bold, emblem, subtitle);

  if (plans.length === 0) {
    ctx.text("No plans available for this export.", MARGIN, ctx.y - 24, {
      size: 12,
      font,
      color: P.slate500,
    });
  } else {
    for (const plan of plans) {
      ctx.drawPlanCard(plan, options.medicalRepOptions);
    }
  }

  ctx.finalize();
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

type TextOptions = {
  size: number;
  font: PDFFont;
  color: ReturnType<typeof rgb>;
};

class PdfRenderer {
  private readonly doc: PDFDocument;
  private readonly font: PDFFont;
  private readonly bold: PDFFont;
  private readonly emblem: PDFImage | null;
  private readonly subtitle: string;
  private page: PDFPage;
  y = 0;
  private pageNumber = 0;

  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont, emblem: PDFImage | null, subtitle: string) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.emblem = emblem;
    this.subtitle = subtitle;
    this.page = this.newPage();
  }

  private newPage(): PDFPage {
    this.pageNumber += 1;
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = this.drawBrandBand();
    return this.page;
  }

  private drawBrandBand(): number {
    const bandH = 56;
    const top = PAGE_H - bandH;
    this.page.drawRectangle({ x: 0, y: top, width: PAGE_W, height: bandH, color: P.black });
    this.page.drawRectangle({ x: 0, y: top - 3, width: PAGE_W, height: 3, color: P.orange500 });

    let textX = MARGIN;
    if (this.emblem) {
      const size = 34;
      this.page.drawImage(this.emblem, {
        x: MARGIN,
        y: top + (bandH - size) / 2,
        width: size,
        height: size,
      });
      textX = MARGIN + size + 12;
    }

    const wordmarkY = top + bandH - 26;
    this.page.drawText("PHOENIX", { x: textX, y: wordmarkY, size: 16, font: this.bold, color: P.orange500 });
    const phoenixW = this.bold.widthOfTextAtSize("PHOENIX", 16);
    this.page.drawText("Workforce", {
      x: textX + phoenixW + 7,
      y: wordmarkY,
      size: 16,
      font: this.bold,
      color: P.white,
    });
    this.page.drawText("Weekly / Monthly Plans", {
      x: textX,
      y: top + 9,
      size: 9,
      font: this.font,
      color: P.slate300,
    });

    // Right-aligned export subtitle inside the band.
    const sub = asciiSafe(this.subtitle);
    const subW = this.font.widthOfTextAtSize(sub, 8.5);
    this.page.drawText(sub, {
      x: PAGE_W - MARGIN - subW,
      y: top + bandH / 2 - 4,
      size: 8.5,
      font: this.font,
      color: P.slate400,
    });

    return top - 3 - 18;
  }

  text(value: string, x: number, y: number, opts: TextOptions) {
    this.page.drawText(asciiSafe(value), { x, y, size: opts.size, font: opts.font, color: opts.color });
  }

  private truncate(value: string, font: PDFFont, size: number, maxW: number) {
    const safe = asciiSafe(value);
    if (!safe) return "";
    if (font.widthOfTextAtSize(safe, size) <= maxW) return safe;
    let out = safe;
    while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxW) {
      out = out.slice(0, -1);
    }
    return `${out.trim()}...`;
  }

  private wrap(value: string, font: PDFFont, size: number, maxW: number): string[] {
    const safe = asciiSafe(value);
    if (!safe) return [];
    const words = safe.split(" ");
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxW || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  private ensure(height: number, redraw?: () => void) {
    if (this.y - height < BOTTOM) {
      this.newPage();
      redraw?.();
    }
  }

  drawPlanCard(plan: EmployeePlan, repOptions: PlanExportRepOption[] | undefined) {
    // Keep the meta band + column header + first day row together.
    this.ensure(24 + 18 + 22 + 26);
    this.drawPlanMeta(plan);
    this.drawColumnHeader();

    const items = planItems(plan);
    items.forEach((item, index) => {
      this.drawDayRow(item, index, repOptions);
    });

    this.y -= 14; // spacing between cards
  }

  private drawPlanMeta(plan: EmployeePlan) {
    // Band 1 — name + period
    const h1 = 24;
    this.page.drawRectangle({ x: MARGIN, y: this.y - h1, width: CONTENT_W, height: h1, color: P.slate900 });
    const nameY = this.y - 16;
    this.text(plan.employeeName, MARGIN + 10, nameY, { size: 11, font: this.bold, color: P.white });
    const nameW = this.bold.widthOfTextAtSize(asciiSafe(plan.employeeName), 11);
    this.text(`HR ${plan.employeeHrId}`, MARGIN + 10 + nameW + 8, nameY, {
      size: 9,
      font: this.font,
      color: P.slate300,
    });
    const period = `${plan.planKind === "weekly" ? "Weekly" : "Monthly"}  ·  ${plan.periodKey}`;
    const periodW = this.bold.widthOfTextAtSize(asciiSafe(period), 10);
    this.text(period, MARGIN + CONTENT_W - periodW - 10, nameY, {
      size: 10,
      font: this.bold,
      color: P.orange400,
    });
    this.y -= h1;

    // Band 2 — manager + status pill
    const h2 = 18;
    this.page.drawRectangle({ x: MARGIN, y: this.y - h2, width: CONTENT_W, height: h2, color: P.slate800 });
    const metaY = this.y - 12.5;
    this.text(
      `Manager: ${plan.managerName ?? "—"}    ·    Revision ${plan.revision}`,
      MARGIN + 10,
      metaY,
      { size: 9, font: this.font, color: P.slate300 },
    );
    this.drawPill(statusLabel(plan.status), statusToneKey(plan.status), MARGIN + CONTENT_W - 10, this.y - h2 / 2);
    this.y -= h2 + 2;
  }

  private drawPill(label: string, toneKey: StatusToneKey, rightX: number, centerY: number) {
    const tone = PDF_TONE[toneKey];
    const size = 8;
    const padX = 7;
    const safe = asciiSafe(label);
    const textW = this.bold.widthOfTextAtSize(safe, size);
    const pillW = textW + padX * 2;
    const pillH = 13;
    const x = rightX - pillW;
    this.page.drawRectangle({
      x,
      y: centerY - pillH / 2,
      width: pillW,
      height: pillH,
      color: tone.bg,
      borderColor: tone.text,
      borderWidth: 0.5,
    });
    this.page.drawText(safe, {
      x: x + padX,
      y: centerY - size / 2 + 0.5,
      size,
      font: this.bold,
      color: tone.text,
    });
  }

  private drawColumnHeader() {
    const h = 20;
    this.page.drawRectangle({ x: MARGIN, y: this.y - h, width: CONTENT_W, height: h, color: P.black });
    let cx = MARGIN;
    const dotY = this.y - h / 2 - 1.5;
    const labelY = this.y - 13;
    for (const col of PDF_COLS) {
      this.page.drawCircle({ x: cx + 9, y: dotY, size: 2, color: col.accent });
      this.page.drawText(col.label, {
        x: cx + 16,
        y: labelY,
        size: 8,
        font: this.bold,
        color: col.accent,
      });
      cx += col.width;
    }
    this.y -= h;
  }

  private drawDayRow(
    item: PlanItem,
    index: number,
    repOptions: PlanExportRepOption[] | undefined,
  ) {
    const rowH = 26;
    const hasReturn = item.returnNotes.length > 0;

    // Compute notes block height up front so we can page-break cleanly.
    const noteText = compactText(item.notes);
    const noteLines = noteText ? this.wrap(noteText, this.font, 8.5, CONTENT_W - 24) : [];
    const returnLines = item.returnNotes.flatMap((note) =>
      this.wrap(`Return — ${note.actorRole ?? "Reviewer"}: ${note.note}`, this.font, 8, CONTENT_W - 24),
    );
    const hasNotes = noteLines.length > 0 || returnLines.length > 0;
    const notesH = hasNotes ? 6 + noteLines.length * 11 + (returnLines.length > 0 ? returnLines.length * 10 + 4 : 0) : 0;

    this.ensure(rowH + notesH, () => this.drawColumnHeader());

    // Zebra / return-note fill
    if (hasReturn) {
      this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: CONTENT_W, height: rowH, color: hx("#FEFCE8") });
    } else if (index % 2 === 1) {
      this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: CONTENT_W, height: rowH, color: P.slate50 });
    }
    // Orange date spine
    this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: 2.5, height: rowH, color: P.orange400 });

    const cellTopY = this.y;
    // Date cell — day name + date stacked
    this.text(formatDayName(item.activityDate).toUpperCase(), MARGIN + 8, cellTopY - 11, {
      size: 7,
      font: this.bold,
      color: P.orange500,
    });
    this.text(formatDayDate(item.activityDate), MARGIN + 8, cellTopY - 21, {
      size: 9,
      font: this.bold,
      color: P.slate700,
    });

    let cx = MARGIN + PDF_COLS[0].width;
    const midY = cellTopY - 16;

    // Type
    this.text(this.truncate(item.activityType, this.font, 9, PDF_COLS[1].width - 12), cx + 6, midY, {
      size: 9,
      font: this.font,
      color: P.slate700,
    });
    cx += PDF_COLS[1].width;

    // Region
    this.text(this.truncate(compactText(item.locationText) || "—", this.font, 9, PDF_COLS[2].width - 12), cx + 6, midY, {
      size: 9,
      font: this.font,
      color: compactText(item.locationText) ? P.slate700 : P.slate400,
    });
    cx += PDF_COLS[2].width;

    // Area
    this.text(this.truncate(compactText(item.area) || "—", this.font, 9, PDF_COLS[3].width - 12), cx + 6, midY, {
      size: 9,
      font: this.font,
      color: compactText(item.area) ? P.slate700 : P.slate400,
    });
    cx += PDF_COLS[3].width;

    // Medical Rep — violet chip for Double Visit, plain text otherwise
    const repName = medicalRepDisplay(item, repOptions);
    if (item.activityType === "Double Visit" && repName) {
      const chipLabel = this.truncate(repName, this.bold, 8, PDF_COLS[4].width - 16);
      const chipW = Math.min(PDF_COLS[4].width - 8, this.bold.widthOfTextAtSize(chipLabel, 8) + 12);
      this.page.drawRectangle({
        x: cx + 6,
        y: cellTopY - rowH / 2 - 7,
        width: chipW,
        height: 14,
        color: P.violet50,
        borderColor: P.violet200,
        borderWidth: 0.5,
      });
      this.text(chipLabel, cx + 12, cellTopY - rowH / 2 - 2.5, { size: 8, font: this.bold, color: P.violet700 });
    } else {
      this.text(this.truncate(repName || "—", this.font, 9, PDF_COLS[4].width - 12), cx + 6, midY, {
        size: 9,
        font: this.font,
        color: repName ? P.slate700 : P.slate400,
      });
    }

    // Bottom hairline
    this.page.drawLine({
      start: { x: MARGIN, y: this.y - rowH },
      end: { x: MARGIN + CONTENT_W, y: this.y - rowH },
      thickness: 0.5,
      color: P.slate200,
    });
    this.y -= rowH;

    // --- Notes strip (orange-tinted, mirrors the on-screen day note) ---------
    if (hasNotes) {
      this.page.drawRectangle({ x: MARGIN, y: this.y - notesH, width: CONTENT_W, height: notesH, color: P.orange50 });
      this.page.drawRectangle({ x: MARGIN, y: this.y - notesH, width: 2.5, height: notesH, color: P.orange100 });
      let ny = this.y - 12;
      for (const line of noteLines) {
        this.text(line, MARGIN + 10, ny, { size: 8.5, font: this.font, color: P.slate700 });
        ny -= 11;
      }
      if (returnLines.length > 0) {
        ny -= 2;
        for (const line of returnLines) {
          this.text(line, MARGIN + 10, ny, { size: 8, font: this.font, color: P.amber700 });
          ny -= 10;
        }
      }
      this.y -= notesH;
    }
  }

  finalize() {
    const total = this.doc.getPageCount();
    this.doc.getPages().forEach((page, index) => {
      const label = `Phoenix Workforce  ·  Weekly / Monthly Plans`;
      page.drawText(label, { x: MARGIN, y: MARGIN - 6, size: 7.5, font: this.font, color: P.slate400 });
      const pageLabel = `Page ${index + 1} of ${total}`;
      const w = this.font.widthOfTextAtSize(pageLabel, 7.5);
      page.drawText(pageLabel, { x: PAGE_W - MARGIN - w, y: MARGIN - 6, size: 7.5, font: this.font, color: P.slate400 });
    });
  }
}
