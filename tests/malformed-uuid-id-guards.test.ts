import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { toApiError } from "../src/lib/http/api-errors.ts";
import { isUuid } from "../src/lib/http/uuid.ts";
import { getHiringDocumentFileForDownload } from "../src/lib/hiring-documents/service.ts";
import { getMarketingRequestDetail } from "../src/lib/marketing-requests/service.ts";
import { getCaseAssessments } from "../src/lib/probation/intelligence/assessments.ts";
import { getCaseScore } from "../src/lib/probation/intelligence/scoring-service.ts";
import { listManagerEngagementCandidateFiles } from "../src/lib/recruitment/manager-cv-engagement.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A path segment that cannot be an id answers 404, never 500.
//
// `/api/marketing-requests/report-share-links` was a live 500 on production. There is no such
// route, so Next.js matched it against the `[id]` segment next door, and the handler passed
// "report-share-links" to `.eq("id", …)` on a uuid column. Postgres does not answer that with no
// rows — it raises 22P02 from the WHERE clause before any row is considered, which reaches the
// route as a PostgrestError and is correctly classified as infrastructure, i.e. a 500.
//
// So the caller who mistyped a link is told the system is broken rather than that their link is
// wrong. And on a route that builds its own error response from `error.message` rather than
// going through toApiError, 5 of the 18 handed back the raw Postgres sentence naming the column
// type — the leak toApiError's redaction exists to prevent.
//
// This does NOT pollute `app_error_events`, though it reads like it should: that table is written
// by the CLIENT error reporter, and a server-side API 500 never reaches it. Measured on
// production 2026-09-05 — four deliberate 500s wrote no row while the table was live. Recorded
// so the claim is not made again on the strength of how plausible it sounds.
//
// A sweep of all 95 dynamic GET routes found 18 sharing the shape, so these guards are spread
// across six domains. The fix is deliberately NOT in toApiError: 22P02 is raised by a malformed
// integer or date just as readily as by a uuid, and a malformed value in a request BODY is a 400,
// not a 404 — only the caller knows it is holding an identifier it was asked to look up. The last
// section here pins that, so nobody "simplifies" this by teaching toApiError to guess.
// ─────────────────────────────────────────────────────────────────────────────

/** Files carrying a guard. Each covers at least one route that returned 500 before this change. */
const GUARDED_SOURCES = [
  "src/lib/hiring-documents/service.ts",
  "src/lib/mailbox-monitor/service.ts",
  "src/lib/marketing-requests/direct-tracking.ts",
  "src/lib/marketing-requests/roi-report-service.ts",
  "src/lib/marketing-requests/sales-evidence.ts",
  "src/lib/marketing-requests/service.ts",
  "src/lib/marketing-requests/validated-customer-transfer.ts",
  "src/lib/payroll/copilot/service.ts",
  "src/lib/probation/intelligence/assessments.ts",
  "src/lib/probation/intelligence/consolidated-report.ts",
  "src/lib/probation/intelligence/scoring-service.ts",
  "src/lib/recruitment/manager-cv-engagement.ts",
];

/** Enough of an AccessContext to reach the guard; every guard fires before `access` is read. */
const ACCESS = { role: "Super Admin", scope: "system", hrId: "a-1", loginId: "a-1" } as never;

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/** Mirrors supabase-js v2's PostgrestError: a real Error subclass carrying code/details/hint. */
function postgrestError(message: string, code: string) {
  const error = new Error(message);
  error.name = "PostgrestError";
  return Object.assign(error, { code, details: "", hint: "" });
}

