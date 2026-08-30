// Recruitment / ATS — the CV shelf: three sets of folders a good CV waits in until a seat opens.
//
// WHY THIS EXISTS. The candidate pool had one shape — everything, newest first — and measured in
// production on 2026-08-30 it held 476 CVs of which 322 had never been judged at all. A CV that is
// genuinely good but not needed this month had nowhere to go: rejecting it is a lie, leaving it
// there means reading past it every session, and the owner said so plainly:
//
//   "if this CV is good, but I'm not needing it now, I push the CV to the folder, and then I have
//    every single archive."
//
// FILING IS NOT A DECISION ABOUT THE PERSON. It is a decision about the queue, and that distinction
// is the whole design. `status` already answers "what do we think of them" and holds exactly one
// value; a shortlisted candidate parked until September has to still read as shortlisted when she
// is pulled back out. Folding this into the status vocabulary would have cost that, plus a sixth
// code every filter, counter and stat card must learn. Same reasoning that kept "seen" out of the
// status list in candidate-views.ts.
//
// THREE SHELVES, KEYED ON THREE DIFFERENT THINGS. The owner named them:
//
//   Medical Representative  one folder per AREA        — 50 areas, from au.canonical_areas
//   District Manager        one folder per REGION      — the 8 in candidateRegionCodes
//   Other positions         one folder per JOB TITLE   — created as a recruiter files
//
// He first said six regions. The live list is eight — the six he was picturing plus Delta (3),
// which he opened himself this month, and Others, which carries no target but does carry areas.
// Asked directly on 2026-08-30 he answered "8 regions, and split other positions by job title", so
// the region shelf is driven from `candidateRegionCodes` rather than a hand-written list: when a
// Delta (4) is opened the folder appears by itself and cannot drift from the Organogram.
//
// PURE, AND IT HAS TO STAY PURE. The candidate pool is a "use client" component, so a database
// import anywhere in this chain would drag the service-role client into the browser bundle — the
// same constraint red-flag.ts and position-folder.ts are written under. `candidate-region` and
// `candidate-status` are pure; `types` is imported for its type only.

