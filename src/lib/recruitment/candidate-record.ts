// Recruitment / ATS — everything the system holds on ONE candidate, for the candidate's own page.
//
// The owner, 2026-09-18: pressing a candidate's name must open "a new page which shows the full
// details on everything for this candidate". Before this, the name opened nothing on the pool, and on
// WhatsApp Applicants it opened the screening page — which shows the CV, the screening summary and the
// decision buttons, and nothing of the files list, the manager sends, the hand-built folders, the
// applications, or who has already read the CV.
//
// READ-ONLY, AND THAT IS A RULE, NOT AN OMISSION. Opening a CV on the screening page marks it read
// for the person opening it and holds it for them for five minutes (candidate-views.ts). This page
// does neither. It is where somebody looks a person UP, and a look-up that claimed the CV would take
// it out of a colleague's queue, while one that marked it read would drop it from the reader's own
// "not read yet" pile without their having screened it. So nothing here writes, and the page never
// calls the /seen route. Decisions stay on the screening page, one click away.
//
// ONLY THE CANDIDATE ITSELF IS REQUIRED. Everything else is read beside it and each part fails on its
// own: a sends table that cannot be read leaves one section saying so, never a page that will not
// open. A part that failed is listed in `unavailable`, so the screen can say "could not be read"
// instead of drawing an empty section that reads as "there is nothing" (AGENTS.md §7: when a source is
// unavailable, the UI says so rather than showing a misleading zero).
//
// NAMES, NEVER IDS. Every HR id the record carries — who decided, who starred, who filed, who
// uploaded, who read — is resolved to a name here, on the server, in one query. The page prints the
// name or the words "Unnamed user"; it never prints the id.
//
// SERVER ONLY. Reaches the database. The page component receives the plain object this returns.

import { isBatchActor } from "@/lib/recruitment/batch-actor";
import { attachAppliedFor, getCandidateProfile, type CandidateProfile } from "@/lib/recruitment/candidates";
import {
  canonicalViewerHrId,
  listViewersOfCandidate,
  resolveViewerNames,
} from "@/lib/recruitment/candidate-views";
import { getLatestCvExtraction } from "@/lib/recruitment/cv-extraction";
import type { StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
import { cvFolderAncestry, type CvFolderRow } from "@/lib/recruitment/cv-folder-tree";
import { recruitmentDb } from "@/lib/recruitment/db";
import { listSendsForCandidate, type ManagerSend } from "@/lib/recruitment/manager-sends";
import { listScreeningQuestionLabels } from "@/lib/recruitment/screening-question-labels";
import type { ScreeningQuestionLabel } from "@/lib/recruitment/whatsapp-answers";

/** One person who has opened this CV, by name. */
export type CandidateRecordViewer = {
  /** The reader's name, or null when their HR id matched no employee — the page says so in words. */
  name: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  viewCount: number;
};

/** One hand-built folder this CV sits in. */
export type CandidateRecordFolder = {
  folderId: string;
  /** The folder names from the top down, this folder last. */
  path: string[];
  filedAt: string | null;
  /** The HR id as written on the filing; the page reads its name from `people`. */
  filedByHrId: string | null;
};

/** The parts read beside the candidate, each of which can fail without taking the page with it. */
export type CandidateRecordPart = "extraction" | "questions" | "sends" | "viewers" | "folders";

export type CandidateRecord = {
  profile: CandidateProfile;
  extraction: StoredCvExtraction | null;
  /** The wording of the admin-defined WhatsApp questions. Null when it could not be read. */
  screeningQuestions: ScreeningQuestionLabel[] | null;
  /** Every send to a manager, newest first. */
  sends: ManagerSend[];
  /** Everybody who has opened this CV, most recent reader first. */
  viewers: CandidateRecordViewer[];
  cvFolders: CandidateRecordFolder[];
  /**
   * Every HR id the record names, spelled exactly as it is stored, mapped to that person's name.
   *
   * Keyed by the stored spelling rather than a canonical one so the page can look a name up without
   * importing the id rules (they live beside the database client). An id that is absent here is one
   * that matched no employee, and the page prints "Unnamed user" for it — never the id.
   */
  people: Record<string, string>;
  unavailable: CandidateRecordPart[];
};

/** "That table is not there yet" in both spellings — PostgREST's schema-cache answer and Postgres's own. */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

/**
 * The hand-built folders holding this CV, each as its full path from the top.
 *
 * One read for the filings, and a second for the tree only when there is a filing to place — most
 * candidates are in no folder, and they cost one query, not two. A missing table is "in no folder",
 * the answer the pool itself gives before the migration.
 */
async function loadCandidateFolders(candidateId: string): Promise<CandidateRecordFolder[]> {
  const supabase = recruitmentDb();
  const { data: itemRows, error: itemError } = await supabase
    .from("ats_cv_folder_items")
    .select("folder_id,filed_at,filed_by_hr_id")
    .eq("candidate_id", candidateId)
    .order("filed_at", { ascending: false });
  if (itemError) {
    if (isMissingTable(itemError)) return [];
    throw itemError;
  }
  const items = (itemRows ?? []) as Array<{
    folder_id?: string | null;
    filed_at?: string | null;
    filed_by_hr_id?: string | null;
  }>;
  if (items.length === 0) return [];

  const { data: folderRows, error: folderError } = await supabase.from("ats_cv_folders").select("id,parent_id,name");
  if (folderError) {
    if (isMissingTable(folderError)) return [];
    throw folderError;
  }
  const rows: CvFolderRow[] = ((folderRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    createdAt: "",
    createdByHrId: null,
    id: String(row.id),
    name: String(row.name ?? ""),
    parentId: row.parent_id ? String(row.parent_id) : null,
  }));

  const folders: CandidateRecordFolder[] = [];
  for (const item of items) {
    const folderId = item.folder_id ? String(item.folder_id) : "";
    if (!folderId) continue;
    const path = cvFolderAncestry(rows, folderId)
      .reverse()
      .map((folder) => folder.name.trim())
      .filter(Boolean);
    // A filing whose folder is gone names nowhere a reader could go, so it is not printed as one.
    if (path.length === 0) continue;
    folders.push({
      filedAt: item.filed_at ? String(item.filed_at) : null,
      filedByHrId: item.filed_by_hr_id ? String(item.filed_by_hr_id) : null,
      folderId,
      path,
    });
  }
  return folders;
}

