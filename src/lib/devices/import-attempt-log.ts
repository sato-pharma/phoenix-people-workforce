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
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrIdForStorage } from "@/lib/hr-id";

/**
 * WHO pressed an import button, as every import press records it — the check, the import, the two
 * Action1 presses and a press refused at the gate.
 *
 * ONE EXPRESSION, because the two dry runs and the gate log each said "the same canonicalisation as
 * the confirm route" while leaving out `resolveEmployeeIdentityId`. A caller with no HR id was then
 * filed under his raw login on the check and under his normalised id on the import — one person, two
 * actors, which is the exact ambiguity this log exists to remove.
 */
export function importActor(access: {
  hrId?: string | null;
  loginId?: string | null;
  role?: string | null;
}): string {
  return (
    hrIdForStorage(access.hrId) ??
    resolveEmployeeIdentityId({ hrId: access.hrId ?? null, loginId: access.loginId ?? null }) ??
    access.loginId ??
    String(access.role ?? "")
  );
}

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
 * Outcomes that happen ABOVE the permission gate, so no file was ever read.
 *
 * They are the blind spot the first version of this log deliberately left: everything below the
 * gate is recorded, and a request refused by the gate itself produced the same silence as a request
 * that never arrived. Closing it is the point of `recordDeviceImportGateRejection` below.
 */
const GATE_OUTCOMES = new Set(["forbidden", "same_origin_rejected"]);

/**
 * How often one caller may add a gate-rejection row.
 *
 * A rejection is logged from a path any caller can reach by POSTing at the route, so without a
 * limit the diagnostic becomes a way of filling `audit_logs`. Thirty seconds per caller per outcome
 * keeps a real person's repeated presses visible - they do not press twice a second - while making
 * a flood pointless.
 */
const REJECTION_MIN_INTERVAL_MS = 30_000;
const REJECTION_KEYS_MAX = 500;
const rejectionSeenAt = new Map<string, number>();

/**
 * Pure, so the limiter is testable without a clock or a database. Returns whether this key may
 * write now, and records the decision when it may.
 */
export function shouldLogGateRejection(key: string, now: number): boolean {
  const last = rejectionSeenAt.get(key);
  if (typeof last === "number" && now - last < REJECTION_MIN_INTERVAL_MS) return false;

  // Bounded: the key space is caller-controlled, so an unbounded map would be the leak the rate
  // limit exists to prevent, one level down. Oldest first, which is also least recently useful.
  if (rejectionSeenAt.size >= REJECTION_KEYS_MAX) {
    const oldest = [...rejectionSeenAt.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) rejectionSeenAt.delete(oldest[0]);
  }
  rejectionSeenAt.set(key, now);
  return true;
}

/**
 * The limiter's key. Extracted so the composition is testable: keying on the outcome alone would
 * let one refused caller silence everybody else's rows, and that mistake is invisible at the call
 * site because the limiter still "works".
 */
export function gateRejectionKey(
  actor: string,
  stage: DeviceImportStage,
  outcome: string,
): string {
  return `${actor}:${stage}:${outcome}`;
}

/** Test seam: the limiter holds process-level state, and a test must not inherit another's. */
export function resetGateRejectionLimiterForTests(): void {
  rejectionSeenAt.clear();
}

/**
 * The sentence that appears in the audit list. Pure, so the wording is testable without a database.
 *
 * It says what was WRITTEN, never merely what was attempted — an import that refused every row must
 * not read like one that worked, which is the same rule the screen banner follows.
 */
export function describeDeviceImportAttempt(attempt: DeviceImportAttempt): string {
  const file = attempt.fileName ? `"${attempt.fileName}"` : "an unnamed file";

  if (GATE_OUTCOMES.has(attempt.outcome)) {
    // A gate rejection is a different sentence from a refused FILE, because the reader's next
    // question is different: not "what is wrong with my sheet" but "why was I not allowed to try".
    const gate =
      attempt.outcome === "forbidden" ? "the permission check" : "the same-origin check";
    return (
      `Device import blocked before it started - refused by ${gate} (${attempt.outcome}). ` +
      "No file was read and nothing reached the register."
    );
  }

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

/**
 * Records a request that never got past the gate.
 *
 * TWO GUARDS, and they are the whole reason this is a separate function rather than another call to
 * the one above:
 *
 * 1. AN UNAUTHENTICATED CALLER WRITES NOTHING. `resolveAccessContext` answers with a guest context
 *    rather than throwing, so "no session" is a value here, not an error - and a guest is dropped
 *    before any write. Filling a table is not evidence.
 * 2. A REAL CALLER IS RATE-LIMITED per outcome. A person pressing a button that keeps being refused
 *    produces one row every thirty seconds, which is enough to see the pattern and not enough to
 *    bury the rest of the log.
 *
 * Failure here is swallowed on purpose: this runs on a path that is already returning an error to
 * the caller, and a diagnostic that turns a 403 into a 500 would be worse than the gap it fills.
 */
export async function recordDeviceImportGateRejection(
  request: Request,
  stage: DeviceImportStage,
  outcome: "forbidden" | "same_origin_rejected",
): Promise<void> {
  try {
    const access = await resolveAccessContext(request);
    if (!access || access.source === "guest") return;

    const actor = importActor(access);
    if (!shouldLogGateRejection(gateRejectionKey(actor, stage, outcome), Date.now())) return;

    await recordDeviceImportAttempt({
      stage,
      actor,
      fileName: null,
      fileBytes: null,
      rowsRead: null,
      outcome,
    });
  } catch {
    // Deliberately silent. See the note above.
  }
}
