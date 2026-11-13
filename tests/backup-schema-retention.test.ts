import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXEMPT_SCHEMAS,
  EXEMPT_SNAPSHOT_TABLES,
  RETENTION_DAYS,
  SNAPSHOT_TABLE_SCHEMAS,
  STANDARD_SCHEMAS,
  VERDICT,
  classify,
  classifyTable,
  datesIn,
  isSnapshotTableName,
  readDecisions,
  snapshotDateOf,
} from "../scripts/audit-backup-schemas.mjs";
import { csvField, toCsv } from "../scripts/export-backup-schema.mjs";

/**
 * scripts/audit-backup-schemas.mjs decides which ad-hoc backup schemas have outlived their
 * purpose. Production had 99 of them on 2026-09-29 and had ever dropped one.
 *
 * Everything below runs with no database. What it guards is the single way this script could
 * cause real damage: naming a schema expired while something still needs it. Production has no
 * point-in-time recovery, so that mistake is recoverable for seven days and only by restoring a
 * backup into a separate project.
 *
 * Every rule here is asserted with its NEGATIVE CONTROL — the same input with the protection
 * removed, which must flip to EXPIRED. Without that, a classifier that returned "keep" for
 * everything would pass every test on this page.
 */
export function runBackupSchemaRetentionTests() {
  const TODAY = "2026-09-29";

  // Since REC-040 (2026-11-13) age alone never makes a schema droppable: the owner's recorded
  // decision does. The age and dependency rules below are asserted WITH a "drop" decision in hand,
  // so EXPIRED still means "the age rule let it through"; the decision rules have their own section.
  const drop = (schema: string) => ({
    [schema]: { decision: "drop" as const, decidedOn: "2026-11-13", decidedBy: "owner", why: "test" },
  });

  // ---------------------------------------------------------------- date extraction

  assert.deepEqual(datesIn("ats_backup_20260928_hiredfix"), ["2026-09-28"]);
  assert.deepEqual(datesIn("code_refs_pre_sync_2026_08_19b"), ["2026-08-19"]);
  assert.deepEqual(datesIn("snap-2026-01-05"), ["2026-01-05"]);
  assert.deepEqual(datesIn("customer_map_20260911_0110"), ["2026-09-11"], "a trailing time is not a second date");
  assert.deepEqual(datesIn("areas_full"), [], "no digits, no date");

  // An impossible date is NOT a date. Clamping one would invent an expiry for a schema that
  // never declared one, which is the one direction this must never fail in.
  assert.deepEqual(datesIn("x_20261301"), [], "month 13 is not December");
  assert.deepEqual(datesIn("x_20260230"), [], "February 30th does not exist");
  assert.deepEqual(datesIn("x_20260000"), [], "month 0 / day 0 is not a date");

  // ---------------------------------------------------------------- which date wins

  assert.equal(
    snapshotDateOf("sos_backup_20260913", ["anything_20260101"]),
    "2026-09-13",
    "the schema's own date beats its tables'",
  );

  // The fallback that rescues the undated schemas. ops_backup carries no date; its tables do.
  assert.equal(
    snapshotDateOf("ops_backup", [
      "v2_vacation_requests_20260824",
      "v2_vacation_requests_a10_pre_paidfix_20260917",
      "email_templates_20260910_leave_codes",
    ]),
    "2026-09-17",
    "the NEWEST table date — a schema reused later is only as expired as its latest contents",
  );

  assert.equal(snapshotDateOf("plan_backups", ["deleted_employee_plans"]), null);

  // ---------------------------------------------------------------- the safety property

  // 🔴 A LIVE DEPENDENCY BEATS AGE. This is the real production case: the live table
  // public.private_calendar_no_activity_clarifications holds a foreign key into
  // deductions_governance_backup_20260830, which by name and age is indistinguishable from 98
  // inert siblings.
  const pinned = {
    schema: "deductions_governance_backup_20260830",
    tables: ["deduction_candidates"],
    blockers: ["foreign key private_calendar_..._fkey on public.private_calendar_no_activity_clarifications points into it"],
  };
  assert.equal(
    classify(pinned, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.PINNED,
    "A FOREIGN KEY MUST BEAT AGE — five years old against a one-day retention and it still stays",
  );

  // Negative control: the identical entry with the blocker removed MUST expire. If this does not
  // flip, the assertion above is proving nothing.
  assert.equal(
    classify({ ...pinned, blockers: [] }, { today: "2031-01-01", retentionDays: 1, decisions: drop(pinned.schema) }).verdict,
    VERDICT.EXPIRED,
    "without the foreign key the same schema expires — so the check above is load-bearing",
  );

  // ---------------------------------------------------------------- the owner's decisions

  for (const schema of ["hr_backup_20260829", "crm_backup_20260828", "delta3_defer_backup_20260829"]) {
    assert.ok(EXEMPT_SCHEMAS[schema], `${schema} must stay exempt — the owner's standing decision`);
    assert.equal(
      classify({ schema, tables: [], blockers: [] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
      VERDICT.PROTECTED,
      `${schema} must never expire on age alone`,
    );
  }

  // Negative control: an unlisted sibling of the same vintage DOES expire, so the exemption is
  // doing the work and not some accident of the name.
  assert.equal(
    classify({ schema: "hr_backup_20260830", tables: [], blockers: [] }, { today: TODAY, retentionDays: 1, decisions: drop("hr_backup_20260830") }).verdict,
    VERDICT.EXPIRED,
    "an unlisted schema of the same shape expires — the exemption list is what holds the others",
  );

  assert.equal(classify({ schema: "analytics", tables: [], blockers: [] }, { today: TODAY }).verdict, VERDICT.LIVE);
  assert.equal(classify({ schema: "private", tables: [], blockers: [] }, { today: TODAY }).verdict, VERDICT.LIVE);

  // ---------------------------------------------------------------- undated never expires

  const undated = { schema: "plan_backups", tables: ["deleted_employee_plans"], blockers: [] };
  assert.equal(
    classify(undated, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.UNDATED,
    "no date means the rule cannot reach it — it is reported for a human, never auto-proposed",
  );

  // Negative control: give the same schema a dated table and it becomes ageable.
  assert.equal(
    classify({ ...undated, tables: ["deleted_employee_plans_20260101"] }, { today: "2031-01-01", retentionDays: 1, decisions: drop(undated.schema) }).verdict,
    VERDICT.EXPIRED,
  );

  // ---------------------------------------------------------------- the window boundary

  const at = (date: string, retentionDays: number) => {
    const schema = `x_backup_${date.split("-").join("")}`;
    return classify({ schema, tables: [], blockers: [] }, { today: TODAY, retentionDays, decisions: drop(schema) });
  };

  assert.equal(at("2026-08-31", 30).verdict, VERDICT.YOUNG, "29 days old under a 30-day retention");
  assert.equal(at("2026-08-31", 30).ageDays, 29);
  assert.equal(at("2026-08-30", 30).verdict, VERDICT.EXPIRED, "exactly at the retention age is expired");
  assert.equal(at("2026-08-30", 30).ageDays, 30);

  // A snapshot dated in the future is not expired. Clock skew and a hand-typed name both produce
  // these, and a negative age must never read as "very old".
  assert.equal(at("2027-01-01", 30).verdict, VERDICT.YOUNG);

  assert.equal(RETENTION_DAYS, 90, "the default is deliberately generous — see docs/security/backup-schema-retention.md");

  // ------------------------------------------------- every expired schema needs his decision
  //
  // 🔴 REC-040 (enterprise audit 2026-11-13). Until then a schema past 90 days printed a drop
  // statement on age alone. Now nothing past retention is offered for dropping until the owner has
  // a recorded decision for THAT schema in scripts/backup-schema-decisions.json.

  const old = { schema: "x_backup_20260101", tables: [], blockers: [] };
  const LATER = { today: "2026-11-13", retentionDays: 90 };

  assert.equal(
    classify(old, LATER).verdict,
    VERDICT.UNDECIDED,
    "PAST RETENTION WITH NO DECISION IS UNDECIDED, NEVER EXPIRED — age alone drops nothing",
  );
  // Negative control: the same schema with his "drop" recorded does expire.
  assert.equal(classify(old, { ...LATER, decisions: drop(old.schema) }).verdict, VERDICT.EXPIRED);
  // A decision for a DIFFERENT schema decides nothing here.
  assert.equal(classify(old, { ...LATER, decisions: drop("x_backup_20260102") }).verdict, VERDICT.UNDECIDED);

  const exportThenDrop = {
    [old.schema]: { decision: "export-then-drop" as const, decidedOn: "2026-11-13", decidedBy: "owner", why: "test" },
  };
  const exported = classify(old, { ...LATER, decisions: exportThenDrop });
  assert.equal(exported.verdict, VERDICT.EXPIRED, "export-then-drop is a decision that it goes");
  assert.equal(
    exported.decision?.decision,
    "export-then-drop",
    "the decision travels with the verdict — the drop step needs it to demand the export first",
  );

  // A decision never beats a live dependency: drop recorded, foreign key still there, it stays.
  assert.equal(
    classify({ ...old, blockers: ["foreign key x points into it"] }, { ...LATER, decisions: drop(old.schema) }).verdict,
    VERDICT.PINNED,
    "A RECORDED DROP MUST NOT BEAT A LIVE DEPENDENCY",
  );

  // Inside the window a decision changes nothing but the note.
  const youngDecided = classify({ ...old, schema: "x_backup_20261101" }, { ...LATER, decisions: drop("x_backup_20261101") });
  assert.equal(youngDecided.verdict, VERDICT.YOUNG, "a decision never drops a schema before its 90 days");
  assert.match(youngDecided.reason, /owner decided drop on 2026-11-13/);

  // Keep — for good, or until a date, after which it is put to him again.
  const keep = (until?: string) => ({
    [old.schema]: { decision: "keep" as const, until, decidedOn: "2026-11-13", decidedBy: "owner", why: "test" },
  });
  assert.equal(
    classify(old, { today: "2031-01-01", retentionDays: 1, decisions: keep() }).verdict,
    VERDICT.PROTECTED,
    "keep with no date is for good",
  );
  assert.equal(
    classify(old, { ...LATER, today: "2026-11-30", decisions: keep("2026-12-01") }).verdict,
    VERDICT.PROTECTED,
    "kept until 1 Dec, read on 30 Nov",
  );
  assert.equal(
    classify(old, { ...LATER, today: "2026-12-01", decisions: keep("2026-12-01") }).verdict,
    VERDICT.UNDECIDED,
    "A KEEP THAT RUNS OUT GOES BACK TO HIM — never straight to a drop",
  );

  // The decisions file: every entry must name what was decided, when, by whom and why.
  const dir = mkdtempSync(path.join(tmpdir(), "backup-decisions-"));
  try {
    const write = (decisions: unknown) => {
      const file = path.join(dir, "decisions.json");
      writeFileSync(file, JSON.stringify({ decisions }), "utf8");
      return file;
    };
    const good = { decision: "drop", decidedOn: "2026-11-13", decidedBy: "owner", why: "test" };
    assert.deepEqual(Object.keys(readDecisions(write({ x_backup_20260101: good }))), ["x_backup_20260101"]);
    assert.throws(() => readDecisions(write({ x_backup_20260101: { ...good, decision: "archive" } })), /use drop, export-then-drop or keep/);
    assert.throws(() => readDecisions(write({ x_backup_20260101: { ...good, why: "" } })), /needs decidedOn/);
    assert.throws(() => readDecisions(write({ x_backup_20260101: { ...good, decidedOn: "13 Nov" } })), /needs decidedOn/);
    assert.throws(() => readDecisions(write({ x_backup_20260101: { ...good, decidedBy: undefined } })), /needs decidedOn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The real file parses, and every entry names one real schema and the sheet that put it to him.
  // A schema need not carry a date in its OWN name: `ops_backup`, `marketing_rollback` and
  // `map_audit_baseline` are aged by the dates on their tables (snapshotDateOf), and all three were
  // put to him on the December 2026 sheet.
  const real = readDecisions();
  for (const [schema, entry] of Object.entries(real)) {
    assert.match(schema, /^[a-z_][a-z0-9_]*$/, `${schema} is not a schema name`);
    assert.ok(!STANDARD_SCHEMAS.has(schema), `${schema} is a standard schema — never a snapshot to decide`);
    assert.ok(entry.decidedBy && entry.sheet, `${schema}: decidedBy and the sheet that put it to him`);
  }
  assert.ok(Object.keys(real).length >= 101, "the November nine and the December 92 are all recorded");

  // ------------------------------------------------- export, then drop
  //
  // His "export, then drop" means the file copy exists BEFORE any drop statement is printed.

  const auditSource = readFileSync(new URL("../scripts/audit-backup-schemas.mjs", import.meta.url), "utf8");
  assert.match(
    auditSource,
    /decision === "export-then-drop" && !existsSync\(manifest\)\) \{[\s\S]{0,300}?continue;/,
    "an export-then-drop schema must get NO drop statement until its export manifest is on disk",
  );

  const exportSource = readFileSync(new URL("../scripts/export-backup-schema.mjs", import.meta.url), "utf8");
  const exportQueries: string[] = [];
  const exportTemplates = /sql`([^`]*)`/g;
  let exportMatch: RegExpExecArray | null;
  while ((exportMatch = exportTemplates.exec(exportSource)) !== null) exportQueries.push(exportMatch[1]);
  assert.ok(exportQueries.length >= 3, `expected the export's queries, found ${exportQueries.length}`);
  for (const q of exportQueries) {
    assert.ok(!/\b(drop|delete|update|insert|truncate|alter)\b/i.test(q), `the export only reads: ${q.slice(0, 80)}`);
  }
  assert.match(exportSource, /decision\?\.decision !== "export-then-drop"/, "only a schema he decided export-then-drop is exported");

  // CSV fields: what the file holds must read back as what the table held.
  assert.equal(csvField(null), "", "null is an empty field");
  assert.equal(csvField(undefined), "");
  assert.equal(csvField(0), "0", "zero is not empty");
  assert.equal(csvField(false), "false");
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField({ a: 1 }), '"{""a"":1}"', "an object is its JSON, quoted");
  assert.equal(csvField(new Date("2026-11-13T14:00:00Z")), "2026-11-13T14:00:00.000Z");
  assert.equal(toCsv(["id", "name"], [{ id: 1, name: "x,y" }, { id: 2, name: null }]), 'id,name\r\n1,"x,y"\r\n2,\r\n');

  // ------------------------------------------------- snapshot TABLES in the standard schemas
  //
  // 🔴 THE GAP THIS CLOSES. Everything above sweeps non-standard SCHEMAS, and a snapshot taken as
  // a dated TABLE in `public` or `au` has no schema of its own to age out — so it was outside the
  // script entirely and could never expire. Production carried 58 of them on 2026-10-13 (5.5 MB),
  // none of which this sweep had ever seen, and two of them had just pushed the advisor's
  // `rls_enabled_no_policy` count up with a written note claiming they would leave by themselves.

  // The schemas swept for tables must be ones the SCHEMA sweep skips. If a name here ever stopped
  // being standard, the schema pass would claim it and this pass would double-count it.
  for (const schema of SNAPSHOT_TABLE_SCHEMAS) {
    assert.ok(
      STANDARD_SCHEMAS.has(schema),
      `${schema} is swept for snapshot tables because the schema sweep skips it — it must stay standard`,
    );
  }
  assert.ok(SNAPSHOT_TABLE_SCHEMAS.includes("public") && SNAPSHOT_TABLE_SCHEMAS.includes("au"));

  // A DATE IS REQUIRED. Without one there is nothing to age, so it is never proposed.
  assert.equal(isSnapshotTableName("address_brick_moves_20261013"), true, "a trailing date is the ad-hoc copy shape");
  assert.equal(isSnapshotTableName("bak_20261008_luxor_notes_fix"), true, "a snapshot word plus a date, date not last");
  assert.equal(isSnapshotTableName("sos_map_unmap_preimage_20261010"), true);
  assert.equal(isSnapshotTableName("zz_brick_backfill_snapshot_20260827"), true);
  assert.equal(isSnapshotTableName("database_restarts"), false, "a live log table with no date is not a snapshot");
  assert.equal(isSnapshotTableName("employees"), false);
  assert.equal(isSnapshotTableName("backup_plans"), false, "a snapshot word with NO date cannot be aged, so it is not claimed");
  assert.equal(isSnapshotTableName("targets_2026"), false, "four digits are not a date");

  // 🔴 The substring trap, asserted in both directions. `pre` inside "prescriptions" and `old`
  // inside "household" must NOT make a live table a snapshot — matching parts, not substrings, is
  // the same lesson the schema sweep's function-dependency query is written around.
  assert.equal(isSnapshotTableName("prescriptions_20261001_live_view"), false, "`pre` inside a word is not the word");
  assert.equal(isSnapshotTableName("household_counts_20261001_x"), false, "`old` inside household is not the word");
  // Negative control: the same names with the word as its own part DO qualify.
  assert.equal(isSnapshotTableName("prescriptions_pre_20261001_x"), true);
  assert.equal(isSnapshotTableName("household_counts_old_20261001_x"), true);

  // The safety property again, for tables: a live dependency beats age, always.
  const pinnedTable = {
    schema: "public",
    table: "address_brick_moves_20261013",
    blockers: ["view public.phx_brick_moves_v reads it"],
  };
  assert.equal(
    classifyTable(pinnedTable, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.PINNED,
    "A VIEW MUST BEAT AGE — five years old against a one-day retention and it still stays",
  );
  assert.equal(
    classifyTable({ ...pinnedTable, blockers: [] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.EXPIRED,
    "without the view the same table expires — so the check above is load-bearing",
  );

  // The owner's exemption mechanism, exercised rather than assumed. It ships empty on purpose.
  assert.deepEqual(EXEMPT_SNAPSHOT_TABLES, {}, "nothing is exempt until the owner says so");
  const exemptKey = "public.address_brick_moves_20261013";
  EXEMPT_SNAPSHOT_TABLES[exemptKey] = { why: "test-only entry" };
  try {
    assert.equal(
      classifyTable({ schema: "public", table: "address_brick_moves_20261013", blockers: [] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
      VERDICT.PROTECTED,
      "an exempt table must never expire on age alone",
    );
  } finally {
    delete EXEMPT_SNAPSHOT_TABLES[exemptKey];
  }
  // Negative control: with the entry gone it expires again, so the exemption did the work.
  assert.equal(
    classifyTable({ schema: "public", table: "address_brick_moves_20261013", blockers: [] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.EXPIRED,
  );

  const atTable = (date: string, retentionDays: number) =>
    classifyTable(
      { schema: "public", table: `x_backup_${date.split("-").join("")}`, blockers: [] },
      { today: TODAY, retentionDays },
    );
  assert.equal(atTable("2026-08-31", 30).verdict, VERDICT.YOUNG, "29 days old under a 30-day retention");
  assert.equal(atTable("2026-08-30", 30).verdict, VERDICT.EXPIRED, "exactly at the retention age is expired");
  assert.equal(atTable("2027-01-01", 30).verdict, VERDICT.YOUNG, "a future date is not 'very old'");

  // ---------------------------------------------------------------- it cannot drop anything

  const source = readFileSync(new URL("../scripts/audit-backup-schemas.mjs", import.meta.url), "utf8");

  // The script prints `drop schema` statements. It must never SEND one. Anything inside a
  // postgres`...` template is sent.
  //
  // Written with exec rather than matchAll, and without the `s` flag, because both are above this
  // repo's compile target — `[^`]` already spans newlines, so the flag bought nothing anyway.
  const sentToDatabase: string[] = [];
  const templates = /sql`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = templates.exec(source)) !== null) sentToDatabase.push(match[1]);

  assert.ok(sentToDatabase.length >= 4, `expected to find the queries, found ${sentToDatabase.length}`);
  for (const statement of sentToDatabase) {
    assert.ok(
      !/\bdrop\b/i.test(statement),
      `this script must never send a DROP to the database, found: ${statement.slice(0, 80)}`,
    );
  }
  assert.ok(!/--apply/.test(source), "there must be no --apply flag — dropping is a human's job, under supervision");

  // 🔴 A TABLE'S drop statement must carry NO `cascade`. The schema form has it because a snapshot
  // schema is dropped whole; a lone table sits in `public` BESIDE the live data, so a cascade there
  // would silently take whatever had come to depend on it. Without it the statement simply refuses.
  const tableDropMatch = /drop table if exists \$\{[^}]+\}\.\$\{[^}]+\};/.exec(source);
  const tableDrop = tableDropMatch === null ? "" : tableDropMatch[0];
  assert.notEqual(tableDrop, "", "the emitted per-table drop statement is missing");
  assert.ok(!/cascade/i.test(tableDrop), `a table drop must never cascade: ${tableDrop}`);

  // A daily partition (`events_20261013`) is the one shape the name test cannot tell from a
  // snapshot, so it is excluded in SQL. Asserted on the source because it lives in a query.
  assert.ok(
    /relispartition = false/.test(source),
    "partitioned children must be excluded in SQL — the name test cannot tell them from a snapshot",
  );
}
