/**
 * A record that somebody tried to import devices — whatever came of it.
 *
 * WHY THIS EXISTS. The register writes an audit row when a device is registered, and nothing at all
 * when an import fails. So on 2026-09-08, three times, the owner said he had uploaded the first
 * tablet and the register was empty, and from the database side "he pressed Import and every row
 * was refused" and "the press never reached the server" were indistinguishable — both are zero rows
 * and zero audit rows. The whole evening was spent unable to answer a question the system should
 * have answered for itself.
 *
 * So an attempt is now its own fact, separate from its result. One row per press, success or not,
 * carrying what the file was, how many rows were read, and what happened to them.
 *
 * IT IS DELIBERATELY BEST-EFFORT (`writeAuditLog`, not `writeRequiredAuditLog`). A diagnostic that
 * can fail an import it was only supposed to observe would be worse than the blindness it fixes.
 *
 * IT IS ALSO WRITTEN ONLY AFTER THE PERMISSION CHECK PASSES. Logging earlier would let an
 * unauthenticated caller write audit rows by POSTing to the route, which is a way of filling a
 * table, not a way of learning anything.
 */
import { writeAuditLog } from "@/lib/admin/audit";

/** Which of the two presses this was. `check` writes nothing to the register; `import` does. */
export type DeviceImportStage = "check" | "import";

export type DeviceImportAttempt = {
  stage: DeviceImportStage;
  actor: string | null;
  /** The uploaded file's name, so a repeated attempt with the same sheet is recognisable. */
  fileName: string | null;
  fileBytes: number | null;
  /** Rows the parser found. `null` means the file never got as far as being parsed. */
  rowsRead: number | null;
  /**
   * What became of the attempt. `ok` means it ran; anything else is the refusal code the caller
   * was given, so the audit row and the message on screen name the same thing.
   */
  outcome: string;
  ready?: number | null;
  withProblems?: number | null;
  imported?: number | null;
  issued?: number | null;
  skipped?: number | null;
  failed?: number | null;
};

const count = (value: number | null | undefined): string =>
  typeof value === "number" ? value.toLocaleString("en-US") : "?";

/**
 * The sentence that appears in the audit list. Pure, so the wording is testable without a database.
 *
 * It says what was WRITTEN, never merely what was attempted — an import that refused every row must
 * not read like one that worked, which is the same rule the screen banner follows.
 */
export function describeDeviceImportAttempt(attempt: DeviceImportAttempt): string {
  const file = attempt.fileName ? `"${attempt.fileName}"` : "an unnamed file";

  if (attempt.outcome !== "ok") {
    return attempt.stage === "check"
      ? `Device import check refused before any row was read — ${file} (${attempt.outcome}). Nothing was written.`
      : `Device import refused before any row was written — ${file} (${attempt.outcome}). The register is unchanged.`;
  }

  if (attempt.stage === "check") {
    return (
      `Device import file checked — ${file}: ${count(attempt.rowsRead)} row(s) read, ` +
      `${count(attempt.ready)} ready, ${count(attempt.withProblems)} with problems. ` +
      "Nothing was written — this is the check, not the import."
    );
  }

  const wrote = typeof attempt.imported === "number" && attempt.imported > 0;
  return (
    `Device import run — ${file}: ${count(attempt.rowsRead)} row(s) read, ` +
    `${count(attempt.imported)} imported, ${count(attempt.issued)} handed over, ` +
    `${count(attempt.skipped)} skipped, ${count(attempt.failed)} failed. ` +
    (wrote ? "The register changed." : "Nothing was written — the register is unchanged.")
  );
}

/** The audit row itself. Split out from the write so the shape can be asserted in a test. */
export function buildDeviceImportAuditInput(attempt: DeviceImportAttempt) {
  return {
    actorLoginId: attempt.actor,
    entityType: "device_import" as const,
    // The file name, so the audit list shows WHICH sheet was tried rather than only that one was.
    entityId: attempt.fileName,
    summary: describeDeviceImportAttempt(attempt),
    newValues: {
      stage: attempt.stage,
      outcome: attempt.outcome,
      fileBytes: attempt.fileBytes ?? null,
      rowsRead: attempt.rowsRead ?? null,
      ready: attempt.ready ?? null,
      withProblems: attempt.withProblems ?? null,
      imported: attempt.imported ?? null,
      issued: attempt.issued ?? null,
      skipped: attempt.skipped ?? null,
      failed: attempt.failed ?? null,
    },
  };
}

export async function recordDeviceImportAttempt(attempt: DeviceImportAttempt): Promise<void> {
  await writeAuditLog(buildDeviceImportAuditInput(attempt));
}
