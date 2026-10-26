// ── Several raw sheets of one distributor on the Source Normalizer ───────────────────────────────
//
// The owner, 2026-10-26: "also in normalizer make me bulk upload" — after Sales Upload took several
// sheets of one distributor at once (sales-upload-files.ts). A distributor that sends its month as
// five or six files (one per branch, one per warehouse) used to need one Analyze → map → Import per
// file on the Normalizer, and each import filed its own batch for the month.
//
// So the sheets are recognized one by one and their parts are COMBINED before anything is shown:
//   • parts of the same distributor and the same month become ONE part — mapped once, imported as
//     one batch;
//   • a distributor's sheets of different months stay one part per month, as one sheet of each
//     month would;
//   • the same sheet chosen twice is refused (a double count is one of the two things that block).
//
// Every row keeps saying which file it came from: its row number is shifted into that file's block
// (encodeFileRow), and the routes turn it back into "<file> row <n>" before anyone reads it.

import { createHash } from "node:crypto";

import { SalesWorkflowError } from "@/lib/sales/contracts";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { recognitionErrorMessage, recognizeWorkbookParts, type NormalizePart, type NormalizePartsResult, type RecognizeOptions } from "@/lib/sales/recognize";
import { MAX_UPLOAD_FILES, findRepeatedSheet, mergeNormalizeResults, type UploadFileFingerprint } from "@/lib/sales/sales-upload-files";

/** One distributor-and-month of the chosen sheets, and which sheets it was read from. */
export type FilesPart = NormalizePart & { fileNames: string[] };

type RecognizedOk = Extract<NormalizePartsResult, { status: "ok" }>;

export type RecognizedFiles =
  | (Omit<RecognizedOk, "parts"> & { parts: FilesPart[]; fileNames: string[] })
  | Exclude<NormalizePartsResult, { status: "ok" }>;

/** Every file the form carries under "file", in the order they were chosen. */
export function formFiles(form: FormData): File[] {
  return form.getAll("file").filter((value): value is File => value instanceof File);
}

/**
 * The month picked on screen for a sheet with no date ("YYYY-MM"), or null when none was picked.
 *
 * Only a well-formed month is taken: anything else is refused in words, never read as "no month",
 * because a typo would otherwise drop back to the sheet's own (missing) date and refuse the sheet
 * for a reason the person did not cause.
 */
export function formUndatedPeriod(form: FormData): string | null {
  const raw = String(form.get("undatedPeriod") ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    throw new SalesWorkflowError("bad_undated_period", `"${raw}" is not a month — pick it as year and month (for example 2024-07).`, 400);
  }
  return raw;
}

/**
 * The parts of several recognized sheets, combined by distributor and month.
 *
 * A part's month is its own dominant month, exactly as one sheet's batch month is today. Two sheets
 * of one distributor and one month become one part with every row of both; nothing is dropped or
 * deduplicated here (the strict validator still checks the combined rows for duplicates). With one
 * sheet the parts come back as they are.
 */
export function groupFileParts(files: readonly { fileName: string; parts: readonly NormalizePart[] }[]): FilesPart[] {
  if (files.length === 1) return files[0].parts.map((part) => ({ ...part, fileNames: [files[0].fileName] }));
  const groups = new Map<string, { first: NormalizePart; members: { fileIndex: number; result: NormalizePart["result"] }[]; fileNames: string[] }>();
  files.forEach((file, fileIndex) => {
    for (const part of file.parts) {
      const key = `${normalizeCodeKey(part.distributorCode)}|${part.period ?? ""}`;
      const group = groups.get(key) ?? { first: part, members: [], fileNames: [] };
      group.members.push({ fileIndex, result: part.result });
      if (!group.fileNames.includes(file.fileName)) group.fileNames.push(file.fileName);
      groups.set(key, group);
    }
  });
  return [...groups.values()].map(({ first, members, fileNames }) => ({
    distributorCode: first.distributorCode,
    distributorName: first.distributorName,
    period: first.period,
    result: mergeNormalizeResults(first.distributorCode, members),
    fileNames,
  }));
}

