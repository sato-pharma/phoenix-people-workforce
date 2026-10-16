import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { liveFunctionBody } from "./support/sql-definer.ts";

// A STARTED REP'S DOCTOR LIST IS HIS PHOENIX CRM LIST — in the same table, as a new dated period.
//
// WHY THIS IS PINNED (owner, 2026-10-07: "every single report that was pulling data from the CRM must
// stop pulling data from the Go Live teams and pull from the Phoenix CRM … I want the same table the
// same history as is … nothing show that a drop happened"):
//
// 20261004120000 taught all four of `crm_contact_master_refresh`'s assignment passes to SKIP a rep whose
// own team has started, so the vendor would stop overwriting his list. That was half the job: nothing
// then wrote the Phoenix list in, so his rows stayed frozen exactly as iReports360 had last left them.
// Esraa Ibrahim Saad is the shape of it, measured on production: 0 doctors on every screen against 163
// in Phoenix CRM — a rep with no list at all, which reads on the KPIs board as a rep who covered nobody.
//
// REHEARSED ON PRODUCTION inside one rolled-back transaction (2026-10-07), both migrations applied and a
// real `crm_contact_master_refresh(false)` run. What it measured, and what this file keeps true:
//   · 15 reps moved to their Phoenix list — Esraa 0 → 163, Ahmed Farag 103 → 93 (14 his manager dropped),
//     and thirteen within a handful of the vendor's count. The denominators become right, they do not jump.
//   · Nermeen Salah KEPT her 25 vendor doctors and Mahmoud ElHassanin his 1, because neither has a
//     Phoenix list; Dina Hamdy Fadel, a district manager, stayed at 0/0. The refresh's own counters say
//     it: 1,997 rows frozen, 1,971 handed over — the 26 difference IS those three.
//   · NOT ONE ROW WAS DELETED: 12,191 → 14,362 rows, 2,171 opened, 1,971 vendor periods closed at
//     2 October (Delta (1)'s start minus a day). `unstarted_reps_changed` came back 0.
//
// CI never sees a database, so this reads the live definers' own text. Every pin here is a sentence the
// rehearsal proved; the rehearsal cannot run in CI, so the text is what stops it being undone.

/** The live bodies — whichever migration defines each one LAST, never a path written here. */
const REFRESH = liveFunctionBody("crm_contact_master_refresh");
const APPLY = liveFunctionBody("crm_contact_list_change_apply");

/** The fifth pass, from its own temporary table to the end of the function. */
const FIFTH = (() => {
  const at = REFRESH.indexOf("create temporary table crm_refresh_phoenix_lists");
  assert.ok(at > 0, "the fifth pass builds its own set in crm_refresh_phoenix_lists");
  return REFRESH.slice(at);
})();

/** One statement of the fifth pass, named by the line it starts with. */
function fifthStatement(label: string, needle: string): string {
  const at = FIFTH.indexOf(needle);
  assert.ok(at >= 0, `the ${label} statement must start "${needle.slice(0, 56)}…"`);
  const end = FIFTH.indexOf("get diagnostics", at);
  assert.ok(end > at, `the ${label} statement must report how many rows it touched`);
  return FIFTH.slice(at, end);
}

