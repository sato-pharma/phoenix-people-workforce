import {
  excelCellText,
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

import { stepDefinition } from "../step-definitions.ts";
import type {
  StepEditInput,
  StepImportDiff,
  StepImportPreview,
  StepKey,
  StepRow,
} from "../types.ts";

/**
 * Parses a re-uploaded per-step xlsx back into StepEditInput[], then diffs it
 * against the current recommendation for a dry-run preview (mirrors the targets
 * upload preview/commit flow). Matches columns by header name; tolerant of the
 * brand band above the header row.
 */

function findHeaderRowNumber(worksheet: ReturnType<typeof firstExcelWorksheet>): number {
  if (!worksheet) return 1;
  const scanTo = Math.min(worksheet.rowCount, 12);
  for (let rowNumber = 1; rowNumber <= scanTo; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    for (let col = 1; col <= worksheet.columnCount; col += 1) {
      const text = excelCellText(row.getCell(col).value).toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (text === "hrid") return rowNumber;
    }
  }
  return 1;
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function pickCell(row: Record<string, unknown>, label: string): unknown {
  const want = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase().replace(/[^a-z0-9]+/g, "") === want) return value;
  }
  return undefined;
}

export async function parseStepWorkbook(input: {
  file: File;
  stepKey: StepKey;
}): Promise<{ edits: StepEditInput[]; invalidHrIds: number }> {
  const guard = validateSpreadsheetFile(input.file, xlsxSpreadsheetValidation);
  if (!guard.ok) {
    throw new Error(`Validation: ${guard.message}`);
  }

  const workbook = await loadExcelWorkbook(await input.file.arrayBuffer());
  const worksheet = firstExcelWorksheet(workbook);
  if (!worksheet) throw new Error("Validation: the uploaded workbook has no readable sheet.");

  const headerRowNumber = findHeaderRowNumber(worksheet);
  const jsonRows = excelWorksheetToJsonRows(worksheet, headerRowNumber);
  const definition = stepDefinition(input.stepKey);

  const edits: StepEditInput[] = [];
  let invalidHrIds = 0;

  for (const jsonRow of jsonRows) {
    const hrId = String(pickCell(jsonRow, "HR_ID") ?? "").trim();
    if (!hrId) {
      invalidHrIds += 1;
      continue;
    }
    const edit: StepEditInput = { hrId, values: {} };
    if (definition.isHoldStep) {
      const hold = String(pickCell(jsonRow, "Hold?") ?? "").trim().toLowerCase();
      edit.onHold = hold === "yes" || hold === "y" || hold === "true" || hold === "1";
      edit.reason = String(pickCell(jsonRow, "Hold Reason") ?? "").trim() || null;
    } else {
      for (const field of definition.fields) {
        if (field.kind === "text") {
          const raw = String(pickCell(jsonRow, field.label) ?? "").trim();
          if (raw) {
            edit.reasons = edit.reasons ?? {};
            edit.reasons[field.key] = raw;
          }
          continue;
        }
        if (field.kind === "select") {
          const raw = String(pickCell(jsonRow, field.label) ?? "").trim();
          if (raw) {
            edit.selects = edit.selects ?? {};
            edit.selects[field.key] = raw;
          }
          continue;
        }
        const value = readNumber(pickCell(jsonRow, field.label));
        if (value != null) edit.values![field.key] = value;
      }
      if (definition.hasReason) {
        edit.reason = String(pickCell(jsonRow, "Reason") ?? "").trim() || null;
      }
    }
    edits.push(edit);
  }

  return { edits, invalidHrIds };
}

/** Dry-run diff of uploaded edits vs the current recommendation rows. */
export function diffStepUpload(input: {
  stepKey: StepKey;
  edits: StepEditInput[];
  current: StepRow[];
  invalidHrIds: number;
}): StepImportPreview {
  const definition = stepDefinition(input.stepKey);
  const currentByHr = new Map(input.current.map((row) => [row.hrId.toLowerCase(), row]));
  const diffs: StepImportDiff[] = [];
  let changed = 0;
  let invalid = input.invalidHrIds;

  for (const edit of input.edits) {
    const current = currentByHr.get(edit.hrId.toLowerCase());
    if (!current) {
      invalid += 1;
      diffs.push({
        hrId: edit.hrId,
        fullName: "—",
        field: "HR_ID",
        from: null,
        to: edit.hrId,
        status: "invalid",
        message: "HR ID is not in this month's payroll population.",
      });
      continue;
    }

    if (definition.isHoldStep) {
      const wasHeld = current.onHold;
      const nowHeld = Boolean(edit.onHold);
      const status = wasHeld === nowHeld ? "unchanged" : "changed";
      if (status === "changed") changed += 1;
      diffs.push({
        hrId: edit.hrId,
        fullName: current.fullName,
        field: "Hold?",
        from: wasHeld ? "Yes" : "No",
        to: nowHeld ? "Yes" : "No",
        status,
      });
      continue;
    }

    for (const field of definition.fields) {
      if (field.kind === "text" || field.kind === "select") {
        const to = field.kind === "text" ? edit.reasons?.[field.key] : edit.selects?.[field.key];
        if (to === undefined) continue;
        const from = (field.kind === "text" ? current.reasons?.[field.key] : current.selects?.[field.key]) ?? "";
        const status = from === to ? "unchanged" : "changed";
        if (status === "changed") changed += 1;
        diffs.push({ hrId: edit.hrId, fullName: current.fullName, field: field.label, from, to, status });
        continue;
      }
      const to = edit.values?.[field.key];
      if (to === undefined) continue;
      const from = current.values[field.key] ?? 0;
      const status = Math.round(from * 100) === Math.round(to * 100) ? "unchanged" : "changed";
      if (status === "changed") changed += 1;
      diffs.push({ hrId: edit.hrId, fullName: current.fullName, field: field.label, from, to, status });
    }
  }

  return {
    mode: "preview",
    totalRows: input.edits.length,
    changed,
    invalid,
    diffs,
  };
}
