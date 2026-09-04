#!/usr/bin/env node
// Backfill every stored CV into the owner's Google Drive, filed by region and area.
//
//   node scripts/backfill-cvs-to-drive.mjs --dry-run     print the tree it WOULD build, write nothing
//   node scripts/backfill-cvs-to-drive.mjs               upload for real, resumable
//   node scripts/backfill-cvs-to-drive.mjs --limit 25    a small first batch
//   node scripts/backfill-cvs-to-drive.mjs --retry       also revisit rows whose last attempt failed
//   node scripts/backfill-cvs-to-drive.mjs --refile      re-examine files ALREADY in Drive and move
//                                                        any whose folder has since changed
//   node scripts/backfill-cvs-to-drive.mjs --verify      report only: what is mirrored, what is
//                                                        missing, what is in the wrong folder
//
// RUN IT THROUGH THE ALIAS LOADER, because it imports the live inference module rather than copying
// a hundred governorate spellings that would then drift:
//
//   node --experimental-strip-types --experimental-specifier-resolution=node //        --experimental-loader ./tests/alias-loader.mjs scripts/backfill-cvs-to-drive.mjs
//
// RESUMABLE BY CONSTRUCTION. A row is claimed by `drive_mirror_file_id` being set, so a run that is
// interrupted — or a laptop that goes to sleep, which on this machine is the likely outcome of a
// 950-file run — simply picks up where it stopped. Nothing is uploaded twice.
//
// SEQUENTIAL, ON PURPOSE. Drive rate-limits per user, and the folder cache only pays off once the
// first CV for a folder has created it. Parallel uploads would race to create the same folder and
// produce duplicates with identical names, which is the one failure a person cannot untangle by
// looking. ~950 files at roughly a second each is well under an hour.
//
// Run it from the repo root with the production env loaded (it reads .env.local, which points at
// production Supabase). It only ever READS from Supabase; the only writes are the mirror bookkeeping
// columns on ats_files.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// NOTHING about where a CV goes is re-implemented here. Every folder rule, label table and
// governorate spelling comes from the same pure modules the app itself calls, so this script and
// the running site can never disagree about where a candidate belongs. See the block comment
// above `sanitize` for the drift that made this non-negotiable.
import { candidateFolderKindLabels } from "@/lib/recruitment/candidate-folder";
import { inferCandidatePlacement } from "@/lib/recruitment/candidate-folder-inference";
import { candidateRegionLabels } from "@/lib/recruitment/candidate-region";
import {
  driveFolderPathFor,
  driveInferredFolderPath,
  sanitizeDriveSegment,
} from "@/lib/recruitment/drive-cv-folders";

