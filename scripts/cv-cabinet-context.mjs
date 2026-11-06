// Recruitment / ATS — the per-file facts the CV cabinet rule reads, loaded in bulk for the Drive scripts.
//
// `cabinetPathFor` files a CV by the line it ARRIVED on, by the applicant's own answers, and parks
// anything misleading under `Red flags`. Beyond the candidate it therefore needs three facts about
// each FILE: its intake record (`ats_cv_intake_events`), the extractor's verdict
// (`ats_candidate_cv_extractions`), and — for a CV a recruiter saved out of the WhatsApp inbox, which
// has no intake record at all — the line it came off (`whatsapp_inbox_messages`). The live mirror
// reads them per file; `backfill-cvs-to-drive.mjs` and `build-cv-cabinet.mjs` read them here, in
// bulk, and hand them to the same pure pickers the mirror uses — so a re-file can never choose a
// different record than the running site does.

import process from "node:process";

import {
  cabinetImportSendersFromEnv,
  earliestIntakeEvent,
  latestCvVerdict,
} from "@/lib/recruitment/drive-cabinet-folders";

// Chunked at 50 ids: a PostgREST `in.()` carrying several hundred ids returns ZERO rows and NO error,
// and an unbounded select stops at 1000. Both fail OPEN here — a file with no intake row is filed
// "Source unknown" and a missing verdict files a non-CV as a CV — so neither is a tuning knob.
const CHUNK = 50;
const PAGE = 500;

async function pagedByFile(rest, fileIds, buildQuery) {
  const rows = [];
  const wanted = [...new Set(fileIds.filter(Boolean))];
  for (let at = 0; at < wanted.length; at += CHUNK) {
    const idList = wanted.slice(at, at + CHUNK).join(",");
    for (let offset = 0; ; offset += PAGE) {
      const page = await rest(buildQuery(idList, offset, PAGE));
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return rows;
}

function groupByFile(rows) {
  const byFile = new Map();
  for (const row of rows) {
    if (!row.file_id) continue;
    if (!byFile.has(row.file_id)) byFile.set(row.file_id, []);
    byFile.get(row.file_id).push(row);
  }
  return byFile;
}

/** Every intake record, extraction verdict and inbox save for these files, keyed by file id. */
export async function loadCabinetFacts(rest, fileIds) {
  const events = await pagedByFile(
    rest,
    fileIds,
    (idList, offset, limit) =>
      `ats_cv_intake_events?select=file_id,channel,mailbox_label,sender_identifier,raw_metadata,created_at`
      + `&file_id=in.(${idList})&order=created_at.asc,id.asc&offset=${offset}&limit=${limit}`,
  );
  const verdicts = await pagedByFile(
    rest,
    fileIds,
    (idList, offset, limit) =>
      `ats_candidate_cv_extractions?select=file_id,is_cv,created_at`
      + `&file_id=in.(${idList})&order=created_at.asc,id.asc&offset=${offset}&limit=${limit}`,
  );
  // THE WHATSAPP LINE for a CV a recruiter saved out of the inbox. That file has no intake record —
  // a person moved it, nothing imported it — so the line lives on the inbox MESSAGE, joined back by
  // `saved_file_id`. Aliased to `file_id` so it groups like the other two, and asked for every file
  // rather than only the `whatsapp_inbox` ones: a file that is not one simply has no message.
  const inboxMessages = await pagedByFile(
    rest,
    fileIds,
    (idList, offset, limit) =>
      `whatsapp_inbox_messages?select=file_id:saved_file_id,line_display_number,saved_at`
      + `&saved_file_id=in.(${idList})&order=saved_at.asc,id.asc&offset=${offset}&limit=${limit}`,
  );
  return {
    inboxLineByFile: groupByFile(inboxMessages),
    intakeByFile: groupByFile(events),
    verdictsByFile: groupByFile(verdicts),
  };
}

/** The input `cabinetPathFor` takes, for one file. */
export function cabinetInputFor({ candidate, facts, file, importSenders, siblings }) {
  return {
    candidate,
    fileId: file.id,
    importSenders,
    intake: earliestIntakeEvent(facts.intakeByFile.get(file.id) ?? []),
    isCv: latestCvVerdict(facts.verdictsByFile.get(file.id) ?? []),
    siblings,
    // Off the FILE row, not a per-file lookup: `upload_origin` is a column on `ats_files` itself, so
    // every caller that selects it gets the interview-calendar channel for free. A caller that forgot
    // the column would hand in `undefined` and file the CV "Source unknown" — exactly the kind of
    // script-versus-site disagreement this shared loader exists to stop, which is why the registered
    // test asserts each script's own SELECT fetches it.
    uploadOrigin: file.upload_origin ?? null,
    // Read only when the origin is `whatsapp_inbox`; the earliest save wins, the way the earliest
    // intake event does, so a file saved twice cannot change folder between two runs.
    whatsappInboxLine: (facts.inboxLineByFile?.get(file.id) ?? [])[0]?.line_display_number ?? null,
  };
}

/**
 * The import-sender lists, or a hard stop.
 *
 * They are what tells the owner's own forwards from applicants, and `.env.local` does not carry them.
 * A run without them would file the owner's forwards as applicants while the live mirror parks them
 * under `Red flags/Auto-forwarded` — the two disagreeing is the exact defect these scripts were
 * rewritten to stop — so the run refuses instead of guessing.
 */
export function requireImportSenders(env = process.env) {
  const senders = cabinetImportSendersFromEnv(env);
  if (senders.whatsapp.length === 0) {
    console.error(
      "RECRUITMENT_WHATSAPP_IMPORT_SENDERS is not set, so the owner's own forwards would read as applicants.\n"
        + "Run this with production's variables loaded, for example:\n"
        + "  railway run node --experimental-strip-types --experimental-specifier-resolution=node "
        + "--experimental-loader ./tests/alias-loader.mjs scripts/<script>.mjs --dry-run",
    );
    process.exit(1);
  }
  return senders;
}