export function runDoctorListsEverywhereTests() {
  // ── 1. The fifth pass exists, and runs for a started team whatever the vendor sweep is doing ──────
  // Deliberately OUTSIDE the `if v_lists_live then` block that gates the four vendor passes. Inside it,
  // a global cutover date would switch the per-team feature off — which is the opposite of a per-team
  // switch, and would silently strand every started rep on a frozen list again.
  const liveGate = REFRESH.lastIndexOf("if v_lists_live then");
  const liveGateEnd = REFRESH.indexOf("get diagnostics v_opened = row_count;", liveGate);
  assert.ok(liveGate > 0 && liveGateEnd > liveGate, "the four vendor passes are still gated on v_lists_live");
  assert.ok(
    REFRESH.indexOf("create temporary table crm_refresh_phoenix_lists") > liveGateEnd,
    "the fifth pass runs AFTER the vendor block and outside it — a per-team switch cannot depend on a global date",
  );

  // ── 2. The window is half-open, exactly as the TypeScript rule is ─────────────────────────────────
  assert.match(
    FIFTH,
    /v_today >= s\.counted_from\s*\n\s*and \(s\.counted_until is null or v_today < s\.counted_until\)/,
    "inclusive of counted_from, exclusive of counted_until — the same test startedWindowCovers makes",
  );

  // ── 3. WHAT IS ON THE LIST ────────────────────────────────────────────────────────────────────────
  // 'active' and 'pending' both are: a pending customer is a doctor the rep works, he simply scores
  // nothing until the customer is validated. 'outside' never is — an out-of-list visit is not an
  // assignment — and 'dropped' is read only so the pass can CLOSE the period it already opened.
  assert.match(FIFTH, /and c\.status in \('active', 'pending', 'dropped'\)/, "the set holds the three statuses it needs");
  assert.doesNotMatch(FIFTH, /'outside'/, "an out-of-list customer never joins a list");
  for (const [label, needle] of [
    ["the vendor hand-over", "where status in ('active', 'pending')"],
    ["the open pass", "where status in ('active', 'pending')"],
  ] as const) {
    assert.ok(FIFTH.includes(needle), `${label} counts only the live statuses`);
  }
  assert.ok(FIFTH.includes("where status = 'dropped'"), "the close pass reads only the dropped ones");
  assert.match(FIFTH, /and not c\.is_test/, "a test customer is never on anybody's list");

  // ── 4. 🔴 A REP WITH NO PHOENIX LIST KEEPS HIS VENDOR LIST ────────────────────────────────────────
  // The one assertion that protects a real list. Three of the eighteen started people are district
  // managers who hold none, and two reps have a vendor list and no Phoenix one — Nermeen Salah's 25
  // doctors and Mahmoud ElHassanin's 1. A hand-over keyed on the STARTED SET instead of on the LIST
  // would take all three to zero, which is this very defect in reverse.
  const handover = fifthStatement("vendor hand-over", "update public.crm_contact_assignments a\n     set effective_to = greatest(a.effective_from, l.counted_from - 1)");
  assert.match(
    handover,
    /from \(select distinct hr_key, agent_crm_id, counted_from\s*\n\s*from pg_temp\.crm_refresh_phoenix_lists\s*\n\s*where status in \('active', 'pending'\)\) l/,
    "the hand-over is driven by the PHOENIX LIST, never by the started-rep set — a rep with no list is never in it",
  );
  assert.match(
    handover,
    /and a\.source = 'ireports360'/,
    "it hands over the vendor's rows only",
  );
  assert.doesNotMatch(handover, /crm_refresh_started_reps/, "it must not key on the started set");

  // ── 5. THE SEAM HAS NO GAP AND NO OVERLAP ─────────────────────────────────────────────────────────
  // The vendor answers up to counted_from - 1 and Phoenix from counted_from. One day either way and a
  // report shows a blank day, or counts the same doctor twice — both read as "a drop happened".
  assert.match(handover, /l\.counted_from - 1/, "the vendor period ends the day BEFORE the team started");
  const open = fifthStatement("open", "insert into public.crm_contact_assignments (");
  assert.match(
    open,
    /greatest\(l\.starts_on, coalesce\(prev\.last_to \+ 1, l\.starts_on\)\)/,
    "a new period never starts before one this rep already closed for the same doctor and list",
  );
  assert.match(
    FIFTH,
    /greatest\(\s*\n?\s*r\.counted_from,\s*\n\s*least\(v_today, \(c\.created_at at time zone 'Africa\/Cairo'\)::date\)\s*\n\s*\) as starts_on/,
    "a period starts at the team's start or at the customer's own creation, never before either",
  );

  // ── 6. NOTHING IS EVER DELETED — a period is CLOSED ───────────────────────────────────────────────
  // This is what makes the old reports keep reading. A month already computed reads these periods by
  // date, so closing one leaves every day before it exactly as it was.
  assert.doesNotMatch(
    FIFTH,
    /\b(delete from|truncate)\b/i,
    "the fifth pass deletes nothing — the whole continuity promise rests on this",
  );
  assert.match(
    FIFTH,
    /least\(v_today - 1, d\.dropped_to\)/,
    "a dropped customer's period closes before today, so he leaves today's list and stays in the history",
  );
  assert.match(
    FIFTH,
    /greatest\(r\.counted_from, least\(v_today, \(c\.status_changed_at at time zone 'Africa\/Cairo'\)::date\)\) - 1 as dropped_to/,
    "the drop day is the day the manager decided, read as a CAIRO day",
  );

  // ── 7. A REGRADE IS A NEW PERIOD, NEVER AN EDIT ───────────────────────────────────────────────────
  // The grade decides a doctor's frequency norm. Rewriting it in place would restate every month
  // already scored against the old one.
  const regrade = fifthStatement("regrade", "update public.crm_contact_assignments a\n     set effective_to = greatest(a.effective_from, v_today - 1)");
  assert.match(regrade, /and a\.grade is distinct from g\.grade/, "only a row whose grade actually moved is closed");
  assert.match(regrade, /and a\.source = 'phoenix_crm'/, "a regrade only ever closes a DERIVED row");

  // ── 8. 🔴 IT NEVER TOUCHES A HUMAN DECISION ───────────────────────────────────────────────────────
  // `source = 'phoenix'` is one approved list change. Destroying it to re-derive a list would undo a
  // decision nobody can recover, so every statement that writes an existing row names its own source.
  const writes = FIFTH.split(/\n(?=  update public\.crm_contact_assignments)/).filter((part) =>
    part.trimStart().startsWith("update public.crm_contact_assignments"),
  );
  assert.equal(writes.length, 4, "the fifth pass updates existing rows in exactly four statements");
  for (const statement of writes) {
    assert.match(
      statement,
      /and a\.source = '(ireports360|phoenix_crm)'/,
      "every update names the source it owns, so a source = 'phoenix' row is never reached",
    );
  }
  assert.match(open, /'phoenix_crm'\n/, "the rows it opens are marked as derived");

  // ── 9. CAIRO DAYS, EVERYWHERE ─────────────────────────────────────────────────────────────────────
  // A bare `::date` on a timestamptz reads a UTC day, so a row saved after 22:00 Cairo lands on the
  // wrong day — and on the seam day that is exactly a missing or a duplicated doctor.
  for (const column of ["created_at", "status_changed_at"]) {
    assert.doesNotMatch(
      FIFTH,
      new RegExp(`c\\.${column}\\)?::date`),
      `${column} is converted to Africa/Cairo before it becomes a day`,
    );
  }

  // ── 10. EVERY PASS REPORTS WHAT IT DID ────────────────────────────────────────────────────────────
  // A pass that silently does less is the shape that hides for weeks. These are the counters the
  // production rehearsal was read from.
  for (const key of [
    "phoenixListReps",
    "phoenixVendorHandedOver",
    "phoenixAssignmentsOpened",
    "phoenixAssignmentsClosed",
    "phoenixAssignmentsRegraded",
    "phoenixAssignmentsTouched",
  ]) {
    assert.ok(REFRESH.includes(`'${key}',`), `the refresh reports ${key}`);
  }

  // ── 11. A PHOENIX-BORN DOCTOR GETS HIS NAME ROW, AND NEVER OVERWRITES THE VENDOR'S ────────────────
  // `crm_contact_assignments` has a foreign key to `crm_contacts`, so without this the fifth pass could
  // not insert a row for a doctor who exists only in Phoenix CRM. It runs BEFORE the fifth pass for
  // exactly that reason. `source` is 'phoenix' because that is the only value crm_contacts_source allows
  // for one — 'phoenix_crm' would be rejected by the CHECK and the whole hourly run would fail.
  //
  // It reads the SNAPSHOT, not `public.phoenix_crm_customers` (20261015132445). Running before the fifth
  // pass was never enough on its own: both passes read the customer table in their own statement, and at
  // READ COMMITTED each statement takes a fresh snapshot, so a doctor a rep added in between was absent
  // here and present there — and the foreign key aborted the whole run. One read makes this pass's set a
  // superset of the fifth's by construction. `tests/crm-contact-master.test.ts` block 9 pins the one read.
  const nameRow = REFRESH.indexOf("from pg_temp.crm_refresh_phoenix_customers p");
  assert.ok(nameRow > 0, "the refresh gives a Phoenix-born doctor a crm_contacts row");
  assert.ok(
    nameRow < REFRESH.indexOf("create temporary table crm_refresh_phoenix_lists"),
    "it runs before the fifth pass, or the foreign key would refuse the assignment row",
  );
  const nameStatement = REFRESH.slice(REFRESH.lastIndexOf("insert into public.crm_contacts as c (", nameRow), nameRow + 600);
  assert.match(nameStatement, /'phoenix'::text as source,/, "the name row is marked 'phoenix' — the only source value the CHECK allows");
  assert.match(
    REFRESH.slice(nameRow),
    /name = coalesce\(c\.name, excluded\.name\)/,
    "a name the vendor already carries is left alone — renaming it would restate months already read",
  );

  // ── 12. THE ID IS THE SAME ONE THE DOORS EMIT ─────────────────────────────────────────────────────
  // A list keyed on one id and a visit keyed on another reads as a doctor who was never visited.
  assert.match(
    FIFTH,
    /coalesce\(c\.reference_contact_crm_id, c\.own_contact_crm_id\) as contact_crm_id/,
    "the list carries the same id crm_visits_unified, crm_plan_entries_unified and crm_checkins_unified carry",
  );

  // ── 13. 🔴 THE OTHER WRITER IS RECONCILED, NOT LEFT TO COLLIDE ────────────────────────────────────
  // `crm_contact_list_change_apply` writes crm_contact_assignments directly, and 20261004120000 opened
  // it for a started rep on purpose. With the list derived, a removal recorded only there would be
  // undone inside the hour: phoenix_crm_customers would still read 'active' and the fifth pass would
  // re-open the doctor — the same "re-open a removed doctor the next morning" the vendor guards exist
  // to stop. So the decision reaches Phoenix CRM itself.
  assert.match(
    APPLY,
    /select s\.seat_id into v_seat_id/,
    "the apply function resolves the rep's Phoenix seat, so it knows where the decision lands",
  );
  assert.match(
    APPLY,
    /update public\.phoenix_crm_customers c\s*\n\s*set status = 'dropped'/,
    "an approved REMOVAL drops the customer in Phoenix CRM, or the next refresh brings him back",
  );
  assert.match(
    APPLY,
    /update public\.phoenix_crm_customers c\s*\n\s*set grade = v_change\.grade/,
    "an approved REGRADE moves the grade in Phoenix CRM, or it lasts under an hour",
  );
  assert.match(
    APPLY,
    /coalesce\(c\.reference_contact_crm_id, c\.own_contact_crm_id\) = v_contact/,
    "it finds the customer by the same id the list and the doors use",
  );
  assert.match(
    APPLY,
    /'phoenix'\n\s*\);/,
    "its own assignment row stays source = 'phoenix' — the derived pass never closes or regrades one",
  );
  assert.ok(APPLY.includes("v_customer_mirrored"), "it reports whether the decision reached Phoenix CRM");

  // ── 14. THE THIRD SOURCE VALUE AND ITS IDENTITY RULE MOVE TOGETHER ────────────────────────────────
  // The identity CHECK ends in `else false`, so allowing 'phoenix_crm' in one constraint and not the
  // other would reject every insert the fifth pass makes — and the hourly refresh would fail in silence.
  // PINNED TO THE MIGRATION THAT INTRODUCED THE FIFTH PASS, not to the newest definer of the refresh: the
  // constraints, the ROLLBACK recipe and the no-PITR sentence live in that file, and a later migration that
  // only recreates the function body (20261012184500, a doctor added twice) rightly carries none of them.
  const migration = readFileSync(
    new URL("../supabase/migrations/20261007200000_started_reps_doctor_list_is_phoenix_own.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /check \(source = any \(array\['ireports360'::text, 'phoenix'::text, 'phoenix_crm'::text\]\)\)/,
    "'phoenix_crm' is an allowed source",
  );
  assert.match(
    migration,
    /when 'phoenix_crm' then agent_hr_id is not null and btrim\(agent_hr_id\) <> ''/,
    "and the identity CHECK accepts it, keyed on the HR id because a started rep may have no CRM account",
  );

  // ── 15. IT SAYS, IN THE FILE, WHAT A RESTORE WOULD HAVE TO UNDO ───────────────────────────────────
  // Production has no point-in-time recovery, so a migration that writes list rows carries its own way back.
  assert.match(migration, /ROLLBACK:/, "the migration carries a rollback recipe");
  assert.match(migration, /NO point-in-time recovery/, "and says plainly that there is no PITR behind it");
}