import { candidateRegionCodes, candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";

/** The three shelves, in the order the owner named them and the order they render. */
export const candidateFolderKinds = ["medical_rep", "district_manager", "other"] as const;

export type CandidateFolderKind = (typeof candidateFolderKinds)[number];

/**
 * What each shelf is called on screen. The job titles are the company's own, not invented here —
 * "Medical Representative" is the title carried by 34 of the 35 open vacancies.
 */
export const candidateFolderKindLabels: Record<CandidateFolderKind, string> = {
  district_manager: "District Manager",
  medical_rep: "Medical Representative",
  other: "Other positions",
};

/** What the folders inside each shelf are named for — the second line under a shelf heading. */
export const candidateFolderKindDescriptions: Record<CandidateFolderKind, string> = {
  district_manager: "One folder per region.",
  medical_rep: "One folder per area.",
  other: "One folder per job title.",
};

/** The word for one folder's key, used when a screen has to ask for it. */
export const candidateFolderKeyLabels: Record<CandidateFolderKind, string> = {
  district_manager: "Region",
  medical_rep: "Area",
  other: "Job title",
};

export function isCandidateFolderKind(value: unknown): value is CandidateFolderKind {
  return typeof value === "string" && (candidateFolderKinds as readonly string[]).includes(value);
}

/**
 * A folder key, cleaned: trimmed, inner runs of whitespace collapsed, empty becomes null.
 *
 * The collapse is not cosmetic and the precedent is position-folder.ts, where it was learned the
 * expensive way: a typed "Medical  Representative" with a double space is a different string from
 * "Medical Representative" and would open a second folder reading exactly like the first. On the
 * "other" shelf the key is free-typed, so this is the only thing standing between the owner and two
 * identical-looking folders.
 */
export function cleanFolderKey(value: string | null | undefined): string | null {
  const cleaned = String(value ?? "").trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Identity of a folder for grouping — case-folded, so a typed "nasr city" and a picked "Nasr City"
 * land in ONE folder rather than two that read the same.
 *
 * Returns null when the key is empty, and callers read that as "not filed".
 */
export function candidateFolderKey(kind: CandidateFolderKind, key: string | null | undefined): string | null {
  const cleaned = cleanFolderKey(key);
  if (!cleaned) return null;
  // A region is stored as a CODE, which is already canonical and case-defined. Upper-casing it
  // rather than lower-casing keeps the stored value and the group key identical for the one shelf
  // whose vocabulary is closed, so a mis-cased "d3" from a hand-written call still finds "D3".
  if (kind === "district_manager") return cleaned.toUpperCase();
  return cleaned.toLowerCase();
}

/**
 * The folder as a person reads it.
 *
 * The region shelf is the only one that translates: it stores "D3" and shows "Delta (3)", because
 * the code is the stable half and the label is the company's own wording in `au.regions`. A code
 * that is not on the list is shown VERBATIM rather than replaced with a placeholder — the owner's
 * standing rule is that no invented value reaches a screen, and a folder reading "Unknown" is a
 * fault to chase when the truth is simply that somebody filed against a region since renamed.
 */
export function candidateFolderLabel(kind: CandidateFolderKind, key: string | null | undefined): string {
  const cleaned = cleanFolderKey(key);
  if (!cleaned) return "";
  if (kind !== "district_manager") return cleaned;
  const code = cleaned.toUpperCase();
  return candidateRegionLabels[code as CandidateRegionCode] ?? cleaned;
}

/** The eight regions, as folder options — driven from the live list so a new region appears by itself. */
export function districtManagerFolderOptions(): Array<{ key: string; label: string }> {
  return candidateRegionCodes.map((code) => ({ key: code, label: candidateRegionLabels[code] }));
}

// ── Can this candidate be filed? ─────────────────────────────────────────────────────────────────

/**
 * Why a candidate cannot go on the shelf, or null when they can.
 *
 * ONE rule, and it comes straight from how the owner described the feature: *"if this CV is good,
 * but I'm not needing it now"*. The shelf is for good CVs waiting on a seat. A rejected candidate is
 * not waiting on anything — that is a decision already made, and burying it in an area folder would
 * mean the folder a recruiter opens next March contains people who were already turned down.
 *
 * Deliberately NOT extended to the other red flag. A CV flagged "Not Egyptian" is ineligible today,
 * but it is not a decision anybody made and the recruitment rule could change; refusing to file it
 * would be this module inventing policy. It stays fileable and stays flagged.
 *
 * Returns the sentence to show, not a boolean, so the button's tooltip and the route's 400 say the
 * same thing rather than two wordings that drift.
 */
export function candidateFolderRefusal(candidate: Pick<Candidate, "status"> | null | undefined): string | null {
  if (!candidate) return "Candidate not found.";
  if (normalizeCandidateStatus(candidate.status) === "rejected") {
    return "A rejected CV cannot be filed. Folders are for good CVs waiting on a seat — change the status first if this one is back in play.";
  }
  return null;
}

export function canFileCandidate(candidate: Pick<Candidate, "status"> | null | undefined): boolean {
  return candidateFolderRefusal(candidate) === null;
}

// ── Reading a filed candidate ────────────────────────────────────────────────────────────────────

/**
 * Everything this module needs off a candidate to place it on a shelf — a structural type rather
 * than `Candidate`, so a pool row, a test fixture and the folder screen can all be answered about
 * without any of them having to build a whole candidate.
 */
export type FiledCandidate = {
  folder?: { kind: CandidateFolderKind; key: string; filedAt: string; filedByHrId: string | null } | null;
};

/**
 * True when this CV is on the shelf and therefore OFF the main pool.
 *
 * The single authority for that question, asked once here rather than as `candidate.folder !== null`
 * scattered across four screens — the pool, the CV database, the screening queue and the folder view
 * itself all have to agree, and they disagreed exactly when red-flag.ts's question was inline.
 */
export function isFiledCandidate(candidate: FiledCandidate | null | undefined): boolean {
  return Boolean(candidate?.folder);
}

/** One folder, with its contents. */
export type CandidateFolder = {
  /** Stable identity for React keys — never shown to a person. */
  key: string;
  /** The stored value: an area name, a region code, or a job title. */
  storedKey: string;
  /** "Nasr City", "Delta (3)", "Regulatory Affairs Specialist" — as a person reads it. */
  label: string;
  candidates: Candidate[];
  /** Most recent filing in this folder, so a shelf can be ordered by what arrived last. */
  lastFiledAt: string | null;
};

/** One shelf — a folder kind and every folder under it. */
export type CandidateFolderShelf = {
  kind: CandidateFolderKind;
  label: string;
  description: string;
  folders: CandidateFolder[];
  /** Every CV on this shelf, across its folders — the number on the shelf heading. */
  candidateCount: number;
};

/**
 * Split the pool into what is live and what is shelved, and fold the shelved half into folders.
 *
 * Returns BOTH halves from one pass, deliberately. The pool screen needs `pool` and the folder
 * screen needs `shelves`, and the one thing that must never happen is the two disagreeing about
 * which CVs are hidden — that is how a candidate ends up in neither list and is lost. One function,
 * one partition, and a CV is in exactly one of the two returned collections by construction.
 *
 * All three shelves come back ALWAYS, empty ones included. An empty shelf is information — it says
 * nothing has been filed for District Managers yet — while a shelf that vanishes when it empties
 * makes the feature look broken the first time somebody uses it.
 */
export function partitionCandidatesByFolder(candidates: readonly Candidate[]): {
  pool: Candidate[];
  shelves: CandidateFolderShelf[];
  filedCount: number;
} {
  const pool: Candidate[] = [];
  const byKind = new Map<CandidateFolderKind, Map<string, CandidateFolder>>();
  for (const kind of candidateFolderKinds) byKind.set(kind, new Map());
  let filedCount = 0;

  for (const candidate of candidates) {
    const folder = candidate.folder ?? null;
    const groupKey = folder ? candidateFolderKey(folder.kind, folder.key) : null;
    // A row whose kind is unknown or whose key is empty is NOT hidden. The database constraint makes
    // that shape unreachable through the app, but a hand-written SQL fix could produce it, and the
    // safe failure for "I cannot tell which folder this is" is to leave the CV where a human will
    // see it rather than to hide it in a folder nobody can name.
    if (!folder || !groupKey || !isCandidateFolderKind(folder.kind)) {
      pool.push(candidate);
      continue;
    }

    filedCount += 1;
    const folders = byKind.get(folder.kind)!;
    const existing = folders.get(groupKey);
    if (existing) {
      existing.candidates.push(candidate);
      if (!existing.lastFiledAt || folder.filedAt > existing.lastFiledAt) existing.lastFiledAt = folder.filedAt;
      continue;
    }
    folders.set(groupKey, {
      candidates: [candidate],
      key: groupKey,
      label: candidateFolderLabel(folder.kind, folder.key),
      lastFiledAt: folder.filedAt || null,
      storedKey: cleanFolderKey(folder.key) ?? folder.key,
    });
  }

  const shelves: CandidateFolderShelf[] = candidateFolderKinds.map((kind) => {
    const folders = [...byKind.get(kind)!.values()];
    for (const folder of folders) {
      // Newest filing first inside a folder: the reason to open one is usually what just landed.
      folder.candidates.sort((left, right) =>
        (right.folder?.filedAt ?? "").localeCompare(left.folder?.filedAt ?? ""),
      );
    }
    // Folders read alphabetically by the name on screen, which is how somebody looks one up — not by
    // recency, because a shelf is a filing cabinet and the whole point is finding "Nasr City" fast.
    folders.sort((left, right) => left.label.localeCompare(right.label));
    return {
      candidateCount: folders.reduce((total, folder) => total + folder.candidates.length, 0),
      description: candidateFolderKindDescriptions[kind],
      folders,
      kind,
      label: candidateFolderKindLabels[kind],
    };
  });

  return { filedCount, pool, shelves };
}
