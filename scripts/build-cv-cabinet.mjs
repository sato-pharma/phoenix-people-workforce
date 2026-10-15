#!/usr/bin/env node
// Build the CV CABINET — the owner's second Drive tree, filed by the channel each CV arrived on and by
// the applicant's own answers (see src/lib/recruitment/drive-cabinet-folders.ts).
//
//   node scripts/build-cv-cabinet.mjs --dry-run    print the tree it WOULD build, write nothing
//   node scripts/build-cv-cabinet.mjs              build it for real, resumable
//   node scripts/build-cv-cabinet.mjs --limit 25   a small first batch
//
// RUN IT THROUGH THE ALIAS LOADER, because it imports the live folder rules rather than copying
// them — the same non-negotiable that `backfill-cvs-to-drive.mjs` documents:
//
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//        --experimental-loader ./tests/alias-loader.mjs scripts/build-cv-cabinet.mjs --dry-run
//
// WHAT IT DOES NOT TOUCH. The existing "Phoenix CVs" tree, at all. Owner, 2026-09-07: "don't fix.
// Create a new folder and reroute." Nothing here reads its paths, moves its files or deletes
// anything from it; it stays exactly as it is, as a frozen second copy, and this script only ever
// COPIES out of it.
//
// COPIES, NOT RE-UPLOADS. Every CV is already in Drive, so `files.copy` makes the cabinet's copy
// server-side without pulling ~370 MB back through this laptop. Supabase Storage is the fallback
// for any row whose old mirror is missing — measured zero on 2026-09-07, kept because the audit
// that measured it cannot promise the next run.
//
// DEDUPED. One copy per candidate per distinct file, chosen by `chooseCvCopies`. 264 of the 1,156
// mirrored files are byte-identical re-sends by the same person and do not reach the cabinet.
//
// RESUMABLE BY CONSTRUCTION. Every created file is written to a local ledger keyed by the
// `ats_files` row id, so an interrupted run resumes without copying anything twice. Delete the
// ledger to start over.
//
// SEQUENTIAL, ON PURPOSE. Parallel calls race to create the same folder and Drive will happily make
// two folders with one name — the one failure a person cannot untangle by looking.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// NOTHING about where a CV goes is re-implemented here.
import { chooseCvCopies } from "@/lib/recruitment/cv-duplicate-copies";
import { CABINET_ROOT_NAME, cabinetPathFor } from "@/lib/recruitment/drive-cabinet-folders";
import { driveFileNameFor, sanitizeDriveSegment } from "@/lib/recruitment/drive-cv-folders";

import { cabinetInputFor, loadCabinetFacts, requireImportSenders } from "./cv-cabinet-context.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "build-cv-cabinet",
  entry: import.meta.url,
  known: ["--dry-run", "--limit"],
  hints: [
    "--dry-run prints the tree it would build and writes nothing; --limit <n> makes a small first batch",
  ],
});

