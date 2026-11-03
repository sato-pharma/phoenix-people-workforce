import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assessCodeBackup, CODE_BACKUP_MIN_BYTES, readCodeBackupFiles } from "../src/lib/observability/code-backup-verify.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const file = (hours: number, size = 400 * 1024 * 1024) => ({ createdTime: hoursAgo(hours), name: `backup-${hours}h`, size });

export async function runCodeBackupVerifyTests() {
  assert.equal(assessCodeBackup([file(10)], NOW).outcome, "success");
  assert.equal(assessCodeBackup([file(36)], NOW).outcome, "success", "36 hours is the limit, not past it");

  const none = assessCodeBackup([], NOW);
  assert.equal(none.outcome, "fail");
  assert.match(none.detail, /No backup file/);

  const stale = assessCodeBackup([file(37)], NOW);
  assert.equal(stale.outcome, "fail");
  assert.match(stale.detail, /37 hours old/);

  const small = assessCodeBackup([file(5, CODE_BACKUP_MIN_BYTES - 1)], NOW);
  assert.equal(small.outcome, "fail");
  assert.match(small.detail, /only/);

  // Newest is judged whatever order Drive lists them in, and against the one before it.
  const shrunk = assessCodeBackup([file(29, 900 * 1024 * 1024), file(5, 300 * 1024 * 1024)], NOW);
  assert.equal(shrunk.outcome, "fail");
  assert.match(shrunk.detail, /under half/);
  assert.equal(assessCodeBackup([file(29, 500 * 1024 * 1024), file(5, 300 * 1024 * 1024)], NOW).outcome, "success");

  // An unreadable date never reads as fresh.
  assert.equal(assessCodeBackup([{ createdTime: "", name: "x", size: CODE_BACKUP_MIN_BYTES }], NOW).outcome, "fail");

  // Drive: an absent folder is no files, which fails above; a Drive that cannot be read throws.
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = "id";
  process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = "secret";
  process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN = "refresh";
  try {
    const token = () => Response.json({ access_token: "t", expires_in: 3600 });
    globalThis.fetch = (async (url: string) => (String(url).includes("oauth2") ? token() : Response.json({ files: [] }))) as typeof fetch;
    assert.deepEqual(await readCodeBackupFiles("no-such-folder"), []);

    globalThis.fetch = (async (url: string) => (String(url).includes("oauth2") ? token() : new Response("no", { status: 403 }))) as typeof fetch;
    await assert.rejects(readCodeBackupFiles(), /403/);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }

  // 🔴 The job: nothing that can decrypt, and nothing pruned until the upload has been read back.
  const script = readFileSync("infra/code-backup/backup.sh", "utf8");
  assert.match(script, /age -r "\$CODE_BACKUP_AGE_RECIPIENT"/, "encrypts to the public key");
  assert.doesNotMatch(script, /age (-d|--decrypt)|AGE_IDENTITY|age-keygen/, "the service can never decrypt");
  assert.match(script, /set -euo pipefail/, "a failed step in the pipe stops the night");
  assert.match(script, /git -C "\$mirror" bundle verify/, "every bundle is verified");
  assert.match(script, /CODE_BACKUP_MIN_REPOS/, "a token that lost access is refused");
  assert.match(script, /EMPTY/, "an empty repository is flagged, not passed");
  assert.doesNotMatch(script, /x-access-token:[^%]*@github/, "the token is never in a clone URL");
  const uploaded = script.indexOf("rclone rcat");
  const readBack = script.indexOf("rclone lsf --format s");
  const pruned = script.indexOf("prune daily");
  assert.ok(uploaded > 0 && uploaded < readBack && readBack < pruned, "prune only after the upload is read back");
}
