import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  assertStagingTarget,
  refFromDatabaseUrl,
  toPooler,
  withLedgerInsert,
} from "../scripts/apply-migrations-to-staging.ts";
import {
  commitTimeMsForOneFileSlowly,
  commitTimesByFileNameForTests,
  isRecorded,
  isWithinGraceWindow,
  loadLocalMigrations,
  selectMissingMigrations,
  type LocalMigration,
  MIGRATIONS_DIR,
  type RemoteLedger,
} from "../scripts/lib/migration-inventory.ts";

// The staging migration applier runs unattended on every merge to main that touches
// supabase/migrations/**. Nobody reads its log on a good day, which makes it exactly the kind of
// automation whose defects surface as "why is staging behind again" months later.
//
// Three properties are load-bearing, and each one is here because getting it wrong is silent:
//
//   1. IT MUST NEVER REACH PRODUCTION. The guard is the only thing between a mistyped repository
//      secret and an unattended job applying migrations to the database real payroll runs on.
//   2. THE LEDGER INSERT MUST SURVIVE A FILE THAT ENDS IN A COMMENT. 14 of the repository's 410
//      migrations end with a `--` line rather than a semicolon. Append the insert without a
//      newline first and the comment swallows it: the migration applies, the ledger row does not
//      appear, and the next run applies the same file again — forever, with no error anywhere.
//   3. THE GRACE WINDOW MUST BE OFF HERE. The nightly drift check hides migrations younger than
//      48 hours because a report should not nag about a merge from an hour ago. The applier runs
//      ON that merge, so if it inherited the window it would skip the one file it exists to apply
//      and then never look at it again — the check would go quiet 48 hours later having applied
//      nothing. This is not hypothetical: on 2026-09-04 three migrations merged the previous day
//      sat unapplied on staging while the drift check reported green, correctly, for that reason.

const STAGING = "cifwmndunmlxjhyjugxa";
const PRODUCTION = "ozucdzovmcqvepbozvqf";

function migration(fileName: string, commitTimeMs: number | null = null): LocalMigration {
  const [, version, name] = /^(\d{14})_(.+)\.sql$/.exec(fileName) as RegExpExecArray;
  return { fileName, version, name, commitTimeMs };
}

function ledger(versions: string[] = [], names: string[] = []): RemoteLedger {
  return { versions: new Set(versions), names: new Set(names) };
}

/**
 * The first dollar-sign fault in a migration — a block opened and never closed, or a lone dollar
 * that opens nothing — or null when the file is sound.
 *
 * WHY. The applier hands Postgres a whole FILE as one simple query, so either fault refuses the
 * WHOLE migration with `syntax error at or near "$"`, and the only place that shows is this
 * unattended workflow, after the merge. It happened on 2026-10-09: a script that rewrote
 * 20261009120000_dispute_center.sql replaced text with String.replace, whose replacement string
 * reads a doubled dollar as an escape for a single one — so three `do` blocks opened with one
 * dollar instead of two. Every test that read that migration passed (they all match substrings),
 * it merged, the staging apply went red, and the production deploy sat held behind it.
 *
 * WHY IT IS A SCANNER AND NOT A COUNT. 20260901133000_honour_manual_direct_areas.sql closes a
 * dollar-quoted note on a line that STARTS with `--`, inside the string, where those two
 * characters are text and not a comment. Anything that strips comments first loses that closing
 * tag and calls a sound migration broken. So this walks the file the way the server does:
 * comments, single-quoted strings and dollar-quoted blocks, in that order.
 */
/**
 * The migration files that have been MODIFIED since they were added, newest change first.
 *
 * Chosen deliberately as a different git query from the one the production parser runs:
 * `--diff-filter=M` lists modifications only, so a file appears here exactly when more than one
 * commit has touched it — which is exactly when newest-wins and oldest-wins can disagree, and
 * therefore the only kind of file that can test the bulk parse's newest-wins guard. Asking with the
 * same command the parser uses would make the comparison circular.
 */