// ── env ──────────────────────────────────────────────────────────────────────────────────────────
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

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LEDGER = path.resolve(".cv-cabinet-ledger.json");
const LIMIT = (() => {
  const at = args.indexOf("--limit");
  if (at < 0) return Infinity;
  const parsed = Number(args[at + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
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

async function downloadFromStorage(objectPath) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/recruitment-files/${objectPath.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!res.ok) throw new Error(`storage ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Drive ────────────────────────────────────────────────────────────────────────────────────────
const FOLDER_MIME = "application/vnd.google-apps.folder";
let driveToken = null;

async function getDriveToken() {
  if (driveToken && driveToken.expiresAt > Date.now() + 60_000) return driveToken.token;
  const clientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Drive OAuth is not configured.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (/invalid_grant/i.test(detail)) throw new Error("Drive refresh token revoked or expired (invalid_grant).");
    throw new Error(`Drive auth failed ${res.status}`);
  }
  const data = await res.json();
  driveToken = { expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000, token: data.access_token };
  return driveToken.token;
}

async function drive(pathAndQuery, init = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = await getDriveToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) return res.status === 204 ? {} : res.json();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Drive ${res.status} on ${pathAndQuery}: ${(await res.text()).slice(0, 250)}`);
  }
  throw new Error(`Drive gave up on ${pathAndQuery}`);
}

// Drive's query language is string-concatenated by every example Google publishes, and a folder
// name carrying an apostrophe would otherwise terminate the literal. Backslash first so it cannot
// be used to smuggle the quote past the second replacement.
function escapeQuery(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const folderIdCache = new Map();

async function findOrCreateFolder(name, parentId) {
  const query = [
    `name = '${escapeQuery(name)}'`,
    `'${escapeQuery(parentId)}' in parents`,
    `mimeType = '${FOLDER_MIME}'`,
    "trashed = false",
  ].join(" and ");
  const listed = await drive(`files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=10&spaces=drive`);
  const existing = listed.files?.find((file) => file.id)?.id;
  if (existing) return existing;
  const created = await drive("files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mimeType: FOLDER_MIME, name, parents: [parentId] }),
  });
  if (!created.id) throw new Error("Drive folder create returned no id.");
  return created.id;
}

async function ensureCabinetRoot() {
  const cached = folderIdCache.get("::root");
  if (cached) return cached;
  const id = await findOrCreateFolder(CABINET_ROOT_NAME, "root");
  folderIdCache.set("::root", id);
  return id;
}

async function ensureFolderPath(segments) {
  const clean = segments.map(sanitizeDriveSegment).filter(Boolean);
  let parentId = await ensureCabinetRoot();
  const walked = [];
  for (const segment of clean) {
    walked.push(segment);
    const key = walked.join("/");
    const cached = folderIdCache.get(key);
    if (cached) {
      parentId = cached;
      continue;
    }
    const id = await findOrCreateFolder(segment, parentId);
    folderIdCache.set(key, id);
    parentId = id;
  }
  return parentId;
}

async function copyIntoCabinet({ sourceId, name, parentId }) {
  const copied = await drive(`files/${encodeURIComponent(sourceId)}/copy?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  if (!copied.id) throw new Error("Drive copy returned no id.");
  return copied.id;
}

async function uploadIntoCabinet({ bytes, mimeType, name, parentId }) {
  const token = await getDriveToken();
  const boundary = `phx${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify({ name, parents: [parentId] })),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${(await res.text()).slice(0, 250)}`);
  const data = await res.json();
  if (!data.id) throw new Error("Drive upload returned no id.");
  return data.id;
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
const CANDIDATE_FIELDS = [
  "id",
  "full_name",
  "phone",
  "whatsapp",
  "applied_for_job_title",
  "preferred_area_name",
  "preferred_region_code",
  "preferences_declared_at",
].join(",");

async function pageAll(build) {
  const rows = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    // Paged with an explicit order: an unbounded PostgREST select silently stops at 1000 rows.
    const page = await rest(build(offset, PAGE));
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function main() {
  console.log(DRY_RUN ? `DRY RUN — nothing will be written to Drive.\n` : `Building "${CABINET_ROOT_NAME}".\n`);

  const areas = await rest("au_v_canonical_areas?select=area_name,code_region_code&is_active=eq.true");
  const areaRegions = {};
  for (const row of areas) if (row.area_name && row.code_region_code) areaRegions[row.area_name] = row.code_region_code;
  console.log(`Area map: ${Object.keys(areaRegions).length} active areas.`);

  const files = await pageAll(
    (offset, page) =>
      `ats_files?select=id,candidate_id,file_name,mime_type,content_md5,created_at,drive_file_id,drive_mirror_file_id,upload_origin` +
      `&kind=eq.cv&candidate_id=not.is.null&order=created_at.asc&offset=${offset}&limit=${page}`,
  );
  console.log(`CV rows: ${files.length}`);

  // Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns ZERO rows and NO error,
  // so this is a correctness limit rather than a tuning knob.
  const wantedIds = [...new Set(files.map((file) => file.candidate_id))];
  const candidates = new Map();
  for (let at = 0; at < wantedIds.length; at += 50) {
    const chunk = wantedIds.slice(at, at + 50);
    const page = await rest(`ats_candidates?select=${CANDIDATE_FIELDS}&id=in.(${chunk.join(",")})`);
    for (const candidate of page) candidates.set(candidate.id, candidate);
  }
  console.log(`Candidates: ${candidates.size}`);

  // Dedupe per candidate, using the same chooser the live mirror uses.
  const byCandidate = new Map();
  for (const file of files) {
    if (!byCandidate.has(file.candidate_id)) byCandidate.set(file.candidate_id, []);
    byCandidate.get(file.candidate_id).push(file);
  }
  const keepers = [];
  let suppressed = 0;
  for (const [, rows] of byCandidate) {
    const { keep, suppress } = chooseCvCopies(rows);
    keepers.push(...keep);
    suppressed += suppress.length;
  }
  keepers.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  console.log(`Deduped: ${keepers.length} to file, ${suppressed} identical re-sends suppressed.\n`);

  const importSenders = requireImportSenders();
  const facts = await loadCabinetFacts(rest, keepers.map((file) => file.id));

  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
  const tree = new Map();
  const todo = [];
  for (const file of keepers) {
    const candidate = candidates.get(file.candidate_id);
    if (!candidate) continue;
    const segments = cabinetPathFor(
      cabinetInputFor({ candidate, facts, file, importSenders, siblings: byCandidate.get(file.candidate_id) ?? [file] }),
      areaRegions,
    );
    const name = driveFileNameFor({
      candidateName: candidate.full_name,
      mimeType: file.mime_type,
      originalFileName: file.file_name,
      phone: candidate.whatsapp || candidate.phone,
    });
    const key = segments.join("/");
    tree.set(key, (tree.get(key) ?? 0) + 1);
    if (!ledger[file.id]) todo.push({ file, name, segments, key });
  }

  console.log(`=== THE TREE (${tree.size} folders) ===`);
  for (const [key, count] of [...tree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }

  const positions = new Map();
  for (const [key, count] of tree) {
    const position = key.split("/")[0];
    positions.set(position, (positions.get(position) ?? 0) + count);
  }
  console.log(`\n=== TOP LEVEL (${positions.size} channel and red-flag folders) ===`);
  for (const [position, count] of [...positions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${position}`);
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — ${todo.length} file(s) would be copied into "${CABINET_ROOT_NAME}". Nothing written.`);
    return;
  }

  const batch = LIMIT === Infinity ? todo : todo.slice(0, LIMIT);
  console.log(`\n${todo.length} file(s) still to copy; doing ${batch.length}.\n`);
  if (batch.length === 0) return;

  const counts = { copied: 0, failed: 0, uploaded: 0 };
  for (const [index, item] of batch.entries()) {
    const position = `${index + 1}/${batch.length}`;
    try {
      const parentId = await ensureFolderPath(item.segments);
      let newId = null;
      if (item.file.drive_mirror_file_id) {
        newId = await copyIntoCabinet({ name: item.name, parentId, sourceId: item.file.drive_mirror_file_id });
        counts.copied += 1;
      } else if (item.file.drive_file_id) {
        const bytes = await downloadFromStorage(item.file.drive_file_id);
        newId = await uploadIntoCabinet({ bytes, mimeType: item.file.mime_type, name: item.name, parentId });
        counts.uploaded += 1;
      } else {
        continue;
      }
      ledger[item.file.id] = { driveId: newId, name: item.name, path: item.key };
      fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
      if (index < 5 || (index + 1) % 50 === 0) console.log(`  ${position}  ${item.key}/${item.name}`);
    } catch (error) {
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${position}  FAILED  ${message}`);
      if (/invalid_grant|storageQuotaExceeded/i.test(message)) {
        console.error("\nStopping: this failure affects every remaining file.");
        break;
      }
    }
  }

  console.log(`\nDone. copied ${counts.copied}, uploaded ${counts.uploaded}, failed ${counts.failed}.`);
  console.log(`Ledger: ${LEDGER}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
