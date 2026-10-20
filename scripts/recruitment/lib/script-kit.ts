// =============================================================================
// The shared safety rails of the recruitment one-off scripts (owner, 2026-10-20 rebuild).
// =============================================================================
// Every one of them:
//   * runs as a DRY RUN unless `--apply` is passed, and an apply needs `--confirm-production=<N>`
//     where N is the plan size the dry run just printed — a stale plan is refused, never trusted;
//   * refuses to run against anything but the production project (the data it repairs lives there);
//   * writes an XLSX PRE-IMAGE into `xlsx/` on every run — who changes, from what, to what and why —
//     before a single row is touched, so the change can be read before it is applied and undone after.
//
// A library, never an entry point: it reads no `process.argv` of its own (scripts/lib/refuse-arguments.mjs).
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import ExcelJS from "exceljs";

export const PRODUCTION_SUPABASE_REF = "ozucdzovmcqvepbozvqf";

export type ScriptMode = "dry-run" | "apply";

export type ScriptOptions = { mode: ScriptMode; confirm: string | null };

export function parseScriptOptions(argv: readonly string[]): ScriptOptions {
  const hasApply = argv.includes("--apply");
  const hasDryRun = argv.includes("--dry-run");
  if (hasApply && hasDryRun) throw new Error("Choose either --dry-run or --apply, not both.");
  const confirm = argv.find((arg) => arg.startsWith("--confirm-production="))?.slice("--confirm-production=".length).trim() ?? null;
  return { confirm: confirm || null, mode: hasApply ? "apply" : "dry-run" };
}

/** Refuses unless NEXT_PUBLIC_SUPABASE_URL is the production project. */
export function assertProductionTarget(): void {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }
  if (!host.startsWith(`${PRODUCTION_SUPABASE_REF}.`)) {
    throw new Error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL points to ${host}, not production ref ${PRODUCTION_SUPABASE_REF}.`);
  }
}

/** An apply must name the plan size THIS run found. */
export function assertConfirmed(options: ScriptOptions, planSize: number): void {
  if (options.confirm !== String(planSize)) {
    throw new Error(
      `Apply requires --confirm-production=${planSize} (the plan size from THIS run, not an earlier one). ` +
        "Re-run the dry run immediately before applying.",
    );
  }
}

/** Today in Cairo, YYYY-MM-DD — never `toISOString()`. */
export function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** A timestamp in Cairo, for a cell a person reads. */
export function cairoTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(at);
}

function nextFreePath(stem: string, mode: ScriptMode): string {
  mkdirSync(resolve("xlsx"), { recursive: true });
  const base = resolve("xlsx", `${stem}-${mode}-${cairoToday()}`);
  if (!existsSync(`${base}.xlsx`)) return `${base}.xlsx`;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Too many ${stem} workbooks written today; move the older ones out of xlsx/ first.`);
}

export type PreImageSheet = {
  name: string;
  columns: { header: string; key: string; width?: number }[];
  rows: Record<string, string | number | null>[];
};

/** Writes the pre-image workbook into `xlsx/` and returns its path. Written BEFORE any change. */
export async function writePreImage(stem: string, mode: ScriptMode, sheets: readonly PreImageSheet[]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31));
    worksheet.columns = sheet.columns.map((column) => ({ header: column.header, key: column.key, width: column.width ?? 22 }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of sheet.rows) worksheet.addRow(row);
    worksheet.eachRow((row) => {
      row.alignment = { vertical: "top", wrapText: true };
    });
  }
  const path = nextFreePath(stem, mode);
  await workbook.xlsx.writeFile(path);
  return path;
}

export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}
