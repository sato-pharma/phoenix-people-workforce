#!/usr/bin/env node
// Backfill every stored CV into the owner's Google Drive, filed by region and area.
//
//   node scripts/backfill-cvs-to-drive.mjs --dry-run     print the tree it WOULD build, write nothing
//   node scripts/backfill-cvs-to-drive.mjs               upload for real, resumable
//   node scripts/backfill-cvs-to-drive.mjs --limit 25    a small first batch
//   node scripts/backfill-cvs-to-drive.mjs --retry       also revisit rows whose last attempt failed
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

// ── placement (mirrors src/lib/recruitment/drive-cv-folders.ts) ──────────────────────────────────
const REGION_LABELS = {
  AB: "Alex-BHR",
  CA: "Cairo",
  D1: "Delta (1)",
  D2: "Delta (2)",
  D3: "Delta (3)",
  GZ: "Giza",
  OT: "Others",
  UE: "Upper Egypt",
};
// The recruitment-only Delta (3) grouping. Kept in step with recruitmentAreaRegionOverrides, and
// pinned by tests/drive-cv-folders.test.ts so the two cannot drift apart unnoticed.
const RECRUITMENT_AREA_REGION_OVERRIDES = {
  Ismailia: "D3",
  Qalubeya: "D3",
  "Sharkia 1": "D3",
  "Sharkia 2": "D3",
  Suez: "D3",
};
const SHELF_LABELS = {
  district_manager: "District Manager",
  medical_rep: "Medical Representative",
  other: "Other positions",
  paramedical: "Paramedical",
};
const UNCLASSIFIED = "Not yet classified";

function sanitize(name) {
  return String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
}

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

function folderPathFor(candidate, areaRegions) {
  // A hand-filed candidate outranks anything derived — same rule as the live module.
  if (candidate.folder_kind && candidate.folder_key && SHELF_LABELS[candidate.folder_kind]) {
    return pathForShelf(candidate.folder_kind, candidate.folder_key, areaRegions);
  }
  // Only a candidate who ANSWERED gets filed. `applied_for_job_title` alone is three times in four
  // the extractor's guess, not a stated intent — filing on it is what candidate-folder-suggestion.ts
  // exists to refuse.
  if (!candidate.preferences_declared_at) return [UNCLASSIFIED];
  if (String(candidate.status ?? "").toLowerCase() === "rejected") return [UNCLASSIFIED];

  const title = String(candidate.applied_for_job_title ?? "").trim();
  if (!title) return [UNCLASSIFIED];
  const lower = title.toLowerCase();

  if (/medical\s*rep|\bmr\b|مندوب/.test(lower)) {
    const area = String(candidate.preferred_area_name ?? "").trim();
    return area ? pathForShelf("medical_rep", area, areaRegions) : [UNCLASSIFIED];
  }
  if (/district\s*manager|\bdm\b/.test(lower)) {
    const code = String(candidate.preferred_region_code ?? "").trim().toUpperCase();
    return REGION_LABELS[code] ? pathForShelf("district_manager", code, areaRegions) : [UNCLASSIFIED];
  }
  return pathForShelf("other", title, areaRegions);
}

function pathForShelf(kind, key, areaRegions) {
  const shelf = SHELF_LABELS[kind];
  if (kind === "paramedical") return [shelf].map(sanitize).filter(Boolean);
  if (kind === "district_manager") {
    return [shelf, REGION_LABELS[String(key).toUpperCase()] ?? key].map(sanitize).filter(Boolean);
  }
  if (kind === "medical_rep") {
    const salesRegion = areaRegions[key];
    const regionCode = RECRUITMENT_AREA_REGION_OVERRIDES[key] ?? salesRegion;
    const region = regionCode ? (REGION_LABELS[regionCode] ?? regionCode) : null;
    return (region ? [shelf, region, key] : [shelf, key]).map(sanitize).filter(Boolean);
  }
  return [shelf, key].map(sanitize).filter(Boolean);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written to Drive.\n" : "Backfilling CVs to Google Drive.\n");

  const areas = await rest("canonical_areas?select=area_name,code_region_code&is_active=eq.true", {
    headers: { "Accept-Profile": "au" },
  });
  const areaRegions = {};
  for (const row of areas) if (row.area_name && row.code_region_code) areaRegions[row.area_name] = row.code_region_code;
  console.log(`Area map: ${Object.keys(areaRegions).length} active areas.`);

  const failedClause = RETRY_FAILED ? "" : "&drive_mirror_error=is.null";
  const rows = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    // Paged with an explicit order: an unbounded PostgREST select silently stops at 1000 rows.
    const page = await rest(
      `ats_files?select=id,candidate_id,file_name,mime_type,drive_file_id&kind=eq.cv&drive_file_id=not.is.null&drive_mirror_file_id=is.null${failedClause}&order=created_at.asc&offset=${offset}&limit=${PAGE}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const todo = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`${rows.length} CV file(s) not yet in Drive; processing ${todo.length}.\n`);
  if (todo.length === 0) return;

  const counts = { failed: 0, skipped: 0, uploaded: 0 };
  const treePreview = new Map();

  for (const [index, file] of todo.entries()) {
    const position = `${index + 1}/${todo.length}`;
    try {
      if (!file.candidate_id) {
        counts.skipped += 1;
        continue;
      }
      const candidates = await rest(
        `ats_candidates?select=id,full_name,phone,whatsapp,status,applied_for_job_title,preferred_area_name,preferred_region_code,preferences_declared_at,folder_kind,folder_key&id=eq.${file.candidate_id}`,
      );
      const candidate = candidates[0];
      if (!candidate) {
        counts.skipped += 1;
        continue;
      }

      const segments = folderPathFor(candidate, areaRegions);
      const name = driveFileName(candidate, file.mime_type, file.file_name);
      const key = segments.join("/");
      treePreview.set(key, (treePreview.get(key) ?? 0) + 1);

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

  console.log("\nFolders that would receive CVs:");
  for (const [folder, count] of [...treePreview.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${folder}`);
  }
  console.log(`\n${DRY_RUN ? "Would upload" : "Uploaded"}: ${counts.uploaded}   skipped: ${counts.skipped}   failed: ${counts.failed}`);
  if (!DRY_RUN && counts.failed > 0) console.log("Re-run with --retry to revisit the failures.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