// ── env ──────────────────────────────────────────────────────────────────────────────────────────
// Loaded by hand rather than via a dependency: this script has to run from a bare worktree, where
// `pnpm exec` is banned (it purges the node_modules junction) and dotenv may not resolve.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RETRY_FAILED = args.includes("--retry");
const REFILE = args.includes("--refile");
const VERIFY = args.includes("--verify");
const LIMIT = (() => {
  const at = args.indexOf("--limit");
  if (at < 0) return Infinity;
  const parsed = Number(args[at + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — is .env.local present?");
  process.exit(1);
}

// ── Supabase REST (no client dependency) ─────────────────────────────────────────────────────────
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

// ── Google Drive ─────────────────────────────────────────────────────────────────────────────────
const DRIVE_ROOT_NAME = (process.env.GOOGLE_DRIVE_RECRUITMENT_ROOT_NAME ?? "Phoenix CVs").trim() || "Phoenix CVs";
const FOLDER_MIME = "application/vnd.google-apps.folder";
let driveToken = null;

async function getDriveToken() {
  if (driveToken && driveToken.expiresAt > Date.now() + 60_000) return driveToken.token;
  const clientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Drive OAuth is not configured (need CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN).");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const text = await res.text();
  if (!res.ok) {
    if (/invalid_grant/i.test(text)) {
      throw new Error("Drive refused the refresh token (invalid_grant) — re-authorise the connection.");
    }
    throw new Error(`Drive auth ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  driveToken = { expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000, token: data.access_token };
  return driveToken.token;
}

function escapeQuery(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const folderCache = new Map();

async function findOrCreateFolder(name, parentId) {
  const q = `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const token = await getDriveToken();
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=10&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (listRes.ok) {
    const found = (await listRes.json()).files?.[0]?.id;
    if (found) return found;
  }
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    body: JSON.stringify({ mimeType: FOLDER_MIME, name, parents: [parentId] }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
  });
  if (!createRes.ok) throw new Error(`folder create ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  return (await createRes.json()).id;
}

async function ensureFolderPath(segments) {
  let parentId = folderCache.get(" root");
  if (!parentId) {
    parentId = process.env.GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID || (await findOrCreateFolder(DRIVE_ROOT_NAME, "root"));
    folderCache.set(" root", parentId);
  }
  const walked = [];
  for (const segment of segments) {
    walked.push(segment);
    const key = walked.join("/");
    const cached = folderCache.get(key);
    if (cached) {
      parentId = cached;
      continue;
    }
    const id = await findOrCreateFolder(segment, parentId);
    folderCache.set(key, id);
    parentId = id;
  }
  return parentId;
}

/**
 * Move an existing Drive file into `parentId`, dropping every parent it currently has.
 *
 * Drive permits multi-parenting through the API, and that is exactly the state that makes a filing
 * cabinet lie - the same file appearing in two folders with two different stories about the person.
 * Returns false when the file is gone, so the caller can re-upload rather than patch a ghost.
 */
async function moveInDrive({ driveFileId, parentId }) {
  const token = await getDriveToken();
  const id = encodeURIComponent(driveFileId);
  const current = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=parents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (current.status === 404) return false;
  if (!current.ok) throw new Error(`Drive lookup failed (${current.status}).`);
  const parents = (await current.json()).parents ?? [];
  if (parents.length === 1 && parents[0] === parentId) return true;

  const params = new URLSearchParams({ addParents: parentId, fields: "id" });
  if (parents.length > 0) params.set("removeParents", parents.join(","));
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?${params.toString()}`, {
    body: "{}",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Drive move failed (${res.status}): ${await res.text()}`);
  return true;
}

async function uploadToDrive({ bytes, mimeType, name, parentId }) {
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
    body,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    method: "POST",
  });
  if (!res.ok) {
    const detail = await res.text();
    if (/storageQuotaExceeded/i.test(detail)) {
      throw new Error("STORAGE FULL — the Google account has no space left. Stop and free space before continuing.");
    }
    throw new Error(`upload ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()).id;
}

// ── placement (DELEGATED to src/lib/recruitment/drive-cv-folders.ts) ─────────────────────────────
//
// This section used to be a COPY of the live module: its own shelf labels, region labels,
// Delta (3) recruitment overrides, sanitizer and path builder. The copy went stale the first
// time the app improved. On 2026-09-04 the live module learned to nest a hand-typed governorate
// under its region, and this script — the one thing that MOVES existing CVs — kept filing them
// loose, so `--verify` reported a clean tree the app itself disagreed with. A duplicated rule
// that only drifts when somebody improves the original is the worst kind, because the
// improvement is what breaks it. Everything here is the live function now, called.
const sanitize = sanitizeDriveSegment;

const EXT_BY_MIME = {
  "application/msword": ".doc",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function driveFileName(candidate, mimeType, originalName) {
  const name = sanitize(candidate.full_name ?? "");
  const digits = String(candidate.whatsapp || candidate.phone || "").replace(/\D/g, "");
  const ext =
    EXT_BY_MIME[String(mimeType ?? "").toLowerCase().split(";")[0]?.trim()] ??
    (String(originalName ?? "").match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? "");
  const stem = [name || null, digits || null].filter(Boolean).join(" - ") || "Unnamed CV";
  return `${stem}${ext}`;
}

/**
 * Where a candidate goes when nothing was declared - the caveated shelf, never the confirmed tree.
 * The reading and the path are both live functions; this only assembles the input columns.
 */
function inferredPathFor(candidate) {
  const placement = inferCandidatePlacement({
    address: candidate.address,
    governorate: candidate.governorate,
    preferredRegionCode: candidate.preferred_region_code,
    sentForRegion: candidate.sent_for_region,
  });
  return driveInferredFolderPath(placement);
}

function folderPathFor(candidate, areaRegions) {
  // A hand-filed candidate outranks anything derived — same rule as the live module.
  if (candidate.folder_kind && candidate.folder_key && candidateFolderKindLabels[candidate.folder_kind]) {
    return pathForShelf(candidate.folder_kind, candidate.folder_key, areaRegions);
  }
  // Only a candidate who ANSWERED reaches the confirmed tree. `applied_for_job_title` alone is three times in four
  // the extractor's guess, not a stated intent — filing on it is what candidate-folder-suggestion.ts
  // exists to refuse.
  if (!candidate.preferences_declared_at) return inferredPathFor(candidate);
  if (String(candidate.status ?? "").toLowerCase() === "rejected") return inferredPathFor(candidate);

  const title = String(candidate.applied_for_job_title ?? "").trim();
  if (!title) return inferredPathFor(candidate);
  const lower = title.toLowerCase();

  if (/medical\s*rep|\bmr\b|مندوب/.test(lower)) {
    const area = String(candidate.preferred_area_name ?? "").trim();
    return area ? pathForShelf("medical_rep", area, areaRegions) : inferredPathFor(candidate);
  }
  if (/district\s*manager|\bdm\b/.test(lower)) {
    const code = String(candidate.preferred_region_code ?? "").trim().toUpperCase();
    return candidateRegionLabels[code]
      ? pathForShelf("district_manager", code, areaRegions)
      : inferredPathFor(candidate);
  }
  return pathForShelf("other", title, areaRegions);
}

// An empty `label` is deliberate: `driveFolderPathFor` then asks `candidateFolderLabel`, which
// is the same resolution the app performs — a region code becomes its region name, and every
// other kind keeps the key verbatim.
function pathForShelf(kind, key, areaRegions) {
  return driveFolderPathFor({ key, kind, label: "" }, areaRegions);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written to Drive.\n" : "Backfilling CVs to Google Drive.\n");

  // The PUBLIC view, not `au.canonical_areas` directly: PostgREST exposes only public,
  // graphql_public and analytics, so reaching into the `au` schema answers PGRST106
  // "Invalid schema: au". Same view listCandidateFolderAreaOptions reads.
  const areas = await rest("au_v_canonical_areas?select=area_name,code_region_code&is_active=eq.true");
  const areaRegions = {};
  for (const row of areas) if (row.area_name && row.code_region_code) areaRegions[row.area_name] = row.code_region_code;
  console.log(`Area map: ${Object.keys(areaRegions).length} active areas.`);

  if (VERIFY) {
    await verifyMirror(areaRegions);
    return;
  }

  // --refile inspects what is ALREADY in Drive; the normal run inspects what is not. The two are
  // exact opposites on the same column, so a refile can never re-upload and a backfill can never
  // move - each is blind to the other's rows by construction.
  const mirrorClause = REFILE ? "&drive_mirror_file_id=not.is.null" : "&drive_mirror_file_id=is.null";
  const failedClause = RETRY_FAILED || REFILE ? "" : "&drive_mirror_error=is.null";
  const rows = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    // Paged with an explicit order: an unbounded PostgREST select silently stops at 1000 rows.
    const page = await rest(
      `ats_files?select=id,candidate_id,file_name,mime_type,drive_file_id,drive_mirror_file_id,drive_mirror_path&kind=eq.cv&drive_file_id=not.is.null${mirrorClause}${failedClause}&order=created_at.asc&offset=${offset}&limit=${PAGE}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const todo = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`${rows.length} CV file(s) not yet in Drive; processing ${todo.length}.\n`);
  if (todo.length === 0) return;

  const counts = { failed: 0, moved: 0, skipped: 0, unchanged: 0, uploaded: 0 };
  const treePreview = new Map();

  for (const [index, file] of todo.entries()) {
    const position = `${index + 1}/${todo.length}`;
    try {
      if (!file.candidate_id) {
        counts.skipped += 1;
        continue;
      }
      const candidates = await rest(
        `ats_candidates?select=id,full_name,phone,whatsapp,status,applied_for_job_title,preferred_area_name,preferred_region_code,preferences_declared_at,folder_kind,folder_key,governorate,address,sent_for_region&id=eq.${file.candidate_id}`,
      );
      const candidate = candidates[0];
      if (!candidate) {
        counts.skipped += 1;
        continue;
      }

      const segments = folderPathFor(candidate, areaRegions);
      const name = driveFileName(candidate, file.mime_type, file.file_name);
      const key = segments.join("/");
      if (!REFILE || file.drive_mirror_path !== key) {
        treePreview.set(key, (treePreview.get(key) ?? 0) + 1);
      }

      if (REFILE) {
        // Already where it belongs. By far the commonest outcome on a second run, and the reason
        // this mode is safe to re-run: it is a no-op for everything it has already handled.
        if (file.drive_mirror_path === key) {
          counts.unchanged += 1;
          continue;
        }
        if (DRY_RUN) {
          counts.moved += 1;
          if (counts.moved <= 15) console.log(`  ${position}  ${file.drive_mirror_path ?? "?"}  ->  ${key}`);
          continue;
        }
        const parentId = await ensureFolderPath(segments);
        const ok = await moveInDrive({ driveFileId: file.drive_mirror_file_id, parentId });
        if (!ok) {
          // The owner moved or deleted it himself. Clear our claim so a later plain run re-uploads
          // it, rather than leaving a row pointing at a file that is not there.
          await rest(`ats_files?id=eq.${file.id}`, {
            body: JSON.stringify({
              drive_mirror_at: new Date().toISOString(),
              drive_mirror_error: "The mirrored file is no longer in Drive.",
              drive_mirror_file_id: null,
            }),
            headers: { Prefer: "return=minimal" },
            method: "PATCH",
          });
          counts.failed += 1;
          continue;
        }
        await rest(`ats_files?id=eq.${file.id}`, {
          body: JSON.stringify({
            drive_mirror_at: new Date().toISOString(),
            drive_mirror_error: null,
            drive_mirror_path: key,
          }),
          headers: { Prefer: "return=minimal" },
          method: "PATCH",
        });
        counts.moved += 1;
        if (counts.moved % 25 === 0 || counts.moved <= 5) console.log(`  ${position}  ->  ${key}`);
        continue;
      }

      if (DRY_RUN) {
        counts.uploaded += 1;
        if (index < 15) console.log(`  ${position}  ${key}/${name}`);
        continue;
      }

      const bytes = await downloadFromStorage(file.drive_file_id);
      const parentId = await ensureFolderPath(segments);
      const driveId = await uploadToDrive({ bytes, mimeType: file.mime_type, name, parentId });

      await rest(`ats_files?id=eq.${file.id}`, {
        body: JSON.stringify({
          drive_mirror_at: new Date().toISOString(),
          drive_mirror_error: null,
          drive_mirror_file_id: driveId,
          drive_mirror_path: key,
        }),
        headers: { Prefer: "return=minimal" },
        method: "PATCH",
      });
      counts.uploaded += 1;
      if (counts.uploaded % 25 === 0 || index < 5) console.log(`  ${position}  ${key}/${name}`);
    } catch (error) {
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${position}  FAILED  ${message}`);
      if (/STORAGE FULL|invalid_grant/i.test(message)) {
        console.error("\nStopping: this failure affects every remaining file.");
        break;
      }
      if (!DRY_RUN) {
        await rest(`ats_files?id=eq.${file.id}`, {
          body: JSON.stringify({ drive_mirror_at: new Date().toISOString(), drive_mirror_error: message.slice(0, 500) }),
          headers: { Prefer: "return=minimal" },
          method: "PATCH",
        }).catch(() => {});
      }
    }
  }

  console.log(REFILE ? "\nFolders that would GAIN CVs:" : "\nFolders that would receive CVs:");
  for (const [folder, count] of [...treePreview.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${folder}`);
  }
  console.log(
    REFILE
      ? `\n${DRY_RUN ? "Would move" : "Moved"}: ${counts.moved}   already correct: ${counts.unchanged}   skipped: ${counts.skipped}   failed: ${counts.failed}`
      : `\n${DRY_RUN ? "Would upload" : "Uploaded"}: ${counts.uploaded}   skipped: ${counts.skipped}   failed: ${counts.failed}`,
  );
  if (!DRY_RUN && counts.failed > 0) console.log("Re-run with --retry to revisit the failures.");
  if (!REFILE && !DRY_RUN) console.log("Run again with --refile to move any CV whose folder has since changed.");
}

/**
 * Report only: does every CV have a Drive file, and is it in the folder its data says?
 *
 * WHY THIS EXISTS. Nothing checked this. To trust the 2026-09-04 backfill somebody had to hand-write
 * a Drive tree walk and count 955 files by eye, and drift here is silent by nature: a candidate is
 * re-classified, an area is renamed, an upload fails once and nobody looks again. The file stays
 * exactly where it was and no error is ever raised.
 *
 * IT DOES NOT OPEN DRIVE, AND SAYS SO. Every question below is answered from `drive_mirror_path`,
 * which is what the mirror BELIEVES. That catches every drift caused by our own data changing —
 * the common case, and instant across the whole pool. It cannot see a file a person moved or
 * deleted inside Drive by hand; `--refile` is what repairs the first kind, and only a tree walk
 * would find the second. Printing that limit is the point: a check that quietly certifies what it
 * never looked at is worse than no check.
 */
async function verifyMirror(areaRegions) {
  const rows = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(
      `ats_files?select=id,candidate_id,drive_mirror_file_id,drive_mirror_path,drive_mirror_error&kind=eq.cv&drive_file_id=not.is.null&order=created_at.asc&offset=${offset}&limit=${PAGE}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  // One request per file would be 950+ round-trips for a report somebody should be able to run
  // casually. Chunked at 50 ids: PostgREST returns ZERO rows and NO error once an `in.()` list
  // grows to several hundred, so the chunk size here is a correctness limit, not a tuning knob.
  const wanted = [...new Set(rows.map((f) => f.candidate_id).filter(Boolean))];
  const byId = new Map();
  const SELECT =
    "id,full_name,status,applied_for_job_title,preferred_area_name,preferred_region_code," +
    "preferences_declared_at,folder_kind,folder_key,governorate,address,sent_for_region";
  for (let at = 0; at < wanted.length; at += 50) {
    const chunk = wanted.slice(at, at + 50);
    const page = await rest(`ats_candidates?select=${SELECT}&id=in.(${chunk.join(",")})`);
    for (const candidate of page) byId.set(candidate.id, candidate);
  }

  const stats = { errored: 0, misfiled: 0, mirrored: 0, notMirrored: 0, orphanCandidate: 0, total: rows.length };
  const moves = new Map();
  for (const file of rows) {
    if (file.drive_mirror_error) stats.errored += 1;
    if (!file.drive_mirror_file_id) {
      stats.notMirrored += 1;
      continue;
    }
    stats.mirrored += 1;
    const candidate = file.candidate_id ? byId.get(file.candidate_id) : null;
    if (!candidate) {
      stats.orphanCandidate += 1;
      continue;
    }
    const expected = folderPathFor(candidate, areaRegions).join("/");
    if (expected !== file.drive_mirror_path) {
      stats.misfiled += 1;
      const key = `${file.drive_mirror_path || "(nowhere)"}  ->  ${expected}`;
      moves.set(key, (moves.get(key) ?? 0) + 1);
    }
  }

  console.log("\n=== CV mirror health ===");
  console.log(`  CVs with a stored file        ${stats.total}`);
  console.log(`  mirrored into Drive           ${stats.mirrored}`);
  console.log(`  NOT mirrored yet              ${stats.notMirrored}${stats.notMirrored ? "   <- run without --verify" : ""}`);
  console.log(`  last attempt errored          ${stats.errored}${stats.errored ? "   <- run with --retry" : ""}`);
  console.log(`  in the WRONG folder           ${stats.misfiled}${stats.misfiled ? "   <- run with --refile" : ""}`);
  console.log(`  file has no candidate row     ${stats.orphanCandidate}`);
  if (moves.size) {
    console.log("\n  Where they should move:");
    for (const [move, count] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      console.log(`    ${String(count).padStart(4)}  ${move}`);
    }
  }
  console.log(
    "\n  Read from the mirror\'s own bookkeeping, not from Drive: this sees drift caused by our data\n" +
      "  changing, and CANNOT see a file moved or deleted inside Drive by hand.",
  );
  return stats;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