export async function runMalformedUuidIdGuardsTests() {
  // ── the predicate ─────────────────────────────────────────────────────────
  assert.equal(
    isUuid("report-share-links"),
    false,
    "the exact segment that 500'd on production must be rejected — this is the regression",
  );
  assert.equal(isUuid("0eb6e2a4-9a1e-4a1e-8b1e-2a1e4a1e8b1e"), true, "a real uuid is accepted");
  assert.equal(
    isUuid("0EB6E2A4-9A1E-4A1E-8B1E-2A1E4A1E8B1E"),
    true,
    "Postgres accepts a uuid in either case, so the guard must not reject upper-case",
  );
  assert.equal(isUuid(""), false, "an empty segment is not an id");
  assert.equal(isUuid("   "), false, "whitespace is not an id");
  assert.equal(isUuid(null), false, "null must not throw — guards call this on unvalidated input");
  assert.equal(isUuid(undefined), false, "undefined must not throw either");
  assert.equal(
    isUuid("0eb6e2a4-9a1e-4a1e-8b1e-2a1e4a1e8b1e "),
    false,
    "a trailing space is 22P02 in Postgres too, so the guard must not accept it",
  );
  assert.equal(
    isUuid("0eb6e2a4-9a1e-4a1e-8b1e-2a1e4a1e8b1ee"),
    false,
    "an over-long final group is not a uuid",
  );
  assert.equal(isUuid("0eb6e2a4-9a1e-4a1e-8b1e"), false, "a truncated uuid is not a uuid");
  assert.equal(
    isUuid("share-links' or 1=1--"),
    false,
    "anything that is not exactly a uuid is refused; the guard never reasons about content",
  );

  // ── the reported route, end to end through the domain service ─────────────
  // No database is reached: every guard below fires before its first query, which is also what
  // makes this test offline. Remove a guard and the call proceeds to Postgres and raises 22P02,
  // failing the status assertion.
  await assert.rejects(
    () => getMarketingRequestDetail("report-share-links", ACCESS),
    (error: unknown) => {
      assert.equal(
        statusOf(error),
        404,
        "THE HEADLINE: an id that cannot exist is 404 (not found), never 500 (we are broken)",
      );
      assert.ok(
        !/invalid input syntax|uuid|22P02/i.test(messageOf(error)),
        "and the Postgres sentence must not travel with it — that is a schema leak",
      );
      return true;
    },
  );

  // The message and code are the SAME ones a well-formed id matching no row already produces, so
  // a malformed id and an absent one are indistinguishable. That is deliberate: this fix must not
  // hand anyone a new way to probe which ids exist.
  await assert.rejects(
    () => getMarketingRequestDetail("report-share-links", ACCESS),
    (error: unknown) => {
      assert.equal(messageOf(error), "Marketing request was not found.", "reuses the absent-row message");
      assert.equal(
        (error as { code?: unknown }).code,
        "marketing_request_not_found",
        "and the absent-row code, so the two answers are byte-identical",
      );
      return true;
    },
  );

  // ── the same shape in the other domains the sweep turned up ───────────────
  await assert.rejects(
    () => getCaseScore("not-a-case-id"),
    (error: unknown) => {
      assert.match(messageOf(error), /not found/i, "a probation case id that cannot exist is not found");
      return true;
    },
  );

  await assert.rejects(
    () => getCaseAssessments(ACCESS, "not-a-case-id"),
    (error: unknown) => {
      assert.match(messageOf(error), /not found/i, "same for the assessments tab on that case");
      return true;
    },
  );

  await assert.rejects(
    () => listManagerEngagementCandidateFiles("not-a-candidate-id"),
    (error: unknown) => {
      assert.match(messageOf(error), /not found/i, "same for a candidate id in the engagement report");
      return true;
    },
  );

  assert.equal(
    await getHiringDocumentFileForDownload(ACCESS, "not-a-file-id"),
    null,
    "hiring documents already answer null for a file id matching no row; a malformed one is the same answer",
  );

  // ── every guard site still carries its guard ──────────────────────────────
  for (const source of GUARDED_SOURCES) {
    const text = readFileSync(new URL(`../${source}`, import.meta.url), "utf8");
    assert.ok(
      text.includes("isUuid("),
      `${source} lost its malformed-id guard — the route(s) behind it answer 500 again`,
    );
  }

  // ── why the guard is at the point of use and not in toApiError ────────────
  // If someone moves this into toApiError, these two stop disagreeing and the reasoning above is
  // lost. A 22P02 arriving from infrastructure is genuinely a 500: by then the caller's intent —
  // "look this id up" vs "store this value" — is no longer recoverable.
  const raw22P02 = postgrestError('invalid input syntax for type uuid: "report-share-links"', "22P02");
  const mapped = toApiError(raw22P02, "Marketing request detail failed.");
  assert.equal(
    mapped.status,
    500,
    "toApiError must keep treating a RAISED 22P02 as infrastructure — the guard's job is to stop it being raised",
  );
  assert.equal(
    mapped.message,
    "Marketing request detail failed.",
    "and must keep redacting the Postgres sentence behind the caller's fallback",
  );

  // ── one definition, and it stays that way ─────────────────────────────────
  // The uuid regex had regenerated into three separate copies before it was folded: here, in
  // hiring-pack/types.ts, and inline in payroll/service.ts as `isLikelyUuid`. Nothing caught that,
  // because three identical regexes never disagree — until one of them is edited.
  //
  // metrics.ts is the deliberate exception and is listed, not excluded silently: `isUuidLike`
  // tests `value.trim()` because it SUPPRESSES uuids from notification detail rows, where
  // catching one with stray whitespace is the safe error. A lookup guard must NOT trim — Postgres
  // answers `"<uuid> "` with 22P02 — so folding the two together would break whichever call site
  // lost its own semantics.
  const ALLOWED_UUID_PATTERN_FILES = new Set([
    "src/lib/http/uuid.ts",
    // Deliberately NOT folded, with a different contract from a lookup guard:
    //   metrics.ts  — isUuidLike TRIMS, because it suppresses uuids from notification detail rows.
    // A lookup guard must be anchored and must not trim; folding it would break one of the two.
    // (error-monitor/ai-redact.ts, a global uuid scanner, was listed here until it was deleted with
    // the System Issues page's AI triage on 23 Oct 2026.)
    "src/lib/communication/metrics.ts",
  ]);

  const uuidPattern = /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/;
  const srcRoot = new URL("../src/", import.meta.url);
  const offenders: string[] = [];

  const walk = (dir: URL, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const rel = `src/${prefix}${entry.name}`;
      if (ALLOWED_UUID_PATTERN_FILES.has(rel)) continue;
      if (uuidPattern.test(readFileSync(new URL(entry.name, dir), "utf8"))) offenders.push(rel);
    }
  };
  walk(srcRoot, "");

  assert.deepEqual(
    offenders,
    [],
    `a uuid regex was written again instead of importing isUuid from @/lib/http/uuid: ${offenders.join(", ")}`,
  );

  // And the allow-list must not rot into cover for files that no longer hold the pattern.
  for (const allowed of ALLOWED_UUID_PATTERN_FILES) {
    const text = readFileSync(new URL(`../${allowed}`, import.meta.url), "utf8");
    assert.ok(
      uuidPattern.test(text),
      `${allowed} is allow-listed for the uuid regex but no longer contains one — drop it from the list`,
    );
  }
}
