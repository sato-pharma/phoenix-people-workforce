#!/usr/bin/env node
// Backfill every stored CV into the owner's Google Drive cabinet, filed by the channel it arrived on
// and by the applicant's own answers (see src/lib/recruitment/drive-cabinet-folders.ts).
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
import { shouldMirrorCopy } from "@/lib/recruitment/cv-duplicate-copies";
import { CABINET_ROOT_NAME, cabinetPathFor } from "@/lib/recruitment/drive-cabinet-folders";
import { sanitizeDriveSegment } from "@/lib/recruitment/drive-cv-folders";
import { REMOVED_FROM_DRIVE_BY_HAND } from "@/lib/recruitment/drive-cv-mirror";
import { ensureFolderPath, moveDriveFile } from "@/lib/recruitment/drive-tree";

// Where each CV ARRIVED and whether it is a CV at all — the two per-file facts the cabinet rule reads
// besides the candidate. Shared with build-cv-cabinet.mjs, so both scripts load them one way.
import { cabinetInputFor, loadCabinetFacts, requireImportSenders } from "./cv-cabinet-context.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backfill-cvs-to-drive",
  entry: import.meta.url,
  known: ["--dry-run", "--retry", "--refile", "--verify", "--limit"],
});

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
 * Where a CV belongs in Drive — the CABINET path, rooted, exactly as the live mirror writes it.
 *
 * THIS SCRIPT USED TO ANSWER A DIFFERENT QUESTION FROM THE APP, AND `--refile` ACTS ON THE ANSWER.
 * The cabinet shipped in #3454: `drive-cv-mirror.ts` moved to `cabinetPathFor` and began recording
 * `drive_mirror_path` as `Phoenix CV Cabinet/...`. This script was not moved with it and went on
 * computing the OLD `drive-cv-folders` tree, so `--verify` compared a cabinet path against an
 * old-tree path, disagreed on most of the library, and printed "in the WRONG folder <- run with
 * --refile". Measured on production 2026-09-08: 913 of 1,171 mirrored CVs, not one of them
 * actually misfiled.
 *
 * `--refile` acts on that same comparison and rewrites `drive_mirror_path` as it goes, so running
 * it would have moved all 913 back out of the cabinet — the reorganisation undone by the tool built
 * to check it, on the tool's own printed advice. Nothing caught it because each half was correct on
 * its own; only asking both the same question exposes it.
 *
 * So there is deliberately no local copy of the foldering rule here any more, and none should be
 * reintroduced: this imports the function the running site uses, which is the only way the two
 * cannot drift apart again.
 *
 * ── TWO SHAPES, AND CONFLATING THEM BUILT A SECOND CABINET ──────────────────────────────────────
 *
 * The rooted form and the Drive form are NOT interchangeable, and the first version of this fix
 * used one array for both.
 *
 *   `driveSegments`  UNROOTED — what Drive is given. `ensureFolderPath` is IMPORTED FROM THE APP
 *                    (`drive-tree.ts`) and starts at `ensureRootFolder()`, which IS the cabinet.
 *                    This script used to carry its OWN copy, rooted at
 *                    `GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID || "Phoenix CVs"` — the FROZEN tree — so a
 *                    `--refile` wrote the cabinet path into the database and put the FILE in the old
 *                    tree. Measured on production 2026-09-09: 32 CVs filed into
 *                    `Phoenix CVs/Medical Representative/<region>` while every count read clean,
 *                    because `--verify` compares the stored STRING. Two roots, two names for the
 *                    same idea, and only one of them was the cabinet. Handing it a
 *                    rooted array makes it create a folder named "Phoenix CV Cabinet" INSIDE the
 *                    cabinet and file everything one level too deep.
 *   `storedPathKey`  ROOTED — what `drive_mirror_path` records. The prefix is the cutover safety
 *                    property: without it a legacy path in the frozen `Phoenix CVs` tree is
 *                    indistinguishable from a cabinet path, and the mirror would empty the old tree
 *                    one candidate at a time.
 *
 * `drive-cv-mirror.ts` has always kept them apart — `path` to `moveDriveFile`, `pathKey` to the
 * database — and this now matches it exactly.
 *
 * Measured on production 2026-09-08: a `--refile` run passing the rooted array created a SECOND
 * "Phoenix CV Cabinet" and moved 264 CVs into it. Every check passed while it happened, because
 * `--verify` compares `drive_mirror_path` as a STRING: the string was right, the folder it named
 * was a different folder with the same name.
 */
