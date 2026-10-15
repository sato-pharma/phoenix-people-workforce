import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { selectAutoApplyFields, type AutoApplyExtractedFields } from "@/lib/recruitment/cv-auto-apply";
import { getCandidate, updateCandidate } from "@/lib/recruitment/candidates";
import { isCvRereadMarker } from "@/lib/recruitment/ops-marker";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "recruitment-apply-reread-fields",
  entry: import.meta.url,
  known: ["--dry-run"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Apply the high-confidence fields from the CV re-read onto the candidates.
//
// Owner approval: 2026-08-16 ("apply the high confidence fields"), following the re-read in
// scripts/recruitment-reread-never-read-cvs.ts.
//
// THIS INVENTS NO RULE. It calls selectAutoApplyFields — the exact pure function that inbound
// intake calls on every arriving CV — and then updateCandidate, the same writer. What lands here
// is precisely what would have landed automatically had these 49 CVs been read at intake time.
// The five gates are that function's, not this script's:
//
//   1. confidence must be "high" (repeating blocks carry no per-entry confidence and skip this).
//   2. the field must be a real ats_candidates column, or a repeating block.
//   3. fullName and email are NEVER written — they are the dedupe-deciding keys, and rewriting
//      either can repoint one person's record at another. So this does NOT fix the candidates
//      named after the email sender; that is a separate, still-open owner ruling.
//   4. phone only when the intake CREATED the candidate, never when it MATCHED one.
//   5. the column must currently be BLANK. This only ever fills gaps — a human edit or an
//      earlier extraction always wins.
//
// applied_fields is deliberately NOT written, exactly as intake declines to write it: it means
// "a human reviewed and saved this one", and an unattended write must not claim that.
//
// The unique-index trap is handled the way intake handles it. phone_norm carries a partial UNIQUE
// index with no trigger maintaining it, so a colliding phone rejects the WHOLE update and would
// take governorate, university and every other enriched column down with it. On failure we retry
// once without the phone so the rest still lands. Writing through updateCandidate (rather than raw
// SQL) is what keeps phone_norm/email_norm correct in the first place.
//
// TARGET IS PRODUCTION (.env.local). Run --dry-run first; it prints the exact per-candidate
// mutation and writes nothing.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-loader ./tests/alias-loader.mjs \
//        scripts/recruitment-apply-reread-fields.ts [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────

type Plan = {
  candidateId: string;
  storedName: string | null;
  createdByIntake: boolean;
  fields: Record<string, unknown>;
  blockKeys: string[];
  skippedPhoneReason?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

// THE ONE PLACE THIS SCRIPT IS STRICTER THAN THE SHIPPED RULE, AND IT IS DELIBERATE.
//
// selectAutoApplyFields gates the phone on confidence and blankness and NOTHING ELSE — it has no
// idea what a phone number looks like. Measured on this batch, 8 of 42 high-confidence phones are
// two or three numbers run together: "<11 digits> & <11 digits>" (22 digits in one column),
// "+91-<10>/<10>/<10>" (32). Writing one is worse than leaving the column blank,
// because phone_norm carries it into the partial UNIQUE index and a real dedupe later fails
// against a value that was never a phone number.
//
// Same rule the 2026-08-16 phone backfill used: 10-13 digits, plus 14 when it starts 0020.
// This is an ops guard, not an edit to cv-auto-apply.ts — the shipped rule needs the same check
// and that is a reviewed code change, not something to smuggle in from a script.
function isUsablePhone(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length >= 10 && digits.length <= 13) return true;
  return digits.length === 14 && digits.startsWith("0020");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`Mode             : ${dryRun ? "DRY RUN — nothing is written" : "WRITING"}`);

  // EVERY extraction, not just the re-read's own. Widened 2026-08-16 on the owner's instruction
  // to "apply the names and fields". This is safe precisely because selectAutoApplyFields only
  // ever fills a column that is currently BLANK — it cannot overwrite a human edit or an earlier
  // extraction — and roughly 200 of these candidates were read BEFORE auto-apply-at-intake
  // shipped, so their extracted values have never reached the columns at all.
  const { data: extractionRows, error: extractionError } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("id, candidate_id, extracted_fields, position_key, created_by, created_at")
    .order("created_at", { ascending: true });
  if (extractionError) throw extractionError;

  // A candidate can hold several extraction rows; the latest wins.
  const latestByCandidate = new Map<string, (typeof extractionRows)[number]>();
  for (const row of extractionRows ?? []) latestByCandidate.set(String(row.candidate_id), row);
  // Prefix, never an exact marker. This line used to compare against a hardcoded
  // `ops:cv-reread-20260816`, which is the reason the writer could never be allowed to move: the
  // two were kept in agreement only by both being frozen.
  const fromReread = [...latestByCandidate.values()].filter((row) => isCvRereadMarker(row.created_by)).length;
  console.log(`Extractions         : ${(extractionRows ?? []).length} rows, ${latestByCandidate.size} candidates`);
  console.log(`  of which re-read  : ${fromReread}`);

  // The shipped phone gate: allowed on candidate_created, withheld on candidate_matched. A
  // candidate carrying BOTH events has a second CV on file whose identity was resolved
  // separately, so it is treated as matched — the stricter reading.
  const { data: intakeRows, error: intakeError } = await supabase
    .from("ats_cv_intake_events")
    .select("candidate_id, outcome")
    .in("candidate_id", [...latestByCandidate.keys()]);
  if (intakeError) throw intakeError;
  const everMatched = new Set(
    (intakeRows ?? []).filter((row) => row.outcome === "candidate_matched").map((row) => String(row.candidate_id)),
  );

  const plans: Plan[] = [];
  for (const [candidateId, extraction] of latestByCandidate) {
    const candidate = await getCandidate(candidateId);
    if (!candidate) {
      console.log(`  ${candidateId}  ->  SKIPPED (candidate no longer exists)`);
      continue;
    }
    // The 6 staff-mailbox records retired by the forwarded-CV split. They are not applicants, so
    // enriching them with a university and a work history read off somebody else's forwarded CV
    // would put fiction on a colleague's record.
    if (candidate.status === "rejected") continue;

    const createdByIntake = !everMatched.has(candidateId);
    const autoApply = selectAutoApplyFields({
      candidate,
      candidateWasCreatedByThisIntake: createdByIntake,
      extractedFields: (extraction.extracted_fields ?? {}) as AutoApplyExtractedFields,
      positionKey: String(extraction.position_key),
    }) as Record<string, unknown>;

    let heldBackPhone: string | null = null;
    if (autoApply.phone !== undefined && !isUsablePhone(autoApply.phone)) {
      heldBackPhone = String(autoApply.phone);
      delete autoApply.phone;
    }

    if (Object.keys(autoApply).length === 0) {
      if (heldBackPhone) console.log(`  HELD BACK  ${candidate.fullName}: "${heldBackPhone}" is not a single phone number`);
      continue;
    }
    if (heldBackPhone) console.log(`  HELD BACK  ${candidate.fullName}: "${heldBackPhone}" is not a single phone number`);

    const blocks = (autoApply.positionSpecificFields as Record<string, unknown> | undefined) ?? {};
    plans.push({
      candidateId,
      storedName: candidate.fullName ?? null,
      createdByIntake,
      fields: autoApply,
      blockKeys: Object.keys(blocks),
      skippedPhoneReason: createdByIntake ? undefined : "candidate was MATCHED by a later intake, not created",
    });
  }

  console.log(`\nCandidates with something to write: ${plans.length}\n`);

  const columnCounts = new Map<string, number>();
  for (const plan of plans) {
    for (const key of Object.keys(plan.fields)) {
      if (key === "positionSpecificFields") continue;
      columnCounts.set(key, (columnCounts.get(key) ?? 0) + 1);
    }
    for (const key of plan.blockKeys) columnCounts.set(`block:${key}`, (columnCounts.get(`block:${key}`) ?? 0) + 1);
  }
  console.log("Field                          Candidates");
  for (const [key, count] of [...columnCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(30)} ${count}`);
  }

  const outDir = process.env.CV_REREAD_OUT_DIR ?? path.join(process.cwd(), ".cv-reread");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "cv-apply-plan.json"), JSON.stringify(plans, null, 2), "utf8");
  console.log(`\nPlan: ${path.join(outDir, "cv-apply-plan.json")}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  let written = 0;
  let phoneRejected = 0;
  let failed = 0;
  for (const plan of plans) {
    try {
      await updateCandidate(plan.candidateId, plan.fields as never);
      written += 1;
    } catch (writeError) {
      if (plan.fields.phone === undefined) {
        failed += 1;
        console.log(`  FAILED ${plan.storedName ?? plan.candidateId}: ${(writeError as Error).message.slice(0, 120)}`);
        continue;
      }
      const { phone: _rejected, ...withoutPhone } = plan.fields;
      try {
        if (Object.keys(withoutPhone).length > 0) await updateCandidate(plan.candidateId, withoutPhone as never);
        phoneRejected += 1;
        console.log(`  PHONE REJECTED (rest applied) ${plan.storedName ?? plan.candidateId}`);
      } catch (secondError) {
        failed += 1;
        console.log(`  FAILED ${plan.storedName ?? plan.candidateId}: ${(secondError as Error).message.slice(0, 120)}`);
      }
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Written                    : ${written}`);
  console.log(`Written without the phone  : ${phoneRejected}`);
  console.log(`Failed                     : ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