/** The figures one sheet is fingerprinted by, for the same-sheet-twice refusal. */
async function fingerprintFile(file: File, parts: readonly NormalizePart[]): Promise<UploadFileFingerprint> {
  const digest = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  const coded = parts.flatMap((part) => part.result.coded);
  const qty = coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const value = coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
  return { fileName: file.name, digest, rows: coded.length, qty: Number(qty.toFixed(6)), value: Number(value.toFixed(6)) };
}

/**
 * Recognize every chosen sheet, one workbook in memory at a time, and combine their parts.
 *
 * One sheet answers exactly as recognizeWorkbookParts does. With several, a sheet that cannot be read
 * refuses the whole selection, named ("branch-2.xlsx": …), so the person knows which file to take out.
 */
export async function recognizeWorkbookFiles(distributorCode: string, files: readonly File[], options?: RecognizeOptions): Promise<RecognizedFiles> {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new SalesWorkflowError("too_many_files", `Choose at most ${MAX_UPLOAD_FILES} files at a time (${files.length} were chosen).`, 400);
  }
  const recognized: { fileName: string; rec: RecognizedOk }[] = [];
  const fingerprints: UploadFileFingerprint[] = [];
  for (const file of files) {
    const rec = await recognizeWorkbookParts(distributorCode, file, options);
    if (rec.status !== "ok") {
      // A sheet refused only for its missing date can still go in under a month picked on screen.
      const dateOnly = rec.status === "header_error" && rec.missingGroups.length > 0 && rec.missingGroups.every((g) => g.label === "Date");
      const hint = dateOnly ? ` If this sheet carries no date at all, pick its month under "Month of a sheet with no date" and analyze it again.` : "";
      if (files.length === 1 && !hint) return rec;
      const prefix = files.length === 1 ? "" : `"${file.name}": `;
      return { status: "template_error", distributorName: rec.distributorName, message: `${prefix}${recognitionErrorMessage(rec)}${hint}` };
    }
    recognized.push({ fileName: file.name, rec });
    fingerprints.push(await fingerprintFile(file, rec.parts));
  }
  // The picked month is ONE month, so it may stand in for the date of one sheet only: two date-less
  // sheets under it would be filed as one month whether or not they are. Each goes in on its own.
  const undated = recognized.filter((r) => r.rec.monthPicked).map((r) => r.fileName);
  if (undated.length > 1) {
    throw new SalesWorkflowError(
      "several_undated_sheets",
      `${undated.map((name) => `"${name}"`).join(", ")} carry no date, and the month you picked can stand in for one sheet only. Analyze each of them on its own, with its own month.`,
      422,
    );
  }
  const repeated = findRepeatedSheet(fingerprints);
  if (repeated) throw new SalesWorkflowError("repeated_sales_sheet", repeated, 422);

  const [first] = recognized;
  return {
    ...first.rec,
    parts: groupFileParts(recognized.map(({ fileName, rec }) => ({ fileName, parts: rec.parts }))),
    fileNames: recognized.map((r) => r.fileName),
    // The facts the validator reads must hold for EVERY sheet: a date column only when each has one.
    hasDateColumn: recognized.every((r) => r.rec.hasDateColumn),
    regionOnly: recognized.some((r) => r.rec.regionOnly),
  };
}

/**
 * How a part is named in a message: its distributor, and its month when the same distributor has
 * more than one part. Empty when there is only one part (the message needs no prefix then).
 */
export function partLabel(part: Pick<FilesPart, "distributorCode" | "distributorName" | "period">, parts: readonly Pick<FilesPart, "distributorCode">[]): string {
  if (parts.length < 2) return "";
  const sameDistributor = parts.filter((p) => normalizeCodeKey(p.distributorCode) === normalizeCodeKey(part.distributorCode)).length;
  return sameDistributor > 1 ? `${part.distributorName} ${part.period ?? "no month"}` : part.distributorName;
}
