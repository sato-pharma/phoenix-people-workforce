import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canCorrectHeldFullName, correctsHeldFullName, decideHeldFullName } from "../src/lib/phoenix-crm/server/full-name-reviews.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Super Admin and the SFE Manager correct a PM customer's held full name; nobody else does.
 *
 * Owner, 2026-11-08, on Place checks' "PM full names to check": "make an option to the admin only, not the
 * SFE, to edit the name by the reps to correct it, or add the third name"; then, the same evening, "make the edit
 * names appear to sfe manager".
 *
 * What must hold:
 *   * `canCorrectHeldFullName` is whoever decides these — the Super Admin on `update`, the SFE Manager on
 *     `approve` — never a district manager, never a test account;
 *   * a corrected name from anybody else is refused BEFORE the database is called, and so is one sent with
 *     Reject, and one that breaks the rep's own three-box rules (a title, an empty box);
 *   * the route asks its one permission (`approve`) and hands the body to the service, whose correction gate
 *     reads `update`; the page hands the screen the server's answer, and the screen draws Edit name only under it;
 *   * the database function honours the name on approve only and keeps the rep's spelling in the history.
 *
 * The refusals below throw before `callPhoenixCrm` runs, so no database is needed to drive them.
 */

const ROOT = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

const CUSTOMER = "5b0b8f8e-3f1c-4c55-9f0e-2a7d6c1b9e41";
const GOOD_NAME = { first: "احمد", middle: "محمد", last: "علي" };

const viewer = (overrides: Record<string, unknown>) =>
  ({ hrId: "B-1", isSuperAdmin: false, isSfeManager: false, isTestPersona: false, canApprove: false, canUpdate: false, ...overrides }) as never;

const SUPER_ADMIN = viewer({ hrId: "B-10", isSuperAdmin: true, canApprove: true, canUpdate: true });
const SFE_MANAGER = viewer({ hrId: "B-500", isSfeManager: true, canApprove: true, canUpdate: false });

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "NOT REFUSED";
}

