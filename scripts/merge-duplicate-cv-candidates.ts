// Merges candidate records that were created from the SAME CV file, through the app's own merge.
//
// WHY THIS EXISTS. Until the content fingerprint landed (files.ts, cvContentFingerprint), the intake
// resolved an arriving CV to an existing candidate on national ID, then email, and nothing else. A
// CV forwarded over WhatsApp carries neither: the name comes from the file, and the phone stamped on
// the record is the FORWARDER's, not the applicant's. So the same document arriving twice produced
// two candidate records, and measured on production 2026-09-05 that had happened 21 times across 20
// documents — 986 files holding 739 distinct documents.
//
// The fingerprint stops the next one. This script clears the ones already there, and it goes through
// mergeCandidates rather than SQL for three reasons that each cost a real incident:
//
//  - `email`, `phone` and `national_id` each carry an app-maintained `_norm` twin that nothing in
//    the database writes. A raw UPDATE that borrowed an email without its `email_norm` would leave
//    the survivor findable by a recruiter and invisible to dedup — the exact condition that created
//    these duplicates.
//  - `ats_candidate_status_events` refuses an UPDATE unconditionally (immutability trigger), so its
//    rows must be COPIED. Two of the twenty-three merges run before 2026-09-04 stopped on precisely
//    that and left a half-emptied duplicate.
//  - mergeBlockReason is the only thing that knows a hired duplicate must never be deleted.
//
// The pairs are NOT chosen here. They come from a plan file built by a recorded SQL ranking against
// ats_backup_20260905.cv_dupe_merge_plan, whose pre-image of all 41 rows is the rollback.
//
// Run:
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//     scripts/merge-duplicate-cv-candidates.ts --plan <plan.json>          # dry run
//   ... --plan <plan.json> --apply                                        # writes

import fs from "node:fs";

import { systemAccessContext } from "@/lib/auth/permissions";
import { mergeCandidates } from "@/lib/recruitment/candidate-merge-service";
import { getCandidate } from "@/lib/recruitment/candidates";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "merge-duplicate-cv-candidates",
  entry: import.meta.url,
  known: ["--apply", "--plan"],
});

type PlannedMerge = {
  duplicateId: string;
  duplicateName: string;
  md5: string;
  survivorId: string;
  survivorName: string;
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const planPath = args[args.indexOf("--plan") + 1];
if (!planPath || !fs.existsSync(planPath)) {
  throw new Error("Pass --plan <path to the merge plan JSON>.");
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as PlannedMerge[];

// A survivor that is somebody else's duplicate would be deleted mid-run and take its borrowed rows
// with it. The plan is built to avoid that; this refuses to start if it ever stops being true.
const duplicateIds = new Set(plan.map((pair) => pair.duplicateId));
const chained = plan.filter((pair) => duplicateIds.has(pair.survivorId));
if (chained.length > 0) {
  throw new Error(
    `${chained.length} pair(s) name a survivor that is itself merged away elsewhere in this plan. `
    + "Resolve the chain before running.",
  );
}

console.log(`${plan.length} merges planned — ${apply ? "APPLYING" : "dry run, nothing will be written"}\n`);

let done = 0;
let failed = 0;

for (const [index, pair] of plan.entries()) {
  const label = `${index + 1}/${plan.length}  ${pair.duplicateName} -> ${pair.survivorName}`;
  try {
    if (!apply) {
      // Prove both rows are still there and still say what the plan says, so a dry run catches a
      // stale plan rather than discovering it halfway through a write.
      const [survivor, duplicate] = await Promise.all([
        getCandidate(pair.survivorId),
        getCandidate(pair.duplicateId),
      ]);
      if (!survivor) throw new Error("the record to keep no longer exists");
      if (!duplicate) throw new Error("the duplicate no longer exists — already merged?");
      console.log(`  ok    ${label}`);
      done += 1;
      continue;
    }

    const result = await mergeCandidates(systemAccessContext, {
      duplicateId: pair.duplicateId,
      survivorId: pair.survivorId,
    });
    console.log(`  done  ${label}`);
    console.log(`        ${result.summary}`);
    for (const line of result.leftBehind) console.log(`        left behind: ${line}`);
    done += 1;
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${done} succeeded, ${failed} failed, of ${plan.length}.`);
if (failed > 0) process.exitCode = 1;
