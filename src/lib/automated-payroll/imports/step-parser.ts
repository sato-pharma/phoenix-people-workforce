import {
  excelCellText,
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

import { stepDefinition } from "../step-definitions.ts";
import { readStepFileRevision } from "./step-file-revision.ts";
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
}): Promise<{
  edits: StepEditInput[];
  invalidHrIds: number;
  /** The step revision the file was built from (see step-file-revision.ts); undefined when it carries none. */
  revision: string | null | undefined;
}> {
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
      // An ABSENT "Hold?" column keeps every hold as it stands (payroll audit 2026-11-14, finding 5;
      // owner: "Keep current holds"). It used to read as "No" for everyone, so a sheet rebuilt without
      // that column lifted every hold of the month. Only a column that is on the sheet can change a
      // hold; `undefined` reaches saveStep as "not supplied", and saveStep keeps the stored value.
      // The same for "Hold Reason", as the other steps' Reason already works (audit finding 48).
      const holdCell = pickCell(jsonRow, "Hold?");
      if (holdCell !== undefined) {
        const hold = String(holdCell ?? "").trim().toLowerCase();
        edit.onHold = hold === "yes" || hold === "y" || hold === "true" || hold === "1";
      }
      const holdReasonCell = pickCell(jsonRow, "Hold Reason");
      if (holdReasonCell !== undefined) edit.reason = String(holdReasonCell ?? "").trim() || null;
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
        // A field with nowhere to be saved is never read back (audit finding 31). It used to be, so
        // the preview printed "2 to 6 (changed)" for a day count the commit then silently dropped.
        // The template now ships it read-only; this is the other half of the same rule.
        if (field.notPersisted) continue;
        const value = readNumber(pickCell(jsonRow, field.label));
        if (value != null) edit.values![field.key] = value;
      }
      if (definition.hasReason) {
        // An ABSENT Reason column means "not supplied", never "blank" (audit finding 48). The reason
        // used to be written unconditionally, so re-uploading a sheet rebuilt without that column
        // blanked the justification on every row while the preview reported nothing changed.
        // `excelWorksheetToJsonRows` gives every row every header key, with "" for an empty cell, so
        // `undefined` here can only mean the column is not on the sheet at all.
        const reasonCell = pickCell(jsonRow, "Reason");
        if (reasonCell !== undefined) edit.reason = String(reasonCell ?? "").trim() || null;
      }
    }
    edits.push(edit);
  }

  return { edits, invalidHrIds, revision: readStepFileRevision(workbook.keywords) };
}

/** Dry-run diff of uploaded edits vs the current recommendation rows. */
export function diffStepUpload(input: {
  stepKey: StepKey;
  edits: StepEditInput[];
  current: StepRow[];
  invalidHrIds: number;
  /**
   * Money fields the server will RECALCULATE from a corrected day count rather than take from the
   * sheet, keyed by lower-cased HR id (see `applyDayDrivenMoney`). Shown as changed, because they
   * will be, even though the sheet still carries the old figure.
   */
  recalculated?: Map<string, string[]>;
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
      // No "Hold?" column: the hold stays as it is, and the preview says nothing about it.
      const nowHeld = edit.onHold === undefined ? wasHeld : Boolean(edit.onHold);
      if (edit.onHold !== undefined) {
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
      }

      // The REASON is a column on this sheet too, and the preview used to be
      // silent about it — so an upload that emptied "Hold Reason" while leaving
      // "Hold?" on reported "unchanged" and then wiped the one record of why the
      // person was not paid. The save now refuses that outright; showing it here
      // means the reviewer sees the change before it is attempted, rather than
      // meeting it as an error.
      const reasonFrom = (current.reason ?? "").trim();
      const reasonTo = edit.reason === undefined ? reasonFrom : (edit.reason ?? "").trim();
      if (reasonFrom !== reasonTo) {
        changed += 1;
        diffs.push({
          hrId: edit.hrId,
          fullName: current.fullName,
          field: "Hold Reason",
          from: reasonFrom,
          to: reasonTo,
          status: "changed",
          message: nowHeld && !reasonTo ? "A hold cannot be saved without a reason." : undefined,
        });
      }
      continue;
    }

    const recalculatedKeys = input.recalculated?.get(edit.hrId.toLowerCase()) ?? [];
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
      if (to === undefined) {
        if (recalculatedKeys.includes(field.key)) {
          changed += 1;
          diffs.push({
            hrId: edit.hrId,
            fullName: current.fullName,
            field: field.label,
            from: current.values[field.key] ?? 0,
            to: "recalculated",
            status: "changed",
            message: "Recalculated from the corrected day count by the settlement rule when this is saved.",
          });
        }
        continue;
      }
      const from = current.values[field.key] ?? 0;
      const status = Math.round(from * 100) === Math.round(to * 100) ? "unchanged" : "changed";
      if (status === "changed") changed += 1;
      diffs.push({ hrId: edit.hrId, fullName: current.fullName, field: field.label, from, to, status });
    }

    // The step's Reason is compared too (audit finding 48), the same way the hold steps compare
    // theirs: a sheet that blanks it must say so in the preview, not only erase it on commit. An
    // absent column leaves `edit.reason` undefined, which is "not supplied" and shows nothing.
    if (definition.hasReason && edit.reason !== undefined) {
      const reasonFrom = (current.reason ?? "").trim();
      const reasonTo = (edit.reason ?? "").trim();
      const status = reasonFrom === reasonTo ? "unchanged" : "changed";
      if (status === "changed") changed += 1;
      diffs.push({ hrId: edit.hrId, fullName: current.fullName, field: "Reason", from: reasonFrom, to: reasonTo, status });
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
