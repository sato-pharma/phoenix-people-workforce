/**
 * Publish one Phoenix Camera release for the reps' "Update the app" button (owner, 20 Nov 2026: "when I make an
 * update here, make a button in the app to when the rep press on it, it updates itself with the new features
 * built").
 *
 * It uploads the signed APK to the private bucket under `releases/` and writes one
 * `phoenix_crm_field_camera_releases` row (version, size, SHA-256). From then on every camera's pack carries it as
 * `latestApp`, with a link that lasts a day, and a phone on an older version offers the update.
 *
 * 🔴 PUBLISHING IS THE OWNER'S WORD — it reaches every rep's phone. A dry run (the default) reads the file and prints
 * what would be published; `--apply` publishes. A version code already published is refused, never overwritten.
 *
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --import ./tests/register-alias-loader.mjs scripts/phoenix-camera-publish-release.ts \
 *     --apk=<path to app-release.apk> --version-code=7 --version-name=2.2.0 --actor=B-10 [--notes="..."] [--apply]
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { CAMERA_BUCKET } from "@/lib/phoenix-crm/server/camera-items";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored: a typo of --apply must not run the other branch.
refuseUnknownFlags({
  name: "phoenix-camera-publish-release",
  entry: import.meta.url,
  known: ["--apk", "--version-code", "--version-name", "--actor", "--notes", "--apply"],
});

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((entry) => entry.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const apply = process.argv.includes("--apply");
const apk = arg("apk");
const versionCode = Number(arg("version-code"));
const versionName = (arg("version-name") ?? "").trim();
const actor = (arg("actor") ?? "").trim().toUpperCase();
const notes = arg("notes");

if (!apk || !Number.isInteger(versionCode) || versionCode <= 0 || !/^[0-9A-Za-z.\-]{1,20}$/.test(versionName) || !actor) {
  console.error("Usage: --apk=<file> --version-code=<whole number> --version-name=<e.g. 2.2.0> --actor=<HR id> [--notes=...] [--apply]");
  process.exit(2);
}

const bytes = readFileSync(apk);
// An APK is a zip: it starts "PK".
if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
  console.error(`${apk} is not an APK.`);
  process.exit(2);
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
const storagePath = `releases/phoenix-camera-${versionName}-${versionCode}.apk`;

console.log(`Phoenix Camera ${versionName} (version code ${versionCode})`);
console.log(`  file    ${apk}`);
console.log(`  size    ${bytes.length.toLocaleString("en-GB")} bytes`);
console.log(`  sha256  ${sha256}`);
console.log(`  stored  ${CAMERA_BUCKET}/${storagePath}`);

const admin = getSupabaseAdmin();
const existing = await admin.from("phoenix_crm_field_camera_releases").select("version_code, version_name").gte("version_code", versionCode).limit(1);
if (existing.error) throw existing.error;
if ((existing.data ?? []).length > 0) {
  console.error(`Version code ${versionCode} or a later one is already published. Raise the version code and build again.`);
  process.exit(1);
}

if (!apply) {
  console.log("Dry run: nothing published. Add --apply to publish.");
  process.exit(0);
}

const upload = await admin.storage
  .from(CAMERA_BUCKET)
  .upload(storagePath, bytes, { contentType: "application/vnd.android.package-archive", upsert: false });
if (upload.error) throw upload.error;
const insert = await admin.from("phoenix_crm_field_camera_releases").insert({
  version_code: versionCode,
  version_name: versionName,
  sha256,
  size_bytes: bytes.length,
  storage_path: storagePath,
  notes: notes ? notes.slice(0, 500) : null,
  published_by_hr_id: actor,
});
if (insert.error) {
  await admin.storage.from(CAMERA_BUCKET).remove([storagePath]);
  throw insert.error;
}
console.log("Published. Every camera's next pack offers it.");
