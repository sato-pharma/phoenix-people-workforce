import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { normalizePhone } from "@/lib/recruitment/candidate-matching";
import { createCandidate, getCandidate, updateCandidate } from "@/lib/recruitment/candidates";
import { candidateIdentityFromCvFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey } from "@/lib/recruitment/cv-field-schemas";
import { selectAutoApplyFields, type AutoApplyExtractedFields } from "@/lib/recruitment/cv-auto-apply";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "recruitment-split-forwarded-candidates",
  entry: import.meta.url,
  known: ["--dry-run"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Split the forwarded CVs into their own candidates.
//
// Owner approval: 2026-08-16 ("go ahead with the 5"), after the inventory showed the 19 files
// held by 6 staff mailbox records are only 5 real applicants.
//
// WHY ONLY 5 OF 19. A colleague's email address is a dedupe key, so every CV any of them
// forwarded matched the FIRST record made from that address and piled in behind it. The other
// 14 files are not applications and must not become candidates:
//
//   Dr Hatem Sorour RM JO.pdf / Nagwa Bahgat Job offer (2).pdf  job offers PHOENIX SENT, never read
//   page 1 ultrasound.jpeg                                a maternity-leave document
//   Plan A.png x2                                         0 extracted fields
//   IMG_20260603_150349.jpg                               no name, 2 fields
//   ymail-tmp-5013425966746647615.jpg                     the forwarding colleague herself
//   27.jpg x6, Nabil Wassef.pdf x1                     byte-identical duplicate uploads
//
// They stay attached to the holder record, where they are visibly wrong rather than invisibly
// wrong as five junk candidates.
//
// AND THE LIST ABOVE WAS WRONG ABOUT ONE OF ITS OWN FILES. It excludes `page 1 ultrasound.jpeg` as
// "a maternity-leave document" — but IMG_20260525_072106.jpg, in SPLITS below, came out of that
// SAME thread and is a DOCTOR'S PRESCRIPTION. It was split out as "Adib R. S. Kaldas": the name,
// phone and Alexandria address on it are the CLINIC'S LETTERHEAD, not an applicant's. The owner
// opened the file and confirmed it on 2026-08-21, and that candidate was deleted from production
// the same day (its ats_files row went with it, so re-running this entry now fails loudly at the
// file lookup — which is the correct outcome, and the entry is kept so the run's history stays
// honest rather than quietly edited out).
//
// 27.jpg / "Mostafa Hisham Zaki" IS STILL UNRESOLVED. It arrived under the subject "Certificate
// of Attendance - Pharmacy Promotion & OTC Campaign" and its extraction holds a full name and
// NOTHING ELSE — the signature of a letterhead, not a CV. But omar.anwar's own hand-written note
// calls that file a CV photo, so a human who looked disagreed. Do not delete it on the fingerprint;
// open the file.
//
// The guard that let the prescription through was `identity.fullName === expectName` — it only
// re-asserted that the page still says the same name. A prescription has a name on it. There is now
// an is_cv check beside it (see the extraction fetch below), which is the model's own answer to the
// question this script was never asking.
//
// THE COLLISION THAT MUST BE CLEARED FIRST. Intake wrote the APPLICANT's phone onto the
// FORWARDING COLLEAGUE's record: two colleagues each carried an applicant's own mobile number
// (numbers redacted here — see the run report in the ops archive). phone_norm has a partial UNIQUE index
// with no trigger behind it, so creating the applicant with her own number is rejected outright
// while the colleague's record still holds it. The phone is cleared from the colleague first,
// through updateCandidate so phone_norm goes with it, and then belongs to the applicant alone.
//
// THIS INVENTS NO RULE. Identity comes from candidateIdentityFromCvFields and the enrichment
// from selectAutoApplyFields — the two functions inbound intake itself calls. The create is
// createCandidate, so National ID / email / phone dedupe still runs and a genuine duplicate
// MATCHES instead of spawning a twin. A match is treated as a hard stop, not a success: this
// script is a split, and quietly merging into somebody else is the one outcome it must not have.
//
// NO NOTIFICATION FIRES. createCandidate inserts and returns; the only notify path in
// candidates.ts is pushCandidatesToManager, which nothing here calls, and the "new CV received"
// alert lives in the inbound intake service, which this never enters. Counted before and after
// regardless — see the notification blast-radius check at the end.
//
// TARGET IS PRODUCTION (.env.local). Before-state is already backed up in the private schema
// candidate_split_backup_20260816 (holders_before, files_before, extractions_before,
// intake_events_before). Run --dry-run first; it prints every mutation and writes nothing.
//
// Usage (from the worktree root):
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-loader ./tests/alias-loader.mjs \
//        scripts/recruitment-split-forwarded-candidates.ts [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────

// FROZEN ON PURPOSE. Do NOT convert this to a run-date stamp the way the CV re-read batches were
// on 2026-08-29 (src/lib/recruitment/ops-marker.ts). That change was right there and is wrong
// here, and the two cases look identical from the shape of the literal alone — which is exactly
// how this nearly got 'fixed'.
//
// Those scripts advertise themselves as SAFE TO RE-RUN and had stamped four separate runs with
// one date. This one is a completed one-shot: it finished 2026-08-16, and since the identities
// below were replaced with placeholders it fails closed at the expectName guard, so it can never
// legitimately run again. Its date is therefore a receipt of when it happened, not a stamp for
// when it next runs, and a dynamic marker would put a future date on a run that cannot occur.
const OPS_MARKER = "ops:forwarded-split-20260816";

// Hardcoded on purpose. These five file ids were resolved and eyeballed one by one against the
// per-file extraction; an allowlist is what stops a re-run or a stray edit from splitting the
// job offers or the ultrasound. Every one is re-asserted against its holder before anything moves.
//
// EVERY fileName AND expectName BELOW IS A PLACEHOLDER, substituted 2026-08-28. They were five real
// applicants' names and CV filenames, committed here while their applications were open. The file
// and holder ids are untouched, so the run stays traceable in production; the identities are gone
// and are not to come back. The consequence is deliberate: expectName no longer matches what the
// page says, so a re-run FAILS CLOSED at the guard and mutates nothing. That is the correct
// behaviour for a one-shot split that finished on 2026-08-16 — the ids are its receipt, not an
// invitation to run it again.
const SPLITS: ReadonlyArray<{ fileId: string; holderId: string; fileName: string; expectName: string }> = [
  {
    fileId: "a4bae64f-3607-4378-b4f2-4641116727a5",
    holderId: "8ebf318f-d44d-447c-b55a-056577aaf278",
    fileName: "Mirette.pdf",
    expectName: "MIRETTE WAGIH MORCOS",
  },
  {
    fileId: "3bd8af1e-75b7-4aee-a1cc-f01f54e65985",
    holderId: "d4bf194b-e62b-4ed6-bd99-be1121937070",
    fileName: "CV hala.pdf",
    expectName: "Hala Sanad Roshdy",
  },
  {
    fileId: "39ec34ae-0eac-48ca-9077-1a1b7d310263",
    holderId: "8ebf318f-d44d-447c-b55a-056577aaf278",
    fileName: "Nabil Wassef.pdf",
    expectName: "Nabil Wassef Gohar",
  },
  {
    fileId: "612337fc-46af-42ec-acb2-0411085f9d89",
    holderId: "797acd03-3183-4ec2-9d7e-f54cacc0ab2b",
    fileName: "IMG_20260525_072106.jpg",
    expectName: "Adib R. S. Kaldas",
  },
  {
    fileId: "08ccbb9b-c33f-4b7c-96e4-bc5ac2df9114",
    holderId: "7d53cde8-666b-4dd6-8fbe-cbe8b08cfdf3",
    fileName: "27.jpg",
    expectName: "Mostafa Hisham Zaki",
  },
];

const NOTIFICATION_TABLES = [
  "notification_events",
  "notification_outbox",
  "notification_deliveries",
  "ats_cv_intake_events",
  "ats_candidate_status_events",
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run with --env-file-if-exists=.env.local.`);
  return value;
}


async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Supabase project : ${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}`);
  console.log(`Mode             : ${dryRun ? "DRY RUN — nothing is written" : "WRITING"}`);

  const access: AccessContext = {
    hrId: null,
    loginId: OPS_MARKER,
    role: "Super Admin",
    scope: "system",
    source: "system",
  };

  const notificationsBefore: Record<string, number> = {};
  for (const table of NOTIFICATION_TABLES) {
    const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
    notificationsBefore[table] = error ? -1 : (count ?? 0);
  }
  console.log(`\nNotification-capable rows before: ${JSON.stringify(notificationsBefore)}`);

  const results: Array<Record<string, unknown>> = [];

  for (const split of SPLITS) {
    console.log(`\n${"─".repeat(70)}\n${split.fileName}`);

    const { data: file, error: fileError } = await supabase
      .from("ats_files")
      .select("id, candidate_id, file_name, kind")
      .eq("id", split.fileId)
      .single();
    if (fileError) throw fileError;

    // Re-assert the allowlist against live state. If the file has already moved, this run is a
    // repeat and the split is done — skip rather than create a second candidate for it.
    if (String(file.candidate_id) !== split.holderId) {
      console.log(`  SKIPPED — already moved off the holder record (now ${String(file.candidate_id)}).`);
      results.push({ fileName: split.fileName, status: "already_split" });
      continue;
    }
    if (file.file_name !== split.fileName) {
      throw new Error(`File ${split.fileId} is "${file.file_name}", expected "${split.fileName}". Refusing.`);
    }

    const { data: extraction, error: extractionError } = await supabase
      .from("ats_candidate_cv_extractions")
      .select("id, extracted_fields, position_key, is_cv")
      .eq("file_id", split.fileId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (extractionError) throw extractionError;
    if (!extraction) throw new Error(`No extraction for ${split.fileName}. Refusing to invent a candidate.`);

    // A NAME IS NOT A DOCUMENT TYPE, and until 2026-08-21 that was the only thing this script
    // checked. IMG_20260525_072106.jpg was a doctor's prescription forwarded inside an employee's
    // maternity-leave thread; the AI read the CLINIC LETTERHEAD, so a name, a phone and an
    // Alexandria address came back, the expectName check below passed, and a third-party
    // physician's practice details became a "candidate". Ask the read what the page IS.
    //
    // Explicit false only. NULL means the extraction predates is_cv or never reached the model,
    // which is not a verdict — failing closed on it would refuse every one of the rows written
    // before that date, including the four real applicants this script correctly split out.
    if (extraction.is_cv === false) {
      throw new Error(
        `${split.fileName} is not a CV — the read behind these fields judged is_cv=false. Refusing to make a candidate of it.`,
      );
    }

    const fields = (extraction.extracted_fields ?? {}) as AutoApplyExtractedFields;
    const identity = candidateIdentityFromCvFields({ fields } as never, split.expectName);
    if (identity.fullName !== split.expectName) {
      throw new Error(`${split.fileName} now reads "${identity.fullName}", expected "${split.expectName}". Refusing.`);
    }

    const holder = await getCandidate(split.holderId);
    if (!holder) throw new Error(`Holder ${split.holderId} not found.`);

    console.log(`  Holder      : ${holder.fullName}`);
    console.log(`  Applicant   : ${identity.fullName}`);
    console.log(`  Email       : ${identity.email ?? "(none on the CV)"}`);
    console.log(`  Phone       : ${identity.phone ?? "(none on the CV)"}`);

    // The applicant's phone sitting on the colleague's record. Clear it there FIRST or the
    // unique index rejects the create.
    // normalizePhone, not a local copy: it folds an Egyptian mobile's local and international
    // forms onto one key, so the holder's 01xxxxxxxxx and the applicant's 201xxxxxxxxx are
    // correctly seen as the same handset. Used to compare only — this never writes a value.
    const stealsPhone = Boolean(identity.phone) && normalizePhone(holder.phone) === normalizePhone(identity.phone);
    if (stealsPhone) {
      console.log(`  ACTION      : clear ${holder.phone} off ${holder.fullName} — it is the applicant's number`);
      if (!dryRun) await updateCandidate(split.holderId, { phone: null } as never);
    }

    const notes = [
      `Split out of the forwarded record "${holder.fullName}" on 16 Aug 2026.`,
      `The CV arrived as an attachment forwarded by a colleague, so intake keyed it on the sender's email address.`,
      `Original file: ${split.fileName}.`,
    ].join(" ");

    if (dryRun) {
      console.log(`  WOULD CREATE: ${identity.fullName}, then move the file, its extraction and its intake event.`);
      results.push({ fileName: split.fileName, status: "dry_run", name: identity.fullName, stealsPhone });
      continue;
    }

    const { candidate, created, matchReason } = await createCandidate(
      {
        email: identity.email,
        fullName: identity.fullName,
        notes,
        phone: identity.phone,
        source: "email",
      },
      access,
    );

    // A match means createCandidate resolved this CV onto somebody who already exists. That is a
    // merge, not a split — stop and report rather than move another person's file onto them.
    if (!created) {
      console.log(`  STOPPED — matched an existing candidate (${matchReason}): ${candidate.fullName}`);
      results.push({
        fileName: split.fileName,
        status: "matched_existing",
        matchReason: matchReason ?? null,
        matchedCandidateId: candidate.id,
        matchedName: candidate.fullName,
      });
      continue;
    }
    console.log(`  CREATED     : ${candidate.fullName}  (${candidate.id})`);

    // Same enrichment the intake would have run had this CV arrived on its own. The candidate is
    // brand new, so every column is blank and the "fill gaps only" gate lets the CV through.
    const autoApply = selectAutoApplyFields({
      candidate,
      candidateWasCreatedByThisIntake: true,
      extractedFields: fields,
      positionKey: String(extraction.position_key ?? defaultCvPositionKey),
    }) as Record<string, unknown>;
    if (Object.keys(autoApply).length > 0) {
      await updateCandidate(candidate.id, autoApply as never);
      console.log(`  ENRICHED    : ${Object.keys(autoApply).filter((k) => k !== "positionSpecificFields").join(", ")}`);
    }

    const { error: moveFileError } = await supabase
      .from("ats_files")
      .update({ candidate_id: candidate.id })
      .eq("id", split.fileId);
    if (moveFileError) throw moveFileError;

    const { error: moveExtractionError } = await supabase
      .from("ats_candidate_cv_extractions")
      .update({ candidate_id: candidate.id })
      .eq("file_id", split.fileId);
    if (moveExtractionError) throw moveExtractionError;

    const { data: movedEvents, error: moveEventError } = await supabase
      .from("ats_cv_intake_events")
      .update({ candidate_id: candidate.id })
      .eq("file_id", split.fileId)
      .select("id");
    if (moveEventError) throw moveEventError;

    console.log(`  MOVED       : 1 file, its extraction, ${(movedEvents ?? []).length} intake event(s)`);
    results.push({
      fileName: split.fileName,
      status: "split",
      candidateId: candidate.id,
      name: candidate.fullName,
      email: candidate.email ?? null,
      phone: candidate.phone ?? null,
      clearedHolderPhone: stealsPhone,
      holder: holder.fullName,
      intakeEventsMoved: (movedEvents ?? []).length,
    });
  }

  const notificationsAfter: Record<string, number> = {};
  for (const table of NOTIFICATION_TABLES) {
    const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
    notificationsAfter[table] = error ? -1 : (count ?? 0);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("Notification blast radius (before -> after):");
  for (const table of NOTIFICATION_TABLES) {
    const delta = notificationsAfter[table] - notificationsBefore[table];
    console.log(`  ${table.padEnd(30)} ${notificationsBefore[table]} -> ${notificationsAfter[table]}  (${delta >= 0 ? "+" : ""}${delta})`);
  }
  console.log(`\nSplit   : ${results.filter((r) => r.status === "split").length}`);
  console.log(`Skipped : ${results.filter((r) => r.status !== "split").length}`);

  const outDir = process.env.CV_REREAD_OUT_DIR ?? path.join(process.cwd(), ".cv-reread");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "forwarded-split-report.json");
  writeFileSync(outFile, JSON.stringify({ marker: OPS_MARKER, notificationsBefore, notificationsAfter, results }, null, 2), "utf8");
  console.log(`\nReport: ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
