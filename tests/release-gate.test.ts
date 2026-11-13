import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  clearReleaseGateCache,
  evaluateReleaseGate,
  resolveReleaseGateScope,
} from "../src/lib/platform/release-gate.ts";
import { stripComments, stripHashComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * THE RELEASE GATE (owner, 2026-10-19; docs/deployment.md, "The release gate").
 *
 * Railway's Wait for CI is switched off so a commit's build starts the moment it lands, beside the checks.
 * That is safe ONLY while a new production container cannot take traffic before CI has passed, and every
 * piece of that promise fails silently if it is lost:
 *
 *   1. The decision. A production container with no row for its commit, or with no commit at all, is NOT ready; a container that is
 *      not production Railway is never held; only the exact word `off` switches it off; an unreadable
 *      table is closed, never open; a released commit is remembered, a missing one is asked again.
 *   2. The probe. /api/readyz ANDs the gate into `ready`. A probe that computed the gate and then ignored
 *      it would pass every build and look healthy.
 *   3. The writer. ci.yml's `release-gate` job runs on a push to main only, needs exactly `checks` (lint,
 *      typecheck and the suite; the CI build left the gate on 2026-11-04 and Telegrams him when red instead),
 *      uses the narrow gate login, fails loud, and checks the row reads back.
 *   4. The table. Row level security on, nothing granted to the browser roles, the sha constrained to a full
 *      commit, nothing in the file that deletes a row.
 *   5. The window. The healthcheck is long enough to outlast a slow day of CI, in the file Railway reads and
 *      in the authoring file.
 *
 * Source pins read the file with its comments stripped, because the headers above each of these say the
 * very words the pins refuse.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PRODUCTION = { RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_GIT_COMMIT_SHA: SHA };

type Counter = { calls: number; hasRecord: (sha: string) => Promise<boolean> };