// `input` is the whole per-FILE question (see cv-cabinet-context.mjs), not the candidate alone: since
// 2026-09-12 the cabinet files by the channel a CV arrived on and red-flags it by its own verdict,
// intake record and siblings, none of which the candidate row carries.
function cabinetDriveSegments(input, areaRegions) {
  return cabinetPathFor(input, areaRegions);
}

function cabinetStoredPathKey(input, areaRegions) {
  return [CABINET_ROOT_NAME, ...cabinetDriveSegments(input, areaRegions)].join("/");
}

/**
 * Every CV row each of these candidates has, keyed by candidate — the input `shouldMirrorCopy` needs.
 *
 * WHY THIS EXISTS, MEASURED. A byte-identical re-send is suppressed on purpose: the live mirror and
 * `build-cv-cabinet.mjs` both run `chooseCvCopies`, so the row is kept as the record that the person
 * sent the file again while the COPY never reaches the cabinet. This script did not ask, and a
 * suppressed row is indistinguishable here from one whose upload failed — both simply have no
 * `drive_mirror_file_id`. On 2026-09-11 that put four duplicates back into the cabinet, one of them
 * a sixteenth copy of the same CV, and `--verify` had been reporting the same rows as "NOT mirrored
 * yet" every morning for days: the report was reading a deliberate suppression as a backlog.
 *
 * The whole row set is needed, not just the unmirrored ones. `chooseCvCopies` keeps the OLDEST copy
 * of each fingerprint, so a decision taken over the unmirrored rows alone would elect a second
 * keeper for a fingerprint already in Drive — the same duplicate by a subtler route.
 *
 * Chunked at 25 ids and paged: a PostgREST `.in()` returns ZERO rows and NO error once the list
 * grows long, and an unbounded select stops at 1000 with no marker. One candidate here holds 20 CV
 * rows, so a 50-id chunk could reach that ceiling on a bad day and silently drop the siblings that
 * prove a row is a duplicate — which would fail OPEN, straight back into re-uploading copies.
 */
