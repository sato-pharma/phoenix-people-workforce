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

  // 🔴 Two owners hold repositories since 2026-11-06: every bundle, release folder and manifest line is OWNER/NAME,
  //    so same-named repositories never collide and a restore knows which account each goes back to.
  assert.match(script, /bundle="\$OUT\/bundles\/\$slug\.bundle"/, "a bundle sits under its owner");
  assert.match(script, /mkdir -p "\$\(dirname "\$bundle"\)"/, "and its owner's folder is made before the bundle");
  assert.match(script, /OK\\n' "\$slug" "\$refs"/, "the manifest names OWNER/NAME for a bundled repository");
  assert.match(script, /EMPTY\\n' "\$slug"/, "and for an empty one");
  assert.match(script, /dir="\$OUT\/releases\/\$slug"/, "release files sit under their owner too");
  assert.match(script, /"\$slug" "\$tag" "\$asset" "\$bytes" >> "\$RELEASE_MANIFEST"/, "and releases.tsv names OWNER/NAME");
  assert.doesNotMatch(script, /name="\$\{slug#\*\/\}"/, "🔴 a bare repository name is back in the bundle or manifest layout");
  assert.doesNotMatch(script, /bundles\/\$name\.bundle/, "🔴 a bundle path without its owner overwrites the other owner's");
  // An owner the token cannot see is refused, and says what kind of token fixes it.
  assert.match(script, /refused: the token sees no repository of \$owner[\s\S]*?classic token[\s\S]*?exit 1/, "an unseen owner stops the night");
  // The retired variable is ignored with a warning (refusing would cost a night's coverage); a bare release name is refused.
  const retired = /if \[ -n "\$\{CODE_BACKUP_OWNER:-\}" \]; then\r?\n([\s\S]*?)\r?\nfi/.exec(script)?.[1] ?? "";
  assert.match(retired, /warning: CODE_BACKUP_OWNER is retired and ignored/, "the retired variable is named in the log");
  assert.doesNotMatch(retired, /exit 1/, "🔴 a leftover CODE_BACKUP_OWNER must not refuse the night");
  assert.match(script, /\[\[ "\$slug" != \*\/\* \]\][\s\S]*?refused: CODE_BACKUP_RELEASE_REPOS[\s\S]*?exit 1/, "a bare release name is refused, not misread");

  // 🔴 With the JSON Accept header a release file downloads as JSON under its .apk name, with no error.
  const assetBody = /github_asset\(\) \{\n([^}]*)\n\}/.exec(script)?.[1] ?? "";
  assert.match(assetBody, /Accept: application\/octet-stream/, "a release file asks for its bytes");
  assert.doesNotMatch(assetBody, /vnd\.github/, "and carries no JSON Accept header");
  assert.match(script, /github_asset "\$dir\/\$tag\/\$asset" "\$url"/, "release files go through it");
  assert.match(script, /\.size\] \| @tsv/, "the listed size is read");
  assert.match(script, /\$bytes" != "\$expected"[\s\S]*?exit 1/, "and a file of another size stops the night");
  assert.match(script, />> "\$RELEASE_MANIFEST"/, "each release file is recorded");

  // 🔴 Listing a missing folder fails, so weekly/ must exist or every night fails until the first Sunday.
  const madeWeekly = script.indexOf('rclone mkdir "backup:$FOLDER/weekly"');
  assert.ok(madeWeekly > 0 && madeWeekly < script.indexOf('prune weekly "$KEEP_WEEKLY"'), "weekly/ is made before it is listed");

  // 🔴 Without its watch pattern every merge to main rebuilds the service and can cut off a night's run.
  const iac = readFileSync(".railway/railway.ts", "utf8");
  const declared = iac.slice(iac.indexOf('service("phoenix-code-backup"'), iac.indexOf('service("headwind-db-eu"'));
  assert.match(declared, /watchPatterns:\s*\[\s*"infra\/code-backup\/\*\*"\s*\]/, "only its own folder rebuilds the backup service");
}
