#!/usr/bin/env node
// Point the mirror's bookkeeping at the CABINET copies built by `build-cv-cabinet.mjs`.
//
//   node scripts/repoint-cv-mirror-to-cabinet.mjs --dry-run
//   node scripts/repoint-cv-mirror-to-cabinet.mjs
//
// RUN THIS ONLY ONCE THE NEW CODE IS LIVE, and run it immediately after. The ordering is not a
// preference, it is the difference between a harmless outcome and a destructive one:
//
//   Run it BEFORE the deploy and the OLD code reads a cabinet path, computes an old-tree path, sees
//   a mismatch and MOVES the cabinet copy into the frozen tree.
//
//   Run it AFTER the deploy and the worst case is a duplicate: for the few minutes between the two,
//   new code reads a legacy path, treats the row as not-yet-in-the-cabinet and uploads a second
//   copy. Re-running the fill script's dedupe cleans that up; nothing is lost either way.
//
// WHAT IT WRITES. Only the four mirror bookkeeping columns on `ats_files`, and only for rows the
// fill script actually created a cabinet copy for. The path is stored ROOTED — prefixed with the
// cabinet's own folder name — because that prefix is what lets `mirrorCvToDrive` tell a cabinet
// record from a legacy one. Two legacy shapes ("Medical Representative/<Region>",
// "District Manager/<Region>") are otherwise identical to a real cabinet path.
//
// WHAT IT DELIBERATELY LEAVES ALONE. The suppressed duplicate rows — the 264 identical re-sends
// that never reached the cabinet. Their bookkeeping still points at their copy in the frozen tree,
// which is true and is a record worth keeping; `shouldMirrorCopy` returns false for them, so the
// mirror skips them before it ever looks at the path. Nulling them would destroy the only pointer
// to where that copy lives and buy nothing.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { CABINET_ROOT_NAME } from "@/lib/recruitment/drive-cabinet-folders";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "repoint-cv-mirror-to-cabinet",
  entry: import.meta.url,
  known: ["--dry-run"],
});

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const DRY_RUN = process.argv.includes("--dry-run");
const LEDGER = path.resolve(".cv-cabinet-ledger.json");
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!fs.existsSync(LEDGER)) {
  console.error(`No ledger at ${LEDGER} — run scripts/build-cv-cabinet.mjs first.`);
  process.exit(1);
}

async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
const entries = Object.entries(ledger);
console.log(`${DRY_RUN ? "DRY RUN — " : ""}repointing ${entries.length} row(s) at "${CABINET_ROOT_NAME}".\n`);

let done = 0;
let failed = 0;
for (const [fileId, record] of entries) {
  const rooted = `${CABINET_ROOT_NAME}/${record.path}`;
  if (DRY_RUN) {
    if (done < 5) console.log(`  ${fileId}  ->  ${rooted}`);
    done += 1;
    continue;
  }
  try {
    await rest(`ats_files?id=eq.${fileId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        drive_mirror_at: new Date().toISOString(),
        drive_mirror_error: null,
        drive_mirror_file_id: record.driveId,
        drive_mirror_path: rooted,
      }),
    });
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${entries.length}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAILED ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\nDone. repointed ${done}, failed ${failed}.`);
if (!DRY_RUN) {
  const check = await rest(
    `ats_files?select=id&kind=eq.cv&drive_mirror_path=like.${encodeURIComponent(`${CABINET_ROOT_NAME}/%`)}&limit=1`,
  );
  console.log(`Verification: a cabinet-rooted path is ${check.length ? "present" : "MISSING"} in ats_files.`);
}
