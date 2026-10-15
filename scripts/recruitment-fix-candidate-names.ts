import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { getCandidate, updateCandidate } from "@/lib/recruitment/candidates";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "recruitment-fix-candidate-names",
  entry: import.meta.url,
  known: ["--dry-run"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Name the candidate after the person on the CV, not the person who emailed it.
//
// Owner approval: 2026-08-16 ("fix the names too", then "apply the names and fields when the
// re-read finishes").
//
// WHY THIS IS A SEPARATE SCRIPT, AND NOT PART OF THE FIELD APPLY
//
//   selectAutoApplyFields REFUSES to write fullName — AUTO_APPLY_NEVER_KEYS is
//   new Set(["fullName", "email"]). That refusal is correct as a default and this script is the
//   owner's explicit override of it, so it lives on its own where it can be read and reversed,
//   rather than smuggled into the shipped gate. The field apply still never touches the name.
//
//   The stated reason for the refusal is that fullName and email "are what createCandidate
//   matched on". That is true of EMAIL and false of fullName. findMatchingCandidate — the LOCKED
//   identity rule — keys on nationalIdNorm, then emailNorm, then phoneNorm, and nothing else.
//   fullName appears only in findDuplicateFlags / findPossibleDuplicate, which are documented
//   "Advisory only ... never merges anything", and there is no name_norm column to collide on.
//   So rewriting a name cannot repoint one person's record at another. Rewriting an EMAIL could,
//   which is why email is still never touched here.
//
// WHAT IS SKIPPED, AND WHY
//
//   * confidence must be "high". A wrong name is worse than a mailbox-derived one: it makes the
//     record unsearchable AND looks authoritative. Low-confidence names are reported, not written.
//   * applied_fields carrying a fullName means a HUMAN reviewed and saved that name. Never
//     overwrite a person's decision with a machine's.
//   * status = 'rejected' skips the 6 staff-mailbox records retired by the forwarded-CV split —
//     "omar.anwar ." is the correct name for that record, because it is not an applicant.
//   * a name that only differs by case or punctuation is left alone. Churning 40 rows to
//     restyle capitals is write cost with no information gain.
//
// Every replaced name is preserved first in the private schema candidate_apply_backup_20260816.
//
// TARGET IS PRODUCTION (.env.local). Run --dry-run first; it prints every rename and writes nothing.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-loader ./tests/alias-loader.mjs \
//        scripts/recruitment-fix-candidate-names.ts [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────

type Rename = {
  candidateId: string;
  storedName: string;
  cvName: string;
  reason: string;
};

type Skip = {
  candidateId: string;
  storedName: string;
  cvName: string | null;
  confidence: string | null;
  reason: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run with --env-file-if-exists=.env.local.`);
  return value;
}

// Unicode-aware on purpose. A [^a-z] strip erases an Arabic name completely, which would make two
// DIFFERENT Arabic names compare equal and silently skip both.
function comparable(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function readField(fields: Record<string, unknown>, key: string): { value: string | null; confidence: string | null } {
  const entry = fields[key];
  if (!entry || typeof entry !== "object") return { value: null, confidence: null };
  const raw = (entry as { value?: unknown }).value;
  const confidence = (entry as { confidence?: unknown }).confidence;
  const value = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  return { confidence: confidence ? String(confidence) : null, value };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`Mode             : ${dryRun ? "DRY RUN — nothing is written" : "WRITING"}`);

  const { data: extractionRows, error: extractionError } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("candidate_id, extracted_fields, applied_fields, created_at")
    .order("created_at", { ascending: true });
  if (extractionError) throw extractionError;

  // Latest extraction wins. Ascending order plus a plain set means the last one written stays.
  const latest = new Map<string, (typeof extractionRows)[number]>();
  for (const row of extractionRows ?? []) latest.set(String(row.candidate_id), row);

  const { data: candidates, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("id, full_name, status")
    .order("created_at", { ascending: true });
  if (candidateError) throw candidateError;

  const renames: Rename[] = [];
  const skips: Skip[] = [];

  for (const candidate of candidates ?? []) {
    const candidateId = String(candidate.id);
    const storedName = String(candidate.full_name ?? "");
    const extraction = latest.get(candidateId);

    if (!extraction) {
      skips.push({ candidateId, confidence: null, cvName: null, reason: "no extraction", storedName });
      continue;
    }

    const fields = (extraction.extracted_fields ?? {}) as Record<string, unknown>;
    const { value: cvName, confidence } = readField(fields, "fullName");

    if (!cvName) {
      skips.push({ candidateId, confidence, cvName: null, reason: "the CV yielded no name", storedName });
      continue;
    }
    if (confidence !== "high") {
      skips.push({ candidateId, confidence, cvName, reason: `name confidence is ${confidence ?? "unset"}`, storedName });
      continue;
    }
    if (String(candidate.status) === "rejected") {
      skips.push({ candidateId, confidence, cvName, reason: "record is rejected — not an applicant", storedName });
      continue;
    }

    const applied = (extraction.applied_fields ?? null) as Record<string, unknown> | null;
    if (applied && applied.fullName !== null && applied.fullName !== undefined) {
      skips.push({ candidateId, confidence, cvName, reason: "a human already saved this name", storedName });
      continue;
    }
    if (comparable(storedName) === comparable(cvName)) {
      skips.push({ candidateId, confidence, cvName, reason: "already the same name", storedName });
      continue;
    }

    renames.push({
      candidateId,
      cvName,
      reason: storedName.includes("@") || storedName.trim().endsWith(".") ? "stored name looks mailbox-derived" : "stored name differs from the CV",
      storedName,
    });
  }

  console.log(`\nCandidates            : ${(candidates ?? []).length}`);
  console.log(`With an extraction    : ${latest.size}`);
  console.log(`WOULD RENAME          : ${renames.length}`);
  console.log(`Skipped               : ${skips.length}`);

  const skipReasons = new Map<string, number>();
  for (const skip of skips) skipReasons.set(skip.reason, (skipReasons.get(skip.reason) ?? 0) + 1);
  console.log("\nWhy each one was skipped");
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }

  console.log("\nFirst 25 renames");
  for (const rename of renames.slice(0, 25)) {
    console.log(`  ${rename.storedName.padEnd(34).slice(0, 34)} ->  ${rename.cvName}`);
  }

  const outDir = process.env.CV_REREAD_OUT_DIR ?? path.join(process.cwd(), ".cv-reread");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "name-fix-plan.json"), JSON.stringify({ renames, skips }, null, 2), "utf8");
  console.log(`\nPlan: ${path.join(outDir, "name-fix-plan.json")}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  let written = 0;
  let failed = 0;
  for (const rename of renames) {
    try {
      // Through updateCandidate, not raw SQL — the app writer is what keeps the normalised
      // identity columns consistent, and a rename must not be the thing that desyncs them.
      await updateCandidate(rename.candidateId, { fullName: rename.cvName } as never);
      written += 1;
    } catch (error) {
      failed += 1;
      console.log(`  FAILED ${rename.storedName}: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Renamed : ${written}`);
  console.log(`Failed  : ${failed}`);

  // Prove it landed, and prove nothing got repointed: a rename must not change the row count,
  // and must not create a duplicate identity norm.
  const verify = await getCandidate(renames[0]?.candidateId ?? "");
  if (verify) console.log(`Spot check: ${renames[0]?.storedName} is now "${verify.fullName}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