/** Every HR id the record names, as stored. Automated actors (`ops:…`) are not people and are left out. */
function hrIdsNamedOn(
  profile: CandidateProfile,
  viewerIds: readonly string[],
  folders: readonly CandidateRecordFolder[],
): string[] {
  const { candidate } = profile;
  const ids = [
    candidate.statusChangedByHrId,
    candidate.ratedByHrId,
    candidate.backgroundConfirmedByHrId,
    candidate.folder?.filedByHrId ?? null,
    candidate.createdBy,
    ...profile.files.map((file) => file.uploadedByHrId),
    ...profile.applications.flatMap(({ application }) => [application.currentOwnerHrId, application.createdBy]),
    ...profile.interviews.flatMap(({ interview }) => [interview.interviewerHrId, interview.createdBy]),
    ...profile.rejectionHistory.map((event) => event.actorHrId),
    ...folders.map((folder) => folder.filedByHrId),
    ...viewerIds,
  ];
  const out = new Set<string>();
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed && !isBatchActor(trimmed)) out.add(trimmed);
  }
  return [...out];
}

/**
 * The whole record, or null when there is no candidate with this id.
 *
 * The id must already be a well-formed uuid (`parseCandidatePageId`): a malformed one makes Postgres
 * refuse the query outright rather than answer "no such row".
 */
export async function loadCandidateRecord(candidateId: string): Promise<CandidateRecord | null> {
  const profile = await getCandidateProfile(candidateId);
  if (!profile) return null;

  const unavailable: CandidateRecordPart[] = [];
  const settle = async <T>(part: CandidateRecordPart, read: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read;
    } catch {
      unavailable.push(part);
      return fallback;
    }
  };

  const [extraction, screeningQuestions, sends, viewerRows, cvFolders] = await Promise.all([
    settle("extraction", getLatestCvExtraction(candidateId), null),
    settle<ScreeningQuestionLabel[] | null>("questions", listScreeningQuestionLabels(), null),
    settle("sends", listSendsForCandidate(candidateId), [] as ManagerSend[]),
    settle("viewers", listViewersOfCandidate(candidateId), []),
    settle("folders", loadCandidateFolders(candidateId), [] as CandidateRecordFolder[]),
    // The job they are applying for, resolved down the same ladder the pool row uses — the CV read
    // and the vacancy included — so the page and the row the name was pressed on say the same thing.
    // A failure leaves the answer the record itself gives (`candidateRowAppliedFor` falls back to
    // it), which is a real answer rather than a gap, so it is not reported as unreadable.
    attachAppliedFor([profile.candidate]).catch(() => undefined),
  ]);

  const rawIds = hrIdsNamedOn(
    profile,
    viewerRows.map((viewer) => viewer.viewerHrId),
    cvFolders,
  );
  // A name lookup that fails leaves every person unnamed — worded as such on the page — rather than
  // taking the record down with it.
  const names = await resolveViewerNames(rawIds).catch(() => new Map<string, string>());

  const people: Record<string, string> = {};
  for (const raw of rawIds) {
    const key = canonicalViewerHrId(raw);
    const name = key ? names.get(key) : undefined;
    if (name) people[raw] = name;
  }

  const viewers: CandidateRecordViewer[] = viewerRows.map((viewer) => ({
    firstSeenAt: viewer.firstSeenAt,
    lastSeenAt: viewer.lastSeenAt,
    name: people[viewer.viewerHrId] ?? null,
    viewCount: viewer.viewCount,
  }));

  return {
    cvFolders,
    extraction,
    people,
    profile,
    screeningQuestions,
    sends,
    unavailable: [...new Set(unavailable)],
    viewers,
  };
}