export async function runPhoenixCrmFullNameCorrectionTests(): Promise<void> {
  // ── 1 · WHO MAY CORRECT ───────────────────────────────────────────────────────────────────────
  assert.equal(canCorrectHeldFullName(SUPER_ADMIN), true, "the Super Admin corrects a held name");
  assert.equal(canCorrectHeldFullName(SFE_MANAGER), true, "🔴 RED the SFE Manager corrects one too — his word: \"make the edit names appear to sfe manager\"");
  assert.equal(canCorrectHeldFullName(viewer({ isSfeManager: true, canApprove: true, isTestPersona: true })), false, "never an SFE test account");
  assert.equal(canCorrectHeldFullName(viewer({ isSfeManager: true, canApprove: false })), false, "never an SFE Manager without approve");
  assert.equal(canCorrectHeldFullName(viewer({ hrId: "B-77", canApprove: true, canUpdate: true })), false, "never anybody else, a district manager included");
  assert.equal(canCorrectHeldFullName(viewer({ isSuperAdmin: true, canApprove: true, canUpdate: true, isTestPersona: true })), false, "never a test account");
  assert.equal(canCorrectHeldFullName(viewer({ isSuperAdmin: true, canApprove: true, canUpdate: false })), false, "and never without update");

  assert.equal(correctsHeldFullName({ customerId: CUSTOMER, decision: "approve", nameParts: GOOD_NAME }), true);
  assert.equal(correctsHeldFullName({ customerId: CUSTOMER, decision: "approve" }), false, "a plain approve corrects nothing");
  assert.equal(correctsHeldFullName({ customerId: CUSTOMER, decision: "approve", nameParts: null }), false);

  // ── 2 · REFUSED BEFORE THE DATABASE ───────────────────────────────────────────────────────────
  assert.equal(
    await refusal(() => decideHeldFullName(SFE_MANAGER, { customerId: CUSTOMER, decision: "reject", nameParts: GOOD_NAME })),
    "A corrected name is saved with Approve.",
    "the SFE Manager passes the correction gate and meets the same approve-only rule",
  );
  assert.equal(
    await refusal(() => decideHeldFullName(SUPER_ADMIN, { customerId: CUSTOMER, decision: "reject", nameParts: GOOD_NAME })),
    "A corrected name is saved with Approve.",
    "a corrected name never rides on a Reject",
  );
  assert.equal(
    await refusal(() => decideHeldFullName(SUPER_ADMIN, { customerId: CUSTOMER, decision: "approve", nameParts: { first: "احمد", middle: "", last: "علي" } })),
    "Write the middle name.",
    "the third name is required — the same three-box rule a rep's own boxes keep",
  );
  assert.equal(
    await refusal(() => decideHeldFullName(SUPER_ADMIN, { customerId: CUSTOMER, decision: "approve", nameParts: { first: "مستشفي", middle: "محمد", last: "علي" } })),
    "First name names a place, not a person. Write the person's own name.",
    "and a place word is still refused",
  );

  // ── 3 · THE ROUTE, THE PAGE AND THE SCREEN ────────────────────────────────────────────────────
  const route = stripComments(read("app/api/phoenix-crm/full-names/route.ts"));
  assert.ok(route.includes("decideHeldFullName(viewer, await request.json())"), "the route hands every decision, corrections included, to the one service");
  const service = stripComments(read("src/lib/phoenix-crm/server/full-name-reviews.ts"));
  const gate = service.indexOf('if (!canCorrectHeldFullName(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager correct a name.");');
  assert.ok(gate > -1, "🔴 RED the service gates a corrected name on canCorrectHeldFullName");
  assert.ok(gate < service.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_full_name"'), "before the database is called");
  assert.match(service, /export function canCorrectHeldFullName\(viewer: PhoenixCrmViewer\): boolean \{\s+return canDecideValidationReviews\(viewer\);/, "and that gate is exactly who decides these");

  const page = stripComments(read("app/(admin)/admin/field-crm/validation-reviews/page.tsx"));
  assert.ok(page.includes("<FullNameChecks canCorrect={canCorrectHeldFullName(viewer)} rows={heldFullNames} />"), "the page hands the screen the server's own answer");

  const screen = stripComments(read("src/components/phoenix-crm/full-name-checks.tsx"));
  const editButton = screen.indexOf(">\n            Edit name\n");
  assert.ok(editButton > -1, "the screen has an Edit name control");
  assert.ok(screen.lastIndexOf("{canCorrect ? (", editButton) > -1 && screen.lastIndexOf("{canCorrect ? (", editButton) > screen.indexOf("function FullNameDecision"), "drawn only under canCorrect");
  assert.ok(screen.includes("setEditing(splitDoctorName(row.fullName))"), "it opens on what the rep wrote, split into the three boxes");
  assert.ok(screen.includes("<DoctorNameFields") && screen.includes(" stacked "), "the rep's own three boxes, one under another in the narrow decision cell");
  assert.ok(screen.includes('{ customerId: row.customerId, decision, nameParts }'), "Save and approve sends the three boxes, never a joined string the server cannot check");

  // ── 4 · THE DATABASE FUNCTION ─────────────────────────────────────────────────────────────────
  const sql = stripSqlComments(read("supabase/migrations/20261108204731_phoenix_crm_full_name_corrected.sql"));
  assert.match(sql, /if v_corrected is not null and v_decision <> 'approve' then\s+raise exception 'phoenix_crm:bad_input';/, "the name is honoured on approve only");
  assert.match(sql, /v_saved := coalesce\(v_corrected, v_held\);/, "with no name it saves the rep's, exactly as before");
  assert.match(sql, /'name', v_saved,\s+'speciality'/, "the rename is the corrected name");
  assert.match(sql, /jsonb_build_object\('rep_full_name', v_held, 'corrected', true\)/, "and the history keeps what the rep wrote beside it");
  assert.match(sql, /'full_name_refused_name' = v_held|full_name_refused_name = v_held/, "a reject still records the rep's own name");

  console.log("phoenix-crm full name correction: OK");
}