function modifiedMigrationFileNames(): string[] {
  let out: string;
  try {
    out = execSync('git log --format= --name-only --diff-filter=M -- "supabase/migrations"', {
      cwd: path.join(MIGRATIONS_DIR, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const seen: string[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.endsWith(".sql")) continue;
    const fileName = path.posix.basename(trimmed);
    if (!seen.includes(fileName)) seen.push(fileName);
  }
  return seen;
}

function dollarFault(sql: string): string | null {
  const lineOf = (index: number) => sql.slice(0, index).split("\n").length;
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) { depth += 1; i += 2; continue; }
        if (sql.startsWith("*/", i)) { depth -= 1; i += 2; continue; }
        i += 1;
      }
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (sql[i] === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (!tag) {
        // Not a tag and not a parameter placeholder: outside a block, a bare dollar is the fault.
        if (/^\$[0-9]/.test(sql.slice(i))) { i += 1; continue; }
        return "a lone $ that opens no block, line " + lineOf(i);
      }
      const close = sql.indexOf(tag[0], i + tag[0].length);
      if (close === -1) return tag[0] + " opened at line " + lineOf(i) + " and never closed";
      i = close + tag[0].length;
      continue;
    }
    i += 1;
  }
  return null;
}

export function runStagingMigrationApplierTests() {
  // ── 1. THE TARGET GUARD ────────────────────────────────────────────────────
  // Both connection shapes hide the project ref somewhere different, and the pooler form is the
  // one CI must use (a direct db.<ref>.supabase.co host is IPv6-only; GitHub runners have no
  // IPv6). A guard that reads only one shape would wave the other straight through.
  assert.equal(
    refFromDatabaseUrl(`postgresql://postgres:pw@db.${STAGING}.supabase.co:5432/postgres`),
    STAGING,
    "the direct form hides the ref in the HOST",
  );
  assert.equal(
    refFromDatabaseUrl(`postgresql://postgres.${STAGING}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`),
    STAGING,
    "the pooler form hides the ref in the USERNAME",
  );
  assert.equal(
    refFromDatabaseUrl("postgresql://someone:pw@example.com:5432/postgres"),
    null,
    "a URL with no recognisable ref returns null rather than a guess",
  );

  assert.equal(
    assertStagingTarget(`postgresql://postgres.${STAGING}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`),
    STAGING,
    "staging is accepted, and the guard returns the ref so the run can print what it matched",
  );

  // Production must be refused in BOTH shapes and must be NAMED in the refusal — a misconfigured
  // secret has to read as a mistake, not as a connection problem.
  for (const url of [
    `postgresql://postgres:pw@db.${PRODUCTION}.supabase.co:5432/postgres`,
    `postgresql://postgres.${PRODUCTION}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
  ]) {
    assert.throws(
      () => assertStagingTarget(url),
      /REFUSED[\s\S]*PRODUCTION/,
      "a production URL must be refused by name, in either connection shape",
    );
  }

  // Not merely "not staging": the account can see four Supabase projects and two have nothing to
  // do with this app, so an unfamiliar ref is a misconfiguration and must stop the run.
  assert.throws(
    () => assertStagingTarget("postgresql://postgres.plleofqyfbknvwcotzqo:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres"),
    /REFUSED[\s\S]*not \s*staging/,
    "an unrelated project is refused",
  );
  assert.throws(
    () => assertStagingTarget("postgresql://someone:pw@example.com:5432/postgres"),
    /REFUSED[\s\S]*could not read/,
    "an unidentifiable database is refused rather than tried",
  );

  // There must be no way to talk the guard round. If an override flag is ever added, this fails.
  const guardSource = assertStagingTarget.toString();
  assert.ok(
    !/process\.env/.test(guardSource),
    "the guard must not read an environment variable — an env-var escape hatch is an override",
  );

  // ── 2. THE LEDGER INSERT, AND THE COMMENT THAT WOULD EAT IT ────────────────
  const commentEnded = migration("20260903213000_cv_google_drive_mirror.sql");
  const endsInAComment = "create index if not exists x on t (a);\n-- a trailing note, no semicolon";
  const appended = withLedgerInsert(endsInAComment, commentEnded);

  // THE regression this file exists for. Everything after a `--` on the same line is comment, so
  // if the insert is appended without a newline it is inside that comment: the migration applies,
  // no ledger row is written, and the next run applies it again. Silent, and permanent.
  const insertLine = appended.split("\n").find((line) => line.startsWith("insert into"));
  assert.ok(
    insertLine !== undefined,
    "the ledger insert must start its own line — a file ending in a `--` comment would otherwise swallow it whole",
  );
  assert.ok(
    appended.includes("supabase_migrations.schema_migrations"),
    "the insert targets the migration ledger",
  );

  // The row records the FILE's version and name, not the clock at apply time. That is the whole
  // point: the MCP apply_migration tool stamps a server timestamp instead, which is why staging's
  // ledger holds hundreds of versions matching no filename and why the drift check needs a
  // three-way match at all. Everything this script applies is answered by the cheapest test.
  assert.ok(
    appended.includes("'20260903213000'") && appended.includes("'cv_google_drive_mirror'"),
    "the ledger row carries the file's own version and name",
  );
  assert.ok(
    appended.includes("on conflict (version) do nothing"),
    "re-recording a version must be a no-op, not a primary-key violation",
  );
  // The migration's own SQL must come FIRST. Postgres abandons the rest of a multi-statement
  // simple query at the first error, so this ordering is what makes it impossible for the ledger
  // to record a migration that failed.
  assert.ok(
    appended.indexOf("create index if not exists x") < appended.indexOf("insert into supabase_migrations"),
    "the migration runs BEFORE its ledger row, so a failure can never be recorded as a success",
  );

  // A quote in a name would end the string literal early and turn the rest into syntax. No
  // migration filename contains one today; that is not a reason for the writer to assume it.
  const quoted: LocalMigration = {
    fileName: "20260101000000_o'brien.sql",
    version: "20260101000000",
    name: "o'brien",
    commitTimeMs: null,
  };
  assert.ok(
    withLedgerInsert("select 1;", quoted).includes("'o''brien'"),
    "a single quote in a migration name is escaped, not left to break the statement",
  );

  // ── 3. THE POOLER REWRITE ──────────────────────────────────────────────────
  assert.equal(
    toPooler(`postgresql://postgres:pw@db.${STAGING}.supabase.co:5432/postgres`),
    `postgresql://postgres.${STAGING}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
    "a direct URL is rewritten to the pooler, because a GitHub runner cannot reach an IPv6-only host",
  );
  const alreadyPooled = `postgresql://postgres.${STAGING}:pw@aws-1-eu-north-1.pooler.supabase.com:5432/postgres`;
  assert.equal(
    toPooler(alreadyPooled),
    alreadyPooled,
    "a URL already in pooler form is untouched — the region cannot be derived from the ref, so rewriting one would break it",
  );

  // ── 4. THE GRACE WINDOW, WHICH THE APPLIER MUST IGNORE ─────────────────────
  const now = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04 12:00Z
  const oneHourOld = migration("20260904000000_fresh.sql", now - 60 * 60 * 1000);
  const oneWeekOld = migration("20260828000000_stale.sql", now - 7 * 24 * 60 * 60 * 1000);
  const empty = ledger();

  assert.equal(isWithinGraceWindow(oneHourOld, now), true, "an hour-old migration is inside the window");
  assert.equal(isWithinGraceWindow(oneWeekOld, now), false, "a week-old migration is not");
  assert.equal(
    isWithinGraceWindow(migration("20260904000000_fresh.sql", null), now),
    false,
    "age unknown must not shelter a migration — an unknown age is not a young one",
  );

  // The nightly check: hides the fresh one, reports the stale one. Right for a report.
  assert.deepEqual(
    selectMissingMigrations([oneHourOld, oneWeekOld], empty, { nowMs: now }).map((m) => m.fileName),
    ["20260828000000_stale.sql"],
    "the drift check's grace window hides a migration merged an hour ago — a report should not nag about a fresh merge",
  );

  // The applier: takes both. This is THE difference between the two callers, and the reason the
  // three migrations merged on 2026-09-03 were still missing from staging on 2026-09-04 while the
  // nightly check reported green. If this assertion ever flips, the applier silently stops
  // applying exactly the migrations it was built for.
  assert.deepEqual(
    selectMissingMigrations([oneHourOld, oneWeekOld], empty, { nowMs: now, ignoreGraceWindow: true })
      .map((m) => m.fileName),
    ["20260828000000_stale.sql", "20260904000000_fresh.sql"],
    "the applier ignores the grace window and takes the fresh migration too — it runs ON the merge",
  );

  // Ascending version order, always: migrations are ordered, and one that adds a column the next
  // backfills cannot run second.
  const outOfOrder = [migration("20260904000000_b.sql"), migration("20260101000000_a.sql")];
  assert.deepEqual(
    selectMissingMigrations(outOfOrder, empty, { nowMs: now, ignoreGraceWindow: true }).map((m) => m.version),
    ["20260101000000", "20260904000000"],
    "migrations are applied oldest first, whatever order readdir returned them in",
  );

  // ── 5. WHAT COUNTS AS ALREADY RECORDED ─────────────────────────────────────
  // Three ways, and the applier needs all three or it re-runs migrations that are already live.
  // The name and substring matches carry the weight on staging, whose ledger was written by the
  // MCP tool: it stamps the server clock as the version, so a version match answers for almost
  // nothing there.
  const m = migration("20260830003000_finance_command_center_invoice_overdue.sql");
  assert.equal(isRecorded(m, ledger(["20260830003000"])), true, "an exact version match counts");
  assert.equal(
    isRecorded(m, ledger([], ["finance_command_center_invoice_overdue"])),
    true,
    "an exact name match counts — the MCP tool re-stamps versions, so the name is what survives",
  );
  assert.equal(
    isRecorded(m, ledger([], ["20260830003000_finance_command_center_invoice_overdue"])),
    true,
    "a recorded name CONTAINING the version counts — some ledger rows embed the original filename",
  );
  assert.equal(isRecorded(m, ledger(["20260830003001"], ["something_else"])), false, "a near miss is a miss");

  // An acknowledged exception is never applied, whatever the ledger says. At least one of them
  // would do real damage if re-run: 20260717030000_crm_effective_visit_type_view.sql is a bare
  // `create or replace view`, which strips `security_invoker = true` back off a live view. An
  // applier with its own idea of "missing" would do that on every merge, nightly and unattended.
  assert.deepEqual(
    selectMissingMigrations(
      [migration("20260717030000_crm_effective_visit_type_view.sql")],
      empty,
      { nowMs: now, ignoreGraceWindow: true },
    ),
    [],
    "an acknowledged exception is never selected, even against a completely empty ledger",
  );

  // ── No migration carries a dollar-sign fault ──────────────────────────────────────────────────
  const faults: string[] = [];
  for (const fileName of readdirSync(MIGRATIONS_DIR)) {
    if (!fileName.endsWith(".sql")) continue;
    const fault = dollarFault(readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8"));
    if (fault !== null) faults.push(fileName + ": " + fault);
  }
  assert.deepEqual(
    faults,
    [],
    `these migrations would be refused WHOLE by the applier, which sends one file as one query: ` +
      `${faults.join(", ")}`,
  );

  // ── The commit-age lookup is ONE git process, and it still gives the per-file answer ──────────
  //
  // 🔴 THIS IS WHAT CANCELLED THE NIGHTLY DRIFT CHECK ON 2026-10-10 AND 2026-10-12. The lookup used
  // to be one `git log` process PER migration file. Nothing capped the cost and it grows with the
  // directory: 410 files when the comment above it shrugged that off as "minutes rather than
  // seconds", 855 files when it measured 4m34s per leg on a GitHub runner — and
  // migration-drift-check.yml drives it TWICE, once per database, inside what was a 10-minute job.
  // Both runs hit 10m07s, GitHub cancelled them at the wall, and a cancelled check suite on `main`
  // HEAD withholds that commit's production deploy for ever. Every leg had in fact finished and
  // reported; only the run's conclusion was lost.
  //
  // So the bulk pass is now load-bearing, and these two assertions are what keep it honest. The
  // coverage floor catches a parse that returns an empty or partial map (drop the `%ct` branch, or
  // the `.sql` filter, and it collapses). The equivalence sample catches a parse that returns the
  // WRONG time — remove the `if (!out.has(fileName))` guard and the oldest commit wins instead of
  // the newest, which would silently shelter nothing and flag migrations merged minutes ago.
  //
  // A SAMPLE, not every file, and that is the point rather than a shortcut: the comparison has to
  // run the slow path it is checking, and paying 855 git processes inside the required `validate`
  // job would put the cost straight back into the one place that gates every merge.
  //
  // 🔴 AND THE SAMPLE IS CHOSEN, NEVER SPREAD EVENLY — THE EVEN SPREAD WAS VACUOUS AND ONLY THE
  // BREAK TEST SHOWED IT. Newest-wins and oldest-wins give the SAME answer for a file touched by
  // one commit, and only 33 of the 864 migrations on disk have ever been modified after they were
  // added. A 24-file even stride hit ZERO of them: with the `!out.has` guard deleted — the exact
  // defect this assertion exists to catch — the suite stayed green. So the sample is built from the
  // files that CAN disagree, found with a second, independent git query (`--diff-filter=M`, which
  // lists modifications only and is not the production parser's command), and the floor below
  // refuses to pass if that set comes back empty.
  const modifiedAfterAdd = modifiedMigrationFileNames();
  assert.ok(
    modifiedAfterAdd.length > 0,
    `no migration file reports a post-add modification, so every candidate in the sample below is a ` +
      `single-commit file where newest-wins and oldest-wins agree — the commit-time comparison would be ` +
      `vacuous. Either the \`--diff-filter=M\` query has stopped matching, or git history is unavailable.`,
  );

  const bulkTimes = commitTimesByFileNameForTests();
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  assert.ok(
    bulkTimes.size > onDisk.length * 0.9 && bulkTimes.size > 100,
    `the single-pass commit-time map covers ${bulkTimes.size} of ${onDisk.length} migration files on disk. ` +
      `Below 90% the bulk \`git log --format=%ct --name-only\` parse in loadCommitTimesByFileName has stopped ` +
      `matching, which gives every file "age unknown" — and that switches the 48h grace window OFF, so the ` +
      `nightly drift check flags migrations merged minutes ago.`,
  );

  const withTimes = loadLocalMigrations();
  const byName = new Map(withTimes.map((m) => [m.fileName, m]));
  // The files that can disagree come first and in full, then a spread of the single-commit ones so
  // the parse is exercised across the whole directory rather than only its oldest corner.
  const sample = modifiedAfterAdd.filter((f) => byName.has(f));
  const singles = withTimes.filter((m) => !sample.includes(m.fileName));
  const stride = Math.max(1, Math.ceil(singles.length / 12));
  for (let i = 0; i < singles.length; i += stride) sample.push(singles[i].fileName);

  const mismatches: string[] = [];
  for (const fileName of sample) {
    const slow = commitTimeMsForOneFileSlowly(fileName);
    const bulk = byName.get(fileName)?.commitTimeMs ?? null;
    if (slow !== bulk) mismatches.push(`${fileName}: one-pass ${bulk} vs per-file ${slow}`);
  }
  assert.ok(
    sample.length >= 20,
    `expected to sample at least twenty migrations for the commit-time comparison, sampled ${sample.length}`,
  );
  assert.deepEqual(
    mismatches,
    [],
    `the one-pass commit-time map disagrees with \`git log -1 --format=%ct\` on these files: ${mismatches.join("; ")}. ` +
      `The bulk pass must give exactly the per-file answer — it IS the grace window's input, and a wrong age ` +
      `either shelters real drift or flags a migration merged minutes ago.`,
  );
}