async function loadCvSiblingsByCandidate(candidateIds) {
  const wanted = [...new Set(candidateIds.filter(Boolean))];
  const byCandidate = new Map();
  const PAGE = 500;
  for (let at = 0; at < wanted.length; at += 25) {
    const chunk = wanted.slice(at, at + 25);
    for (let offset = 0; ; offset += PAGE) {
      const page = await rest(
        `ats_files?select=id,candidate_id,content_md5,created_at&kind=eq.cv&drive_file_id=not.is.null`
          + `&candidate_id=in.(${chunk.join(",")})&order=created_at.asc,id.asc&offset=${offset}&limit=${PAGE}`,
      );
      for (const row of page) {
        if (!byCandidate.has(row.candidate_id)) byCandidate.set(row.candidate_id, []);
        byCandidate.get(row.candidate_id).push(row);
      }
      if (page.length < PAGE) break;
    }
  }
  return byCandidate;
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

  // The auto-forward flag reads the same import-sender lists the intake does. Missing locally, they
  // would turn the owner's own forwards into applicants, so the run refuses rather than disagreeing
  // with the live mirror.
  const importSenders = requireImportSenders();

  if (VERIFY) {
    await verifyMirror(areaRegions, importSenders);
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
      `ats_files?select=id,candidate_id,content_md5,created_at,file_name,mime_type,drive_file_id,drive_mirror_file_id,drive_mirror_path,drive_mirror_error,upload_origin&kind=eq.cv&drive_file_id=not.is.null${mirrorClause}${failedClause}&order=created_at.asc,id.asc&offset=${offset}&limit=${PAGE}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const todo = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`${rows.length} CV file(s) not yet in Drive; processing ${todo.length}.\n`);
  if (todo.length === 0) return;

  // Asked once for the whole run, never per file: the answer is a property of the candidate's rows.
  // `--refile` needs it as much as an upload does — a byte-identical copy ALREADY in Drive now moves
  // to `Red flags/Duplicate copies`, and only the full sibling set can say which copy is the original.
  const siblings = await loadCvSiblingsByCandidate(todo.map((file) => file.candidate_id));
  const facts = await loadCabinetFacts(rest, todo.map((file) => file.id));

  const counts = { duplicate: 0, failed: 0, moved: 0, removed: 0, skipped: 0, unchanged: 0, uploaded: 0 };
  const treePreview = new Map();

  for (const [index, file] of todo.entries()) {
    const position = `${index + 1}/${todo.length}`;
    try {
      if (!file.candidate_id) {
        counts.skipped += 1;
        continue;
      }
      const candidates = await rest(
        `ats_candidates?select=id,full_name,phone,whatsapp,applied_for_job_title,preferred_area_name,preferred_region_code,preferences_declared_at&id=eq.${file.candidate_id}`,
      );
      const candidate = candidates[0];
      if (!candidate) {
        counts.skipped += 1;
        continue;
      }

      // THE SAME RULE THE RUNNING SITE APPLIES, asked of the app rather than restated here. A row
      // the app suppressed is not a gap to fill — uploading it is what puts a duplicate back.
      if (!REFILE && !shouldMirrorCopy(file.id, siblings.get(file.candidate_id) ?? [file])) {
        counts.duplicate += 1;
        continue;
      }

      // UNROOTED for Drive, ROOTED for the database. See cabinetDriveSegments.
      const input = cabinetInputFor({
        candidate,
        facts,
        file,
        importSenders,
        siblings: siblings.get(file.candidate_id) ?? [file],
      });
      const segments = cabinetDriveSegments(input, areaRegions);
      const name = driveFileName(candidate, file.mime_type, file.file_name);
      const key = cabinetStoredPathKey(input, areaRegions);
      if (!REFILE || file.drive_mirror_path !== key) {
        treePreview.set(key, (treePreview.get(key) ?? 0) + 1);
      }

      if (REFILE) {
        // Binned in Drive by a person. Left exactly where it is: re-filing it would overrule a
        // deliberate deletion, the same reason the live mirror keeps its hands off it.
        if (file.drive_mirror_error === REMOVED_FROM_DRIVE_BY_HAND) {
          counts.removed += 1;
          continue;
        }
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
        // The APP's move, not a local copy of it: it asks Drive whether the file was binned BEFORE it
        // creates any folder, and drops every other parent so a CV never sits in two folders.
        const moved = await moveDriveFile({ driveFileId: file.drive_mirror_file_id, path: segments });
        if (moved === "trashed") {
          await rest(`ats_files?id=eq.${file.id}`, {
            body: JSON.stringify({
              drive_mirror_at: new Date().toISOString(),
              drive_mirror_error: REMOVED_FROM_DRIVE_BY_HAND,
            }),
            headers: { Prefer: "return=minimal" },
            method: "PATCH",
          });
          counts.removed += 1;
          continue;
        }
        if (moved === "missing") {
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
      ? `\n${DRY_RUN ? "Would move" : "Moved"}: ${counts.moved}   already correct: ${counts.unchanged}`
        + `   binned by hand, left alone: ${counts.removed}   skipped: ${counts.skipped}   failed: ${counts.failed}`
      : `\n${DRY_RUN ? "Would upload" : "Uploaded"}: ${counts.uploaded}   skipped: ${counts.skipped}`
        + `   re-sent copies left alone: ${counts.duplicate}   failed: ${counts.failed}`,
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
async function verifyMirror(areaRegions, importSenders) {
  const rows = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(
      `ats_files?select=id,candidate_id,content_md5,created_at,drive_mirror_file_id,drive_mirror_path,drive_mirror_error,upload_origin&kind=eq.cv&drive_file_id=not.is.null&order=created_at.asc,id.asc&offset=${offset}&limit=${PAGE}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  // One request per file would be 950+ round-trips for a report somebody should be able to run
  // casually. Chunked at 50 ids: PostgREST returns ZERO rows and NO error once an `in.()` list
  // grows to several hundred, so the chunk size here is a correctness limit, not a tuning knob.
  const wanted = [...new Set(rows.map((f) => f.candidate_id).filter(Boolean))];
  const byId = new Map();
  // The four answers the cabinet files by. Omitting any one silently files an answered applicant
  // shallower than the app did, so the verifier would call a correctly filed CV misfiled.
  const SELECT = "id,full_name,applied_for_job_title,preferred_area_name,preferred_region_code,preferences_declared_at";
  for (let at = 0; at < wanted.length; at += 50) {
    const chunk = wanted.slice(at, at + 50);
    const page = await rest(`ats_candidates?select=${SELECT}&id=in.(${chunk.join(",")})`);
    for (const candidate of page) byId.set(candidate.id, candidate);
  }

  // Every CV row this candidate has, so a row with no Drive file can be told apart from a row that
  // was never meant to have one. Built from `rows`, which is already the WHOLE pool — no second read.
  const siblings = new Map();
  for (const file of rows) {
    if (!file.candidate_id) continue;
    if (!siblings.has(file.candidate_id)) siblings.set(file.candidate_id, []);
    siblings.get(file.candidate_id).push(file);
  }

  // Only mirrored rows are compared against a folder, so only they need the per-file facts.
  const facts = await loadCabinetFacts(rest, rows.filter((file) => file.drive_mirror_file_id).map((file) => file.id));

  const stats = {
    duplicateCopy: 0,
    errored: 0,
    misfiled: 0,
    mirrored: 0,
    notMirrored: 0,
    orphanCandidate: 0,
    removedByHand: 0,
    total: rows.length,
  };
  const moves = new Map();
  for (const file of rows) {
    // A CV somebody binned in Drive is a STATE, not a failed attempt. Counting it as an error made
    // the report say "run with --retry", which would re-upload a file that was deleted on purpose.
    if (file.drive_mirror_error === REMOVED_FROM_DRIVE_BY_HAND) stats.removedByHand += 1;
    else if (file.drive_mirror_error) stats.errored += 1;
    if (!file.drive_mirror_file_id) {
      // A byte-identical re-send is SUPPRESSED, not missing. Counting it as a backlog is what made
      // this report ask for an upload that puts a duplicate back in the cabinet — and because the
      // same rows persist, it asked again every morning, which is how a daily check earns its
      // first ignored alarm.
      if (shouldMirrorCopy(file.id, siblings.get(file.candidate_id) ?? [file])) stats.notMirrored += 1;
      else stats.duplicateCopy += 1;
      continue;
    }
    stats.mirrored += 1;
    // Binned by hand and left where it was on purpose — never "in the wrong folder".
    if (file.drive_mirror_error === REMOVED_FROM_DRIVE_BY_HAND) continue;
    const candidate = file.candidate_id ? byId.get(file.candidate_id) : null;
    if (!candidate) {
      stats.orphanCandidate += 1;
      continue;
    }
    const expected = cabinetStoredPathKey(
      cabinetInputFor({ candidate, facts, file, importSenders, siblings: siblings.get(file.candidate_id) ?? [file] }),
      areaRegions,
    );
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
  console.log(
    `  re-sent copies, never filed   ${stats.duplicateCopy}`
      + `${stats.duplicateCopy ? "   <- byte-identical re-sends, suppressed on purpose" : ""}`,
  );
  console.log(`  last attempt errored          ${stats.errored}${stats.errored ? "   <- run with --retry" : ""}`);
  console.log(
    `  deleted in Drive by hand      ${stats.removedByHand}`
      + `${stats.removedByHand ? "   <- left alone on purpose, nothing to do" : ""}`,
  );
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