function reader(answer: boolean | Error, seen: string[] = []): Counter {
  const counter: Counter = {
    calls: 0,
    hasRecord: async (sha: string) => {
      counter.calls += 1;
      seen.push(sha);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return counter;
}

/** One job's lines, from `  <name>:` to the next job at the same indent. */
function jobBlock(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `ci.yml has no \`${name}\` job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export async function runReleaseGateTests(): Promise<void> {
  // ── 1. The decision ──────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(resolveReleaseGateScope(PRODUCTION, null), { required: true, sha: SHA, malformed: false });
  assert.deepEqual(
    resolveReleaseGateScope({ ...PRODUCTION, RAILWAY_ENVIRONMENT_NAME: "  Production " }, null),
    { required: true, sha: SHA, malformed: false },
    "the environment name is trimmed and case-folded, so a stray space cannot switch the gate off",
  );
  assert.deepEqual(
    resolveReleaseGateScope({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_GIT_COMMIT_SHA: SHA.toUpperCase() }, null),
    { required: true, sha: SHA, malformed: false },
    "an upper-case sha is folded to the lower-case one CI records",
  );

  for (const environment of ["staging", "development", "", undefined]) {
    assert.deepEqual(
      resolveReleaseGateScope({ RAILWAY_ENVIRONMENT_NAME: environment, RAILWAY_GIT_COMMIT_SHA: SHA }, null),
      { required: false, reason: "not_production_railway" },
      `environment ${JSON.stringify(environment)} is never held: nothing writes a row for it`,
    );
  }
  assert.deepEqual(resolveReleaseGateScope({}, null), { required: false, reason: "not_production_railway" }, "a laptop or CI has no Railway environment");

  assert.deepEqual(
    resolveReleaseGateScope(PRODUCTION, SHA),
    { required: false, reason: "urgent_upload" },
    "the urgent `railway up` route carries no git sha and skips the checks by the owner's own words, so it is never held",
  );
  assert.deepEqual(
    resolveReleaseGateScope({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_GIT_COMMIT_SHA: undefined }, SHA),
    { required: false, reason: "urgent_upload" },
    "the urgent route is recognised by its marker BEFORE the missing commit is looked at — it never relied on no_commit",
  );
  // 🔴 FAIL CLOSED ON A MISSING COMMIT (audit P6-03 / D-03, 2026-10-23). Production with no commit and no urgent
  // marker used to be `required: false` — a hand `railway up`, or an image that lost its ENV layer, took traffic
  // with no checks at all. Nothing CI records can ever match it, so it is held.
  assert.deepEqual(
    resolveReleaseGateScope({ RAILWAY_ENVIRONMENT_NAME: "production" }, null),
    { required: true, sha: null, reason: "no_commit" },
    "🔴 production with no commit must be REQUIRED — an open gate here ships unchecked code",
  );
  assert.deepEqual(
    resolveReleaseGateScope({ ...PRODUCTION, RAILWAY_GIT_COMMIT_SHA: "  " }, null),
    { required: true, sha: null, reason: "no_commit" },
    "a blank commit is no commit",
  );
  clearReleaseGateCache();
  const neverAsked = reader(true);
  assert.deepEqual(
    await evaluateReleaseGate({ env: { RAILWAY_ENVIRONMENT_NAME: "production" }, urgentRevision: null, hasRecord: neverAsked.hasRecord }),
    { required: true, passed: false, reason: "no_commit", sha: null },
    "🔴 /api/readyz must answer NOT ready, reason no_commit, for a production container with no commit",
  );
  assert.equal(neverAsked.calls, 0, "with no commit there is nothing to look up — the answer is closed without a read");
  assert.deepEqual(
    resolveReleaseGateScope({ ...PRODUCTION, RAILWAY_GIT_COMMIT_SHA: "abc1234" }, null),
    { required: true, sha: "abc1234", malformed: true },
    "a short commit can never match a row, and that is closed, not open",
  );

  // Only the exact word `off` is the emergency switch. Every other value, including the ones that look like
  // "off", leaves the gate ON, because a typo must never be the reason production loses its gate.
  for (const off of ["off", "OFF", " Off "]) {
    assert.deepEqual(
      resolveReleaseGateScope({ ...PRODUCTION, PHOENIX_RELEASE_GATE: off }, null),
      { required: false, reason: "switched_off" },
      `PHOENIX_RELEASE_GATE=${JSON.stringify(off)} switches the gate off`,
    );
  }
  for (const stillOn of ["", "0", "false", "no", "disabled", "of", "on", "1", undefined]) {
    assert.equal(
      resolveReleaseGateScope({ ...PRODUCTION, PHOENIX_RELEASE_GATE: stillOn }, null).required,
      true,
      `PHOENIX_RELEASE_GATE=${JSON.stringify(stillOn)} must NOT switch the gate off`,
    );
  }

  // A row present: released, and remembered.
  clearReleaseGateCache();
  const present = reader(true);
  assert.deepEqual(await evaluateReleaseGate({ env: PRODUCTION, urgentRevision: null, hasRecord: present.hasRecord }), {
    required: true,
    passed: true,
    reason: "recorded",
    sha: SHA,
  });
  await evaluateReleaseGate({ env: PRODUCTION, urgentRevision: null, hasRecord: present.hasRecord });
  assert.equal(present.calls, 1, "a released commit is asked about once per process — a row is never deleted");

  // No row yet: NOT released, and asked again next time, so the probe passes the moment CI writes it.
  clearReleaseGateCache();
  const absentThenPresent: string[] = [];
  const absent = reader(false, absentThenPresent);
  const waiting = await evaluateReleaseGate({ env: PRODUCTION, urgentRevision: null, hasRecord: absent.hasRecord });
  assert.deepEqual(waiting, { required: true, passed: false, reason: "not_recorded", sha: SHA });
  await evaluateReleaseGate({ env: PRODUCTION, urgentRevision: null, hasRecord: absent.hasRecord });
  assert.equal(absent.calls, 2, "a missing row is never cached as missing");
  assert.deepEqual(absentThenPresent, [SHA, SHA], "the reader is asked about the container's own commit");
  const nowPresent = reader(true);
  assert.equal((await evaluateReleaseGate({ env: PRODUCTION, urgentRevision: null, hasRecord: nowPresent.hasRecord })).passed, true);

  // An unreadable table is closed.
  clearReleaseGateCache();
  const broken = reader(new Error("supabase unreachable"));
  assert.deepEqual(await evaluateReleaseGate({ env: PRODUCTION, urgentRevision: null, hasRecord: broken.hasRecord }), {
    required: true,
    passed: false,
    reason: "unreadable",
    sha: SHA,
  });

  // A gate that does not apply never touches the database, and a malformed commit never reaches it either.
  clearReleaseGateCache();
  for (const [env, urgent] of [
    [{ RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_GIT_COMMIT_SHA: SHA }, null],
    [PRODUCTION, SHA],
    [{ ...PRODUCTION, PHOENIX_RELEASE_GATE: "off" }, null],
    [{ ...PRODUCTION, RAILWAY_GIT_COMMIT_SHA: "short" }, null],
    [{ RAILWAY_ENVIRONMENT_NAME: "production" }, null],
  ] as const) {
    const untouched = reader(true);
    const decision = await evaluateReleaseGate({ env, urgentRevision: urgent, hasRecord: untouched.hasRecord });
    assert.equal(untouched.calls, 0, `no read for ${JSON.stringify(decision.reason)}`);
    const closed = decision.reason === "malformed_commit" || decision.reason === "no_commit";
    assert.equal(decision.passed, !closed, `${decision.reason}: passes unless the commit is malformed or missing`);
  }

  // ── 2. The probe ANDs the gate into `ready` ──────────────────────────────────────────────────────
  const readyz = stripComments(readFileSync("app/api/readyz/route.ts", "utf8"));
  assert.match(
    readyz,
    /const ready = [^;]*releaseGate\.passed/,
    "🔴 /api/readyz no longer includes releaseGate.passed in `ready` — the probe would pass every build before CI does",
  );
  assert.match(readyz, /evaluateReleaseGate\(/, "readyz does not evaluate the gate");
  assert.match(readyz, /releaseGateHasRecord/, "readyz does not read the gate from the table");
  assert.match(
    readyz,
    /catch \{\s*releaseGate = \{ required: true, passed: false, reason: "unreadable"/,
    "a gate that cannot be evaluated in time must be the CLOSED answer",
  );
  const gateModule = stripComments(readFileSync("src/lib/platform/release-gate.ts", "utf8"));
  assert.doesNotMatch(gateModule, /process\.env/, "release-gate.ts is pure: the environment is passed in");
  assert.doesNotMatch(gateModule, /\bimport\b/, "release-gate.ts stays import-free so every branch tests without a database");

  // ── 3. The writer ────────────────────────────────────────────────────────────────────────────────
  const workflow = stripHashComments(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = jobBlock(workflow, "release-gate");
  // Owner, 2026-11-04 ("Tests only"): the gate waits for lint, typecheck and the suite, not the CI build,
  // which Railway duplicates. validate still runs on main and Telegrams him when red.
  assert.match(job, /^\s*needs:\s*\[\s*checks\s*\]\s*$/m, "🔴 release-gate must need EXACTLY `checks` — lint, typecheck and the whole suite");
  assert.doesNotMatch(job, /\bvalidate\b/, "🔴 the CI build no longer holds the deploy (owner, 2026-11-04) — never put validate back without his word");
  const validateJob = jobBlock(workflow, "validate");
  assert.match(
    validateJob,
    /- name: Tell the owner main's build or login test is red\s*\n\s*if: \$\{\{ failure\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/,
    "🔴 with validate out of the gate, a red build or login test on main must still reach him",
  );
  assert.match(validateJob, /api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/sendMessage/, "the red-main alarm sends through Telegram");
  assert.doesNotMatch(job, /\bmobile\b|\bfull-e2e\b/, "mobile and the manual E2E never gated a merge, so they must not gate a deploy");
  assert.match(
    job,
    /^\s*if:\s*\$\{\{\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s*\}\}\s*$/m,
    "🔴 release-gate runs on a push to main ONLY — a dispatch or a PR must never mint a row",
  );
  assert.doesNotMatch(job, /continue-on-error/, "🔴 the gate fails loud: continue-on-error would let a commit with no row look green");
  // Least privilege (audit P6-02, owner 2026-10-23): the row is written by the release_gate_writer login,
  // which may read and add release_gates rows and nothing else — never the full service-role key.
  assert.match(job, /secrets\.RELEASE_GATE_DATABASE_URL/, "release-gate connects with the narrow release_gate_writer login");
  assert.doesNotMatch(job, /SERVICE_ROLE/, "🔴 release-gate must not hold the production service-role key — it can read and change every table");
  assert.match(job, /insert into public\.release_gates \(sha, workflow_run_id\)[\s\S]*?on conflict \(sha\) do nothing/, "release-gate adds the row, and a re-run of the same commit is not an error");
  assert.match(job, /values \(:'sha', :'run_id'\)/, "the sha and run id reach SQL as psql variables, never pasted into the statement");
  assert.match(job, /-v ON_ERROR_STOP=1/, "a failed statement must make psql exit non-zero");
  assert.match(job, /select sha from public\.release_gates where sha = :'sha'/, "release-gate must read the row back — the write is not the proof");
  const writerMigration = readFileSync("supabase/migrations/20261023093100_release_gate_writer_login.sql", "utf8");
  assert.match(writerMigration, /grant select, insert on public\.release_gates to release_gate_writer;/, "the login may read and add gate rows");
  assert.doesNotMatch(stripSqlComments(writerMigration), /\bpassword\s+'|grant (update|delete|all)/i, "🔴 the login gets no password in git and no update or delete right");
  assert.match(job, /exit 1/, "release-gate must exit non-zero when it cannot record the row");
  for (const required of ["validate", "checks"]) {
    assert.match(workflow, new RegExp(`^  ${required}:\\s*$`, "m"), `ci.yml lost the required job \`${required}\` the gate depends on`);
  }
  assert.match(
    readFileSync(".github/workflows/ci.yml", "utf8"),
    /^ {2}push:\s*\n {4}branches:\s*\n {6}- main/m,
    "the push trigger on main is what writes the row",
  );

  // ── 4. The table ─────────────────────────────────────────────────────────────────────────────────
  const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith("_release_gates.sql"));
  assert.equal(migrations.length, 1, "exactly one migration creates release_gates");
  const sql = stripSqlComments(readFileSync(`supabase/migrations/${migrations[0]}`, "utf8")).toLowerCase();
  assert.match(sql, /create table if not exists public\.release_gates/);
  assert.match(sql, /alter table public\.release_gates enable row level security/, "release_gates must have row level security on");
  assert.match(sql, /revoke all on public\.release_gates from anon, authenticated/, "the browser roles get nothing");
  assert.doesNotMatch(sql, /grant [^;]*to [^;]*\b(anon|authenticated)\b/, "nothing is granted to a browser role");
  assert.match(sql, /sha ~ '\^\[0-9a-f\]\{40\}\$'/, "the sha is constrained to a full lower-case commit");
  assert.doesNotMatch(sql, /\bdelete\b|\btruncate\b|\bdrop table\b/, "a gate row is never pruned: a restart weeks later asks again");

  // ── 5. The window ────────────────────────────────────────────────────────────────────────────────
  const iac = readFileSync(".railway/railway.ts", "utf8");
  const iacWindows = [...iac.matchAll(/healthcheckTimeout:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(iacWindows.length, 3, "the authoring file carries the window for the app, the worker and the robot service");
  for (const seconds of iacWindows) {
    assert.ok(seconds >= 600, `🔴 .railway/railway.ts healthcheckTimeout is ${seconds}s — the release gate needs the window to outlast a slow day of CI`);
  }
}
