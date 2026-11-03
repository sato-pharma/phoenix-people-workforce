import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCTION_REF,
  STAGING_REF,
  TABLES,
  assertDirection,
  dependencyOrderProblems,
  refOf,
} from "../scripts/sync-staging-hr.mjs";

/**
 * scripts/sync-staging-hr.mjs copies HR and org rows from PRODUCTION into STAGING.
 *
 * It exists because staging silently falls behind: on 2026-09-29 it was missing 19 employees, 13
 * resignations, 36 occupancy rows, 4 line-area rows, 2 areas, 5 teams and a position — enough
 * that a dated territory migration failed its own precondition on staging while succeeding on
 * production, and enough that any staging rehearsal of payroll or org behaviour was running
 * against a different company.
 *
 * Everything below is checkable with no database. What it guards is the two ways this script
 * could do real damage — writing the wrong way round, and deleting rows — plus the ordering the
 * whole copy depends on.
 */
export function runStagingHrSyncTests() {
  const source = readFileSync(new URL("../scripts/sync-staging-hr.mjs", import.meta.url), "utf8");

  // 0. THE RUNNER READS THE ENVIRONMENT. On GitHub the secrets arrive in `env:` and there is no env
  //    file, so a script that reads only the files fails every night before it compares a row. Both
  //    database steps of the nightly check are held to it: this one and the backup schema audit.
  for (const script of ["sync-staging-hr", "audit-backup-schemas"]) {
    const text = readFileSync(new URL(`../scripts/${script}.mjs`, import.meta.url), "utf8");
    const reader = text.slice(text.indexOf("function envVar(name)"), text.indexOf("for (const file of ENV_FILES)"));
    assert.ok(
      reader.includes("if (process.env[name]) return process.env[name];"),
      `${script}.mjs must read the environment before the env files, or the nightly check dies on the runner`,
    );
  }

  // 1. THE DIRECTION GUARD. One edited env file is all it takes to point this at production, and
  //    every statement in the script is legal SQL against either database — nothing else would
  //    notice. These refs are the only thing standing in the way.
  const prodUrl = `postgresql://postgres:pw@db.${PRODUCTION_REF}.supabase.co:5432/postgres`;
  const stgUrl = `postgresql://postgres:pw@db.${STAGING_REF}.supabase.co:5432/postgres`;
  assert.doesNotThrow(() => assertDirection(prodUrl, stgUrl), "production -> staging must be allowed");

  assert.throws(
    () => assertDirection(prodUrl, prodUrl),
    /REFUSING TO WRITE/,
    "PRODUCTION AS THE TARGET MUST BE REFUSED — this is the one that would overwrite real payroll",
  );
  assert.throws(
    () => assertDirection(stgUrl, stgUrl),
    /source is not production/,
    "staging as the source must be refused",
  );
  assert.throws(
    () => assertDirection(stgUrl, prodUrl),
    /source is not production/,
    "the reversed direction must be refused",
  );
  assert.throws(
    () => assertDirection(prodUrl, `postgresql://postgres:pw@db.plleofqyfbknvwcotzqo.supabase.co:5432/postgres`),
    /REFUSING TO WRITE/,
    "an unrelated project (Future Talents Hub) must be refused as the target",
  );

  // The pooler form carries the ref in the username instead — both spellings must resolve, or
  // the guard silently passes on a URL it cannot read.
  assert.equal(refOf(prodUrl), PRODUCTION_REF, "the direct db.<ref> form must resolve");
  assert.equal(
    refOf(`postgresql://postgres.${STAGING_REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`),
    STAGING_REF,
    "the pooler postgres.<ref> form must resolve",
  );
  assert.equal(refOf("postgresql://postgres:pw@localhost:5432/postgres"), null, "an unrecognised URL must resolve to null, not a guess");

  // 2. FK DEPENDENCY ORDER. A child copied before its parent fails on a foreign key mid-run.
  assert.deepEqual(
    dependencyOrderProblems(),
    [],
    "every table must be synced after the tables it depends on",
  );
  // Negative control: the checker must actually be able to fail, or assertion 2 proves nothing.
  assert.ok(
    dependencyOrderProblems([...TABLES].reverse()).length > 0,
    "dependencyOrderProblems must detect a violation — otherwise the check above is vacuous",
  );
  // The two tables whose ordering caused real failures while this was built by hand.
  const order = TABLES.map((t) => `${t.schema}.${t.table}`);
  assert.ok(
    order.indexOf("public.teams") < order.indexOf("public.employees"),
    "teams must precede employees — an employee's team_id FK fails otherwise (it did)",
  );
  assert.ok(
    order.indexOf("au.seats") < order.indexOf("au.occupancy_history"),
    "seats must precede occupancy_history — occupancy rows carry a seat_id FK",
  );

  // 3. IT MUST NEVER DELETE. Staging-only rows are reported and kept; a sync that deletes is a
  //    sync that can destroy work nobody copied to production yet.
  assert.doesNotMatch(
    source,
    /\b(delete from|truncate)\b/i,
    "the sync must never DELETE or TRUNCATE from the synced tables — staging-only rows are kept",
  );
  assert.match(
    source,
    /STAGING-ONLY, left alone/,
    "staging-only rows must be reported so they are visible rather than silently ignored",
  );
  // The one drop/create pair that IS allowed is the deferred unique index, and it must be put
  // back in the same transaction — the rebuild is what proves the end state is legal.
  assert.match(source, /drop index au\.occupancy_open_span/, "the open-span index is dropped for the transaction");
  assert.match(source, /create unique index occupancy_open_span/, "…and MUST be rebuilt before commit");

  // 4. TRIGGERS OFF, FOREIGN KEYS ON. employees auto-fills a vacant seat on insert and writes its
  //    own occupancy_history row; left enabled, staging gets production's history plus a second
  //    invented set. But foreign keys must stay enforced — they are what catches a bad copy.
  assert.match(source, /disable trigger user/, "user triggers must be suspended for the copy");
  assert.match(source, /enable trigger user/, "…and restored before commit");
  assert.doesNotMatch(
    source,
    /session_replication_role/,
    "must not use session_replication_role — it would disable FOREIGN KEY checks too, removing "
      + "the one guard that catches a copy in the wrong order",
  );

  // 5. THE SCHEDULED ALARM MUST NOT WITHHOLD PRODUCTION DEPLOYS.
  //
  //    A scheduled workflow's check suite attaches to whatever commit is main HEAD when it
  //    fires, and Railway withholds a production deploy when ANY suite on that commit fails
  //    (AGENTS.md 2.3). This check reports an EXPECTED, RECURRING condition — staging falls
  //    behind whenever anyone is hired, resigns or changes seat — so if it failed on drift it
  //    would withhold deploys on most days. That is not hypothetical: on 2026-09-28 commit
  //    cd9e0be03 was green on ci.yml and its deploy was still SKIPPED, because the only red
  //    suite on it was a drift check's own alarm.
  const workflow = readFileSync(
    new URL("../.github/workflows/staging-hr-drift-check.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    workflow,
    /^\s*(push|pull_request):/m,
    "the drift check must be schedule-only — a per-commit run multiplies the deploy-gate exposure "
      + "and tells you nothing a daily run does not",
  );
  assert.match(workflow, /^\s*schedule:/m, "…and it must actually be scheduled");
  // Exit 2 is "drift found" and must become an output, never a failed step.
  assert.match(
    workflow,
    /if \[ "\$code" = "2" \]; then\s*\n\s*echo "drifted=true"/,
    "exit 2 (drift found) must be recorded as an output, NOT failed — a red suite here withholds "
      + "the production deploy of whatever commit is main HEAD at the time",
  );
  assert.match(
    workflow,
    /continue-on-error: true/,
    "the Telegram step must not be able to turn a Telegram outage into the red suite described above",
  );
  // A broken alarm IS worth failing on — the one state this workflow must never hide.
  assert.match(
    workflow,
    /the drift check could not run/,
    "a real error (bad credentials, unreachable database) must fail loudly rather than read as 'in sync'",
  );
  // It runs the dry run. If it ever gained --apply it would become an unattended overwrite of
  // staging, which the owner explicitly did not want (2026-09-29).
  assert.match(workflow, /node scripts\/sync-staging-hr\.mjs \| tee/, "the scheduled job runs the DRY RUN");
  // Only an INVOCATION counts: the workflow names `--apply` twice on purpose, in the comment and
  // in the alert text, because telling the reader how to fix the drift is the point of the
  // alert. A command is a line that starts with `node …`; "Fix: node …" inside the message body
  // is not one.
  const invokesApply = workflow.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("#")) return false;
    return /^node\s+scripts\/sync-staging-hr\.mjs\b.*--apply/.test(t);
  });
  assert.deepEqual(
    invokesApply,
    [],
    "the scheduled job must NEVER run --apply — an unattended overwrite would destroy staging "
      + "state somebody set up for testing (owner's decision, 2026-09-29)",
  );

  // 6. Dry run is the default. --apply is the only way to write.
  assert.match(source, /const apply = process\.argv\.includes\("--apply"\)/, "writing must be opt-in via --apply");
  assert.match(source, /DRY RUN — nothing written/, "a dry run must say plainly that it wrote nothing");
  // Pre-images before any write, so a bad run is recoverable.
  assert.ok(
    source.indexOf("pre-images into staging_reconcile_backup_") < source.indexOf("writing (one transaction)"),
    "pre-images must be taken BEFORE the transaction that writes",
  );
}
