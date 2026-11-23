// bash-guard C22 — a `gh pr merge` of a Phoenix PR carrying a migration production does not have must be
// REFUSED, and one whose migrations are on production (or acknowledged) must go straight through.
//
// WHY THIS EXISTS (2026-11-21). Four PRs merged on 19 Nov with their money functions on staging only;
// the live code called functions production did not have, and on 21 Nov at 22:11 Cairo the owner's bulk
// approval of outstation claims failed for seven people with PGRST202. The nightly drift check gives a
// merged migration 48 hours on purpose, so it spoke only that afternoon. C22 asks at the merge.
//
// Three layers, each of which a regression would have to get past:
//   1. the pure pieces of scripts/migration-merge-gate.mjs: which files are migrations, the
//      ACKNOWLEDGED_EXCEPTIONS parse (against the REAL list, so a reshaped list is caught), the verdict
//      with the drift check's own `isRecorded`;
//   2. the production-ledger read, with a fake fetch: it pages, it refuses a URL that is not production's
//      ref, an HTTP error and an empty ledger;
//   3. the REAL hook as a subprocess, with a `gh` shim on PATH and a staging URL in its environment, so the
//      ledger read is refused before any network: an acknowledged file passes on the head's list alone, an
//      unacknowledged one is refused as unreadable (fails CLOSED), and the stand-down works.

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PRODUCTION_REF,
  acknowledgedExceptions,
  decodeContents,
  describeMigrationVerdict,
  loadIsRecorded,
  migrationMergeVerdict,
  prMigrationFiles,
  readProductionLedger,
} from "../scripts/migration-merge-gate.mjs";
import { envWithPathFirst } from "./support/path-env.ts";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");
const SHA = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = "sato-pharma/phoenix-people-workforce";
const STAGING_URL = "https://cifwmndunmlxjhyjugxa.supabase.co";
const PRODUCTION_URL = `https://${PRODUCTION_REF}.supabase.co`;

type Decision = { decision: "allow" | "deny"; reason: string };

