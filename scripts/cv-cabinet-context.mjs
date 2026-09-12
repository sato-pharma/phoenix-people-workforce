// Recruitment / ATS — the per-file facts the CV cabinet rule reads, loaded in bulk for the Drive scripts.
//
// `cabinetPathFor` files a CV by the line it ARRIVED on, by the applicant's own answers, and parks
// anything misleading under `Red flags`. Beyond the candidate it therefore needs two facts about each
// FILE: its intake record (`ats_cv_intake_events`) and the extractor's verdict
// (`ats_candidate_cv_extractions`). The live mirror reads both per file; `backfill-cvs-to-drive.mjs`
// and `build-cv-cabinet.mjs` read them here, in bulk, and hand them to the same pure pickers the
// mirror uses — so a re-file can never choose a different record than the running site does.

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

/** Every intake record and every extraction verdict for these files, keyed by file id. */
export async function loadCabinetFacts(rest, fileIds) {
  const events = await pagedByFile(
    rest,
    fileIds,
    (idList, offset, limit) =>
      `ats_cv_intake_events?select=file_id,channel,mailbox_label,sender_identifier,raw_metadata,created_at`
      + `&file_id=in.(${idList})&order=created_at.asc&offset=${offset}&limit=${limit}`,
  );
  const verdicts = await pagedByFile(
    rest,
    fileIds,
    (idList, offset, limit) =>
      `ats_candidate_cv_extractions?select=file_id,is_cv,created_at`
      + `&file_id=in.(${idList})&order=created_at.asc&offset=${offset}&limit=${limit}`,
  );
  return { intakeByFile: groupByFile(events), verdictsByFile: groupByFile(verdicts) };
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
