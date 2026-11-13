import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import {
  assessCodeBackup,
  assessDatabaseBackup,
  CODE_BACKUP_FOLDER,
  CODE_BACKUP_MIN_BYTES,
  DB_BACKUP_FOLDER,
  DB_BACKUP_FIRST_FULL_FILE_BYTES,
  DB_BACKUP_MIN_BYTES,
} from "../src/lib/observability/code-backup-verify.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

const NOW = Date.parse("2026-11-14T09:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const file = (hours: number, size: number) => ({ createdTime: hoursAgo(hours), name: `db-backup-${hours}h`, size });

/** The text of one job of a workflow's `jobs:` block, from its name to the next job. */
function jobBlock(jobsText: string, job: string): string {
  const start = jobsText.search(new RegExp(`^  ${job}:\\r?$`, "m"));
  assert.ok(start >= 0, `the workflow has a job named ${job}`);
  const rest = jobsText.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][a-z-]*:\r?$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * The nightly database backup (integration audit, 13 Nov 2026: ISS-009, INT-096, INT-097) and the image
 * workflows' write scope (ISS-025). The scripts themselves run end to end, in the real image, in
 * .github/workflows/backup-image.yml; this file pins the rules a later edit must not lose.
 */
export async function runDbBackupTests() {
  // --- The alarm: the database file is judged by the code backup's three rules, against its own floor. ---
  assert.notEqual(DB_BACKUP_FOLDER, CODE_BACKUP_FOLDER, "🔴 the two backups share a folder: each job prunes its own folder to seven files");
  // The floor is half of the first full file (331,201,672 bytes, 13 Nov 2026). It was 64 MB before one existed.
  assert.equal(DB_BACKUP_FIRST_FULL_FILE_BYTES, 331_201_672, "the first full file's size is a measurement, not a setting");
  assert.equal(DB_BACKUP_MIN_BYTES, 165_600_836, "🔴 the database floor is half of the first full file: a database only grows, so it is never lowered");
  assert.equal(assessDatabaseBackup([file(8, DB_BACKUP_FIRST_FULL_FILE_BYTES)], NOW).outcome, "success", "the first full file itself passes");
  assert.equal(assessDatabaseBackup([file(8, 100 * 1024 * 1024)], NOW).outcome, "fail", "a 100 MB file passed the old 64 MB floor and is refused now");
  const good = DB_BACKUP_MIN_BYTES * 2;
  assert.equal(assessDatabaseBackup([file(8, good)], NOW).outcome, "success");
  assert.match(assessDatabaseBackup([], NOW).detail, /No backup file/);
  assert.match(assessDatabaseBackup([file(37, good)], NOW).detail, /37 hours old/);
  const small = assessDatabaseBackup([file(8, DB_BACKUP_MIN_BYTES - 1)], NOW);
  assert.equal(small.outcome, "fail", "a file under the database floor is not a backup");
  assert.match(small.detail, /only/);
  assert.match(assessDatabaseBackup([file(32, good * 3), file(8, good)], NOW).detail, /under half/);
  // The code backup keeps its own floor when no floor is passed.
  assert.equal(assessCodeBackup([file(8, CODE_BACKUP_MIN_BYTES - 1)], NOW).outcome, "fail");

  const route = readFileSync("app/api/cron/code-backup-verify/route.ts", "utf8");
  assert.match(route, /"phoenix-code-backup-verify"/, "the code backup keeps its slug");
  assert.match(route, /"phoenix-db-backup-verify"/, "the database backup reports under its own");
  assert.match(route, /readCodeBackupFiles\(DB_BACKUP_FOLDER\)/, "and is read from its own folder");
  assert.equal(route.match(/await checkOne\(/g)?.length, 2, "each backup is read and reported on its own, so one unreadable folder never hides the other");
  const checkOne = route.slice(route.indexOf("async function checkOne"), route.indexOf("export async function GET"));
  assert.match(checkOne, /catch[\s\S]*pingDeadMansSwitch\(slug, "fail"/, "a Drive that cannot be read is a failed ping for that backup");

  const code = JOB_SCHEDULES.find((job) => job.slug === "phoenix-code-backup-verify");
  const database = JOB_SCHEDULES.find((job) => job.slug === "phoenix-db-backup-verify");
  assert.ok(code?.kind === "cron" && database?.kind === "cron", "both checks are declared, so a day with no report raises the alarm");
  // 🔴 The database check has no scheduler job of its own: it rides the code check's call, so the two are one schedule.
  assert.equal(database.schedule, code.schedule, "the database check is declared on the code check's own minute");
  assert.equal(database.graceSeconds, code.graceSeconds);

  // --- The job. ---
  const script = readFileSync("infra/code-backup/db-backup.sh", "utf8");
  assert.match(script, /set -euo pipefail/, "a failed step stops the night");
  assert.match(script, /age -r "\$CODE_BACKUP_AGE_RECIPIENT"/, "encrypts to the public key the owner already holds the private half of");
  assert.doesNotMatch(script, /age (-d|--decrypt)|AGE_IDENTITY|age-keygen/, "🔴 the service can never decrypt");
  // One snapshot for the counts and the dump, or a perfect restore reads as a wrong one.
  assert.match(script, /select pg_export_snapshot\(\)/, "the counting session exports its snapshot");
  assert.match(script, /pg_dump[^\n]*--snapshot="\$snapshot"/, "🔴 the dump reads through the SAME snapshot the rows were counted in");
  const firstCount = script.indexOf("select count(*) as n from");
  assert.ok(script.indexOf("select pg_export_snapshot()") < firstCount, "the rows are counted inside it");
  assert.match(script, /--lock-wait-timeout=60000/, "a migration holding a table stops the dump, it does not queue behind it");
  // The URL is never an argument.
  assert.doesNotMatch(script, /(psql|pg_dump|pg_dumpall|pg_restore)[^\n]*\$\{?DB_BACKUP_DATABASE_URL/, "🔴 the database URL is on a command line");
  assert.match(script, /export PGPASSWORD="\$\{BASH_REMATCH\[3\]\}"/, "the password travels in the environment");
  assert.match(script, /export PGSSLMODE=require/, "TLS unless the URL says otherwise");
  // A login that lost its rights, or the wrong database.
  assert.match(script, /refused: the login sees \$tables tables, fewer than the \$MIN_TABLES expected/, "a database with too few tables is refused");
  // The dump and the manifest must describe one database before anything is uploaded.
  const compared = script.indexOf('comm -23 "$WORK/counted.txt" "$WORK/dumped.txt"');
  const uploaded = script.indexOf("rclone rcat");
  const readBack = script.indexOf('rclone lsf --format s "$TARGET"');
  const pruned = script.indexOf('prune daily "$KEEP_DAILY"');
  assert.ok(compared > 0 && compared < uploaded, "every counted table is found in the dump before the upload");
  assert.ok(uploaded < readBack && readBack < pruned, "🔴 prune only after the upload is read back");
  assert.match(script, /"\$\{size:-0\}" -gt "\$dump_bytes"/, "an upload smaller than the dump did not arrive whole");
  assert.match(script, /REMOTE="backup:\$\{DB_BACKUP_DRIVE_FOLDER:-phoenix-db-backup\}"/, "its own Drive folder");
  assert.match(script, /rclone mkdir "\$REMOTE\/weekly"[\s\S]*prune weekly/, "weekly/ is made before it is listed");
  // The rehearsal option names a role, never SQL.
  assert.match(script, /\[\[ "\$READ_AS" =~ \^\[a-z_\]\[a-z0-9_\]\*\$ \]\]/, "the read-as role is a plain name or the night is refused");

  // --- It steps aside. From the first count to the end of the dump every table is read-locked: a migration
  // waits for that lock and every reader of the table then waits behind the migration (13 Nov 2026, 18:13
  // Cairo, a rehearsal held one for over ten seconds). The rehearsal workflow proves the behaviour; these pin its parts. ---
  assert.match(script, /pg_blocking_pids\(w\.pid\)[^\n]*a\.usename = session_user/, "🔴 the watch counts every session waiting behind this login");
  const watching = script.indexOf("watch_for_waiters &");
  assert.ok(watching > script.indexOf("select pg_export_snapshot()") && watching < firstCount, "🔴 the watch starts before the first table is read");
  assert.match(script, /pg_dump [^\n]*--file "\$OUT\/database\.dump" &\n/, "the dump runs beside the script, so the watch can stop it");
  const stepAside = script.slice(script.indexOf("step_aside() {"), script.indexOf("watch_for_waiters() {"));
  assert.match(stepAside, /pg_terminate_backend\(pid\) from pg_stat_activity where usename = session_user and pid <> pg_backend_pid\(\)/, "stepping aside ends the login's own sessions on the server, which frees the locks at once");
  assert.match(stepAside, /if \[ -z "\$READ_AS" \]; then\n[^\n]*pg_terminate_backend/, "🔴 never in a rehearsal, where the connecting login is shared with every other session");
  assert.match(script, /"\$seen" -ge 2[\s\S]{0,80}step_aside/, "a waiter seen twice running ends the attempt");
  assert.match(script, /"\$blind" -ge 5[\s\S]{0,80}step_aside/, "a watch that cannot see who is waiting ends it too");
  assert.match(script, /YIELD_EXIT=75/, "the exit code the night retries on");
  const steppedCheck = script.lastIndexOf('if [ -s "$WORK/yielded" ]; then give_up');
  assert.ok(steppedCheck > 0 && steppedCheck < uploaded, "🔴 a backup that stepped aside uploads nothing and prunes nothing");

  // --- The night: the code backup first, neither failure stops the other, and only a step-aside is retried. ---
  const run = readFileSync("infra/code-backup/run.sh", "utf8");
  assert.doesNotMatch(run, /set -e/, "🔴 `set -e` here would let a failed code backup skip the database backup");
  assert.ok(run.indexOf("/usr/local/bin/code-backup") < run.indexOf("/usr/local/bin/db-backup"), "the code backup still runs first");
  assert.match(run, /exit "\$failed"/, "the run ends red when either failed");
  assert.match(run, /STEPPED_ASIDE=75/, "the night knows the step-aside code");
  assert.match(run, /"\$code" -ne "\$STEPPED_ASIDE" \] \|\| \[ "\$attempt" -ge "\$tries" \]/, "a fault is never retried, and a step-aside three times at most");

  // --- Nothing else runs these scripts before Railway does, so every change to them is rehearsed on a pull request. ---
  const rehearsal = readFileSync(".github/workflows/backup-image.yml", "utf8");
  assert.match(rehearsal, /pull_request:\s+paths:\s+- "infra\/code-backup\/\*\*"/, "a change under infra/code-backup/ starts the rehearsal");
  assert.match(rehearsal, /run: bash infra\/code-backup\/ci\/rehearse\.sh/);
  assert.doesNotMatch(rehearsal, /secrets\./, "🔴 the rehearsal holds no secret: it never reaches a real database or Drive");
  const rehearse = readFileSync("infra/code-backup/ci/rehearse.sh", "utf8");
  for (const proof of ["DRILL PASSED", "DRILL FAILED", "stepped aside: ", "refused: the target names the production database", "permission denied"]) {
    assert.ok(rehearse.includes(`said "${proof}`), `the rehearsal still checks for: ${proof}`);
  }

  const dockerfile = readFileSync("infra/code-backup/Dockerfile", "utf8");
  assert.match(dockerfile, /postgresql17-client/, "🔴 pg_dump refuses a server newer than itself, and production is PostgreSQL 17");
  assert.match(dockerfile, /CMD \["\/usr\/local\/bin\/nightly-backup"\]/, "the service runs both backups");
  assert.doesNotMatch(dockerfile, /^COPY[^\n]*restore-drill/m, "🔴 the script that decrypts is in the image that makes the backups");

  const iac = readFileSync(".railway/railway.ts", "utf8");
  const declared = iac.slice(iac.indexOf('service("phoenix-code-backup"'), iac.indexOf('service("headwind-db-eu"'));
  assert.match(declared, /DB_BACKUP_DATABASE_URL: preserve\(\)/, "an apply keeps the backup's database login");
  assert.equal(iac.match(/DB_BACKUP_DATABASE_URL: /g)?.length, 1, "🔴 the read-everything login is declared on a second service");

  // --- The login: reads everything, writes nothing, and its password is in no file. ---
  const migrationFiles = readdirSync("supabase/migrations").filter((name) => name.endsWith("_phoenix_backup_reader_role.sql"));
  assert.equal(migrationFiles.length, 1, "one migration makes the role");
  const migration = readFileSync(`supabase/migrations/${migrationFiles[0]}`, "utf8");
  // The statements alone: no comment, and not the role's own description, which is prose that names the login.
  const statements = stripSqlComments(migration);
  const described = statements.search(/comment on role/i);
  assert.ok(described > 0, "the role is described, and that is the file's last statement");
  const sql = statements.slice(0, described);
  assert.match(sql, /create role phoenix_backup_reader nologin[^;]*bypassrls/, "created with no login; row security would otherwise stop the dump");
  assert.match(sql, /grant pg_read_all_data to phoenix_backup_reader/);
  assert.doesNotMatch(sql, /\bpassword\b|(?<![a-z_])login\b/i, "🔴 a login or a password is set in a migration");
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete|truncate|all|create|pg_write_all_data)/i, "🔴 the backup login can write");
  assert.doesNotMatch(sql, /\bsuperuser\b|(?<!no)createrole|(?<!no)createdb|(?<!no)replication/i, "and holds no administrative right");
  assert.match(sql, /set default_transaction_read_only = on/, "its sessions start read-only");
  assert.doesNotMatch(statements.slice(described), /;[\s\S]*\S/, "nothing follows the description, so no statement escapes the checks above");

  // The password is set by scripts/set-backup-reader-login.mjs, as the string PostgreSQL stores. RFC 7677's own
  // example (user "user", password "pencil") is the proof the string is the right one: the server signature
  // made from our ServerKey must be the one the RFC prints.
  const { scramKeys, scramVerifier } = await import("../scripts/lib/scram-verifier.mjs");
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const authMessage =
    "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  assert.equal(
    createHmac("sha256", scramKeys("pencil", salt, 4096).serverKey).update(authMessage).digest("base64"),
    "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
    "🔴 the stored password string is not the one a SCRAM-SHA-256 server expects: the backup could never sign in",
  );
  assert.match(scramVerifier("pencil", salt), /^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
  const setLogin = readFileSync("scripts/set-backup-reader-login.mjs", "utf8");
  assert.match(setLogin, /"--stdin"/, "the URL reaches Railway through stdin, never as an argument");
  // The password and its stored string are each written into exactly one string: the statement, and the URL
  // that goes to Railway's stdin. Any other line that interpolates one is a line that could print it.
  const secretLines = setLogin.split("\n").map((line) => line.trim()).filter((line) => /\$\{(password|url|stored|adminPassword)\}/.test(line));
  assert.equal(secretLines.length, 2, `🔴 a secret is interpolated somewhere new: ${secretLines.map((line) => line.slice(0, 40)).join(" | ")}`);
  assert.ok(secretLines[0]?.startsWith("const set = psql(") && secretLines[1]?.startsWith("const url = "), "🔴 the script could print a secret");
  assert.match(setLogin, /begin read write;\\ncreate table[^\n]*\\nrollback;/, "the write it tries on production is rolled back whatever the answer");

  // --- The drill: a new database on a throwaway server, judged by the counts. ---
  const drill = readFileSync("infra/code-backup/restore-drill.sh", "utf8");
  assert.match(drill, /PRODUCTION_REF="ozucdzovmcqvepbozvqf"[\s\S]*refused: the target names the production database/, "🔴 production is refused by name");
  assert.match(drill, /create database \\"\$SCRATCH\\"/, "it restores into a database it creates");
  assert.match(drill, /pg_restore [^\n]*--dbname "\$SCRATCH"/, "and into no other");
  assert.match(drill, /if \[ "\$mismatches" -ne 0 \]; then[\s\S]*DRILL FAILED[\s\S]*exit 1/, "a missing or short table fails the drill");
  assert.match(drill, /drop database if exists \\"\$SCRATCH\\" with \(force\)/, "and the copy is dropped afterwards");
  assert.match(drill, /grep -v -E "\^\(CREATE\|ALTER\) ROLE/, "the restoring user's own role line is skipped");

  // --- ISS-025: only the job that pushes an image may write packages. ---
  for (const path of [".github/workflows/fallback-image.yml", ".github/workflows/emergency-host.yml"]) {
    const workflow = readFileSync(path, "utf8");
    const top = /^permissions:\r?\n((?: {2}[^\n]*\n)+)/m.exec(workflow)?.[1] ?? "";
    assert.ok(top.length > 0, `${path} states its permissions`);
    assert.doesNotMatch(top, /write/, `🔴 ${path} grants a write scope to every job`);
    const jobsText = workflow.slice(workflow.search(/^jobs:\r?$/m));
    const jobNames = [...jobsText.matchAll(/^ {2}([a-z][a-z-]*):\r?$/gm)].map((match) => match[1]);
    const holders = jobNames.filter((name) => /^ {4}permissions:\r?\n(?: {6}[^\n]*\n)*? {6}packages: write/m.test(jobBlock(jobsText, name)));
    assert.deepEqual(holders, ["image"], `${path}: exactly the job that pushes holds packages: write`);
  }
}