/** A `gh` on PATH answering by the first key its arguments contain; `null` or no match exits 1. */
function ghShim(dir: string, answers: Array<[string, string | null]>): string {
  const binDir = mkdtempSync(join(dir, "bin-"));
  writeFileSync(join(binDir, "answers.json"), JSON.stringify(answers), "utf8");
  writeFileSync(
    join(binDir, "gh.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "answers.json"), "utf8"));',
      'const args = process.argv.slice(2).join(" ");',
      "const hit = table.find(([key]) => args.includes(key));",
      "if (!hit || hit[1] === null) process.exit(1);",
      "process.stdout.write(hit[1]);",
    ].join("\n"),
    "utf8",
  );
  const sh = join(binDir, "gh");
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "$(dirname "$0")/gh.mjs" "$@"\n`, "utf8");
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* Windows has no execute bit; the .cmd below is what runs there */
  }
  writeFileSync(join(binDir, "gh.cmd"), `@"${process.execPath}" "%~dp0gh.mjs" %*\r\n`, "utf8");
  return binDir;
}

/** An inventory file whose ACKNOWLEDGED_EXCEPTIONS holds `entries`, base64 as GitHub's contents API gives it. */
function inventoryContents(entries: string[]): string {
  const text = [
    "export const ACKNOWLEDGED_EXCEPTIONS = new Set<string>([",
    "  // Verified: a comment naming 20990101000000_in_a_comment.sql is not an entry.",
    ...entries.map((e) => `  "${e}",`),
    "]);",
    "",
  ].join("\n");
  // Wrapped at 60 characters, as GitHub sends it.
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,60}/g) ?? []).join("\n");
}

type ListedFile = { filename: string; status: string; patch?: string };

function fileLines(files: ListedFile[]): string {
  return files.map((f) => JSON.stringify(f)).join("\n");
}

/**
 * A file list the size GitHub really sends: every entry carries its patch, so the answer passes node's
 * default 1 MB of stdout (PR 699: 109 files, 1,089,812 bytes). `last` goes at the END, past the megabyte.
 */
function longFileList(last: ListedFile[]): ListedFile[] {
  const patch = "+ a changed line of a real patch\n".repeat(160);
  const filler = Array.from({ length: 300 }, (_, i) => ({ filename: `src/lib/module-${i}/file.ts`, status: "modified", patch }));
  return [...filler, ...last];
}

function answers(files: ListedFile[] | null, acknowledged: string[]): Array<[string, string | null]> {
  return [
    ["/files", files === null ? null : fileLines(files)],
    ["headRefOid,baseRefName", JSON.stringify({ headRefOid: SHA, baseRefName: "main" })],
    [`contents/scripts/lib/migration-inventory.ts?ref=${SHA}`, inventoryContents(acknowledged)],
  ];
}

function runGuard(cwd: string, command: string, ghDir: string, extra: Record<string, string> = {}): Decision {
  const env = envWithPathFirst(process.env, ghDir);
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_MIGRATION_MERGE_OK;
  // C21 has its own file; C10 and C13 stand aside at a zero file minimum. Every answer below is C22's.
  env.PHX_RED_MERGE_OK = "1";
  env.PHX_MERGE_MIN_FILES = "0";
  // A STAGING URL: the ledger read must refuse it before any network, which is what lets this run
  // offline and proves the read is answered by production only.
  env.NEXT_PUBLIC_SUPABASE_URL = STAGING_URL;
  env.SUPABASE_SERVICE_ROLE_KEY = "test-key-not-real";
  Object.assign(env, extra);
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
  const start = raw.indexOf('{"hookSpecificOutput"');
  if (start < 0) return { decision: "allow", reason: "" };
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

const MIG = "20261119132423_outstation_accept_claim_for_payroll_atomically.sql";

async function pureCases(): Promise<void> {
  const files = prMigrationFiles([
    { filename: `supabase/migrations/${MIG}`, status: "added" },
    { filename: "supabase/migrations/20261119000000_dropped.sql", status: "removed" },
    { filename: "supabase/_migrations_archive/20250101000000_old.sql", status: "added" },
    { filename: "supabase/scripts/one_off.sql", status: "added" },
    { filename: "supabase/migrations/README.md", status: "modified" },
    { filename: "supabase/migrations/20261120000000_renamed.sql", status: "renamed" },
  ]);
  assert.deepEqual(
    files.map((f) => f.fileName),
    [MIG, "20261120000000_renamed.sql"],
    "only an added, changed or renamed file directly in supabase/migrations/ is a migration; a removed one is not judged",
  );
  assert.deepEqual(files[0], { fileName: MIG, version: "20261119132423", name: "outstation_accept_claim_for_payroll_atomically" });

  // The REAL list parses, and to more than a handful — a reshaped list must not read as an empty one.
  const real = acknowledgedExceptions(readFileSync(resolve("scripts/lib/migration-inventory.ts"), "utf8"));
  assert.ok(real && real.size >= 70, `the real ACKNOWLEDGED_EXCEPTIONS must parse (got ${real?.size ?? "null"})`);
  assert.ok(real.has(MIG), "the 21 Nov apply of the accept function is acknowledged on main");
  assert.equal(acknowledgedExceptions("export const SOMETHING_ELSE = 1;"), null, "a missing list is null, never an empty set");
  const parsed = acknowledgedExceptions(decodeContents(inventoryContents(["20261101000000_a.sql"])));
  assert.deepEqual([...(parsed ?? [])], ["20261101000000_a.sql"], "a file named only in a comment is not an entry");

  const isRecorded = await loadIsRecorded();
  const ledger = {
    versions: new Set(["20261101000000"]),
    names: new Set(["a_name_applied_through_the_mcp", "20261103000000_filename_as_name"]),
  };
  const verdict = migrationMergeVerdict({
    migrations: prMigrationFiles([
      { filename: "supabase/migrations/20261101000000_by_version.sql", status: "added" },
      { filename: "supabase/migrations/20261102000000_a_name_applied_through_the_mcp.sql", status: "added" },
      { filename: "supabase/migrations/20261103000000_filename_as_name.sql", status: "added" },
      { filename: "supabase/migrations/20261104000000_acknowledged.sql", status: "added" },
      { filename: "supabase/migrations/20261105000000_never_applied.sql", status: "added" },
    ]),
    acknowledged: new Set(["20261104000000_acknowledged.sql"]),
    ledger,
    isRecorded,
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ["20261105000000_never_applied.sql"]);
  assert.deepEqual(verdict.acknowledged, ["20261104000000_acknowledged.sql"]);
  assert.equal(verdict.applied.length, 3, "recorded by version, by name, and by the version inside a name — the drift check's three ways");
  assert.match(describeMigrationVerdict(verdict), /^not on production: 20261105000000_never_applied\.sql; already applied: /);

  const none = migrationMergeVerdict({ migrations: [], acknowledged: new Set(), ledger: null, isRecorded });
  assert.equal(none.ok, true, "a PR with no migration has nothing to wait for");
}

async function ledgerCases(): Promise<void> {
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const emptyRoot = mkdtempSync(join(tmpdir(), "phx-ledger-"));
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = PRODUCTION_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-not-real";
    const asked: string[] = [];
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ version: String(20250000000000 + i), name: `m${i}` })),
      [{ version: "20261119132423", name: "outstation_accept_claim_for_payroll_atomically" }],
      [],
    ];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      const page = pages[asked.length - 1] ?? [];
      return { ok: true, status: 200, json: async () => page };
    }) as unknown as typeof fetch;
    const ledger = await readProductionLedger({ repoRoot: emptyRoot, fetchImpl });
    assert.equal(ledger.rows, 1001, "every page is read, past a 1,000-row cap");
    assert.equal(ledger.ref, PRODUCTION_REF);
    assert.ok(ledger.versions.has("20261119132423"));
    assert.equal(asked.length, 3, "it pages until an empty page");
    assert.match(asked[1], /\/rest\/v1\/rpc\/phx_ci_migration_versions\?offset=1000&limit=1000$/, "the next page starts where the rows ended");

    const refuse = async (opts: Parameters<typeof readProductionLedger>[0], pattern: RegExp, why: string) => {
      let error = "";
      try {
        await readProductionLedger(opts);
      } catch (e) {
        error = String((e as Error).message);
      }
      assert.match(error, pattern, why);
    };
    const never = (async () => {
      // Worded so it can never satisfy the refusal patterns below: a read that reached the network
      // must fail the assertion, not pass it.
      throw new Error("NETWORK TOUCHED");
    }) as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_URL;
    await refuse({ repoRoot: emptyRoot, fetchImpl: never }, /not production/, "a staging URL is refused before any read — staging HAS these migrations");
    process.env.NEXT_PUBLIC_SUPABASE_URL = PRODUCTION_URL;
    await refuse(
      { repoRoot: emptyRoot, fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch },
      /HTTP 503/,
      "an HTTP error is not a ledger",
    );
    await refuse(
      { repoRoot: emptyRoot, fetchImpl: (async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch },
      /no rows/,
      "an empty ledger is not production's",
    );
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await refuse({ repoRoot: emptyRoot, fetchImpl: never }, /not found/, "no credentials is a refusal, never an empty pass");
  } finally {
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
}

function hookCases(): void {
  const dir = mkdtempSync(join(tmpdir(), "phx-migration-merge-"));
  try {
    const merge = `gh pr merge 603 --squash --repo ${REPO}`;
    const migration = [{ filename: `supabase/migrations/${MIG}`, status: "added" }];

    const noMigration = runGuard(dir, merge, ghShim(dir, answers([{ filename: "src/app/page.tsx", status: "modified" }], [])));
    assert.equal(noMigration.decision, "allow", `a PR with no migration merges: ${noMigration.reason}`);

    const removed = runGuard(dir, merge, ghShim(dir, answers([{ filename: `supabase/migrations/${MIG}`, status: "removed" }], [])));
    assert.equal(removed.decision, "allow", `a PR that only removes a migration file merges: ${removed.reason}`);

    // The head acknowledges the file (the apply-sql-file route): no ledger is needed, so it merges even
    // with the ledger refused.
    const acknowledged = runGuard(dir, merge, ghShim(dir, answers(migration, [MIG])));
    assert.equal(acknowledged.decision, "allow", `an acknowledged migration merges on the head's list: ${acknowledged.reason}`);

    // The 19 Nov shape: a migration the head does not acknowledge, and a ledger that cannot vouch for it.
    const unproven = runGuard(dir, merge, ghShim(dir, answers(migration, [])));
    assert.equal(unproven.decision, "deny", "a migration nothing proves is on production must be refused");
    assert.match(unproven.reason, /^C22 /);
    assert.match(unproven.reason, /PR #603/);
    assert.match(unproven.reason, /not production/, "the refusal says the URL it was handed is not production's");
    assert.match(unproven.reason, /PHX_MIGRATION_MERGE_OK=1 <the same command>/);

    // FAILS CLOSED on an unreadable file list.
    const blind = runGuard(dir, merge, ghShim(dir, answers(null, [])));
    assert.equal(blind.decision, "deny", "an unreadable file list refuses, never allows");
    assert.match(blind.reason, /^C22 — could not tell/);

    // A file list past node's default 1 MB is READ, not "could not tell" (23 Nov 2026: PR 699's merge
    // was refused with its migration on production, because the read stopped at 1,048,576 bytes).
    const long = longFileList(migration);
    assert.ok(Buffer.byteLength(fileLines(long)) > 1024 * 1024 + 400_000, "the list must be well past the default buffer");
    const longAcknowledged = runGuard(dir, merge, ghShim(dir, answers(long, [MIG])));
    assert.equal(longAcknowledged.decision, "allow", `a long file list is read whole and its acknowledged migration merges: ${longAcknowledged.reason}`);
    const longUnproven = runGuard(dir, merge, ghShim(dir, answers(long, [])));
    assert.equal(longUnproven.decision, "deny", "the migration at the end of a long list is still judged");
    assert.match(longUnproven.reason, /not production/, "a long list is refused for its migration, never for its length");
    // The same reading by hand: `node scripts/migration-merge-gate.mjs <pr>` reads the long list too.
    const byHand = spawnSync(process.execPath, [resolve("scripts/migration-merge-gate.mjs"), "603"], {
      cwd: dir,
      encoding: "utf8",
      env: envWithPathFirst(process.env, ghShim(dir, answers(longFileList([]), []))),
      timeout: 60000,
    });
    assert.match(String(byHand.stdout), /PR #603 adds or changes no migration\./, `the hand script reads a long file list: ${byHand.stdout}${byHand.stderr}`);
    assert.equal(byHand.status, 0, "and answers 0, never 2 (could not tell)");

    // The stand-down, inline and in the environment; C21's word does not pass it (PHX_RED_MERGE_OK is set above).
    const inline = runGuard(dir, `PHX_MIGRATION_MERGE_OK=1 ${merge}`, ghShim(dir, answers(migration, [])));
    assert.equal(inline.decision, "allow", inline.reason);
    const viaEnv = runGuard(dir, merge, ghShim(dir, answers(migration, [])), { PHX_MIGRATION_MERGE_OK: "1" });
    assert.equal(viaEnv.decision, "allow", viaEnv.reason);

    // Another repository is not judged — it has no such ledger.
    const other = runGuard(dir, "gh pr merge 5 --squash --repo someone/else", ghShim(dir, answers(migration, [])));
    assert.equal(other.decision, "allow", other.reason);

    // Not a merge at all.
    const view = runGuard(dir, "gh pr view 603", ghShim(dir, answers(migration, [])));
    assert.equal(view.decision, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runMigrationMergeGateTests(): Promise<void> {
  await pureCases();
  await ledgerCases();
  hookCases();
}
