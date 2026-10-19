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

/**
 * The shelves, in the order the owner named them and the order they render.
 *
 * PARAMEDICAL IS LAST, AND DELIBERATELY SO. The first three are places a CV waits for a seat; this
 * one is the answer to a different question — whether the person is eligible for the field force at
 * all — and it is the only shelf nobody is hired out of. Putting it last keeps the three a recruiter
 * works from at the top of the screen. Added 2026-08-31 on the owner's instruction: *"I want the non
 * science or pharmacy or vet to be excluded in a separate folder. Name this folder paramedical."*
 *
 * The eligibility rule itself is NOT here — it lives in candidate-background.ts, which owns the five
 * disciplines and the asymmetry between filing somebody in and filing somebody out. This module only
 * knows that a shelf by this name exists.
 */
export const candidateFolderKinds = ["medical_rep", "district_manager", "other", "paramedical"] as const;

/**
 * The duplicate archive — a STORED kind, deliberately NOT one of the shelves above.
 *
 * ── WHY IT IS NOT A FIFTH SHELF ─────────────────────────────────────────────────────────────────
 *
 * `candidateFolderKinds` is the owner's own list, in the order he named them, and every folder
 * screen loops over it to draw a shelf per kind — deliberately including the empty ones, because
 * "an empty shelf is information; a shelf that vanishes makes the feature look broken". Adding a
 * fifth member therefore does not add an archive; it puts a "Duplicates" heading on every screen
 * that is about which seat a good CV is waiting for. Two tests caught exactly that.
 *
 * So the two vocabularies are split. The four above are what a CV is filed UNDER, and what the
 * shelf screens render. This one is a state a record is put IN: the same storage columns, because
 * they already mean "out of the pool, reversibly, stamped with who and when" — and nothing else in
 * the schema means that — but never a shelf, never rendered as one, and never offered in a picker.
 *
 * ── WHY A SHELF AND NOT A DELETE ────────────────────────────────────────────────────────────────
 *
 * The pairing is never proof. candidate-matching.ts keeps the identity rule LOCKED to national ID
 * then email, and neither has a single collision in production, so every duplicate a person archives
 * today rests on a shared number or a shared name — and phone matching once "merged three different
 * applicants into one record". Filing is reversible and keeps the row, its files and its history.
 */
export const DUPLICATE_FOLDER_KIND = "duplicate" as const;

/** The archive holds ONE folder, like the paramedical shelf — see PARAMEDICAL_FOLDER_KEY. */
export const DUPLICATE_FOLDER_KEY = "Duplicate";

/** What the archive is called wherever it IS shown — the screening banner, and the folders tab. */
export const DUPLICATE_FOLDER_LABEL = "Duplicates";

/**
 * Everything `folder_kind` may hold in the database: the four shelves plus the archive.
 *
 * This is what the CHECK constraint lists and what the write path and the row mapper must accept.
 * `candidateFolderKinds` is the DISPLAY vocabulary and stays the owner's four.
 */
export const candidateStorageFolderKinds = [...candidateFolderKinds, DUPLICATE_FOLDER_KIND] as const;

export type CandidateStorageFolderKind = (typeof candidateStorageFolderKinds)[number];

/** True for anything the column may legally hold — a shelf OR the duplicate archive. */
export function isStorableFolderKind(value: unknown): value is CandidateStorageFolderKind {
    return typeof value === "string" && (candidateStorageFolderKinds as readonly string[]).includes(value);
}

/** True when this filing is the duplicate archive rather than a position shelf. */
export function isDuplicateArchive(kind: unknown): boolean {
    return kind === DUPLICATE_FOLDER_KIND;
}

export type CandidateFolderKind = (typeof candidateFolderKinds)[number];

/**
 * What each shelf is called on screen. The job titles are the company's own, not invented here —
 * "Medical Representative" is the title carried by 34 of the 35 open vacancies.
 */
export const candidateFolderKindLabels: Record<CandidateFolderKind, string> = {
  district_manager: "District Manager",
  medical_rep: "Medical Representative",
  other: "Other positions",
  paramedical: "Paramedical",
};

/** What the folders inside each shelf are named for — the second line under a shelf heading. */
export const candidateFolderKindDescriptions: Record<CandidateFolderKind, string> = {
  district_manager: "One folder per region.",
  medical_rep: "One folder per area.",
  other: "One folder per job title.",
  // Names the five that ARE eligible rather than the many that are not — a recruiter opening this
  // shelf needs to know the rule it was filed by, and the eligible list is the short half.
  paramedical: "Graduates outside pharmacy, science, veterinary, medicine and dentistry.",
};

/** The word for one folder's key, used when a screen has to ask for it. */
export const candidateFolderKeyLabels: Record<CandidateFolderKind, string> = {
  district_manager: "Region",
  medical_rep: "Area",
  other: "Job title",
  // The paramedical shelf holds exactly ONE folder (see PARAMEDICAL_FOLDER_KEY), so no screen asks
  // for this key and this word should never reach anyone. The entry exists because the Record is
  // exhaustive over the union, and a missing one would compile, render as undefined, and be found
  // only by somebody reading the screen it broke.
  paramedical: "Folder",
};

/**
 * The paramedical shelf's ONE folder, by name.
 *
 * The owner asked for "a separate folder", singular — not a folder per degree. That matters more
 * than it sounds: the point of this shelf is that a recruiter can see everyone the eligibility rule
 * excluded, in one place, and decide. Split across thirty degree names it stops being that list and
 * becomes thirty lists nobody opens.
 *
 * Every writer uses this constant rather than the string. The partition groups case-insensitively,
 * so a stray "paramedical" would not split the folder in two — it would rename it, because the
 * displayed label is one of the stored spellings. One constant is what keeps the heading stable.
 */
export const PARAMEDICAL_FOLDER_KEY = "Paramedical";

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
 * Curly ("smart") quotes folded to their straight ASCII form.
 *
 * A copy-pasted WhatsApp answer can carry them — one production folder is literally the two
 * characters `“` and `”` wrapped around "Haram", filed as its own folder distinct from
 * both "Haram" and the real area "Haram - Faisal". `cleanFolderKey` does not touch this; nothing
 * else in this module needs to.
 */
function foldSmartQuotes(value: string): string {
  return value.replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"');
}

/**
 * A free-typed area name reduced to a key comparable against the canonical list: cleaned, smart
 * quotes folded, case folded. Exported so the propose-time suggestion and the file-time write
 * compare a typed answer against `au.canonical_areas` the SAME way — two normalisations that
 * drift apart is how a real area would start being refused by one path and not the other.
 */
export function normalizedAreaMatchKey(value: string | null | undefined): string {
  const cleaned = cleanFolderKey(value);
  return cleaned ? foldSmartQuotes(cleaned).toLowerCase() : "";
}

/**
 * The canonical area name a free-typed answer names, or a refusal — never a guess.
 *
 * WHY THIS EXISTS. Measured against production 2026-09-11: seven CVs had been filed onto the
 * Medical Representative shelf under a folder key identical to the applicant's free-typed
 * `preferred_area_name` — "kafrelsheikh", "Qena north", "Minia Government", a curly-quoted
 * "Haram" — and NONE of the seven matched any of the ~50 live areas. Each one silently opened its
 * own one-CV folder beside the real area folders, so a recruiter screening the real "Kafr
 * El-Sheikh 1" folder never saw the CV sitting one letter away in "kafrelsheikh".
 *
 * EXACT MATCH ONLY, modulo case/whitespace/smart-quotes. This deliberately does NOT fuzzy-match
 * or fall back to a region-level guess: "Kafr El-Sheikh 1" and "Kafr El-Sheikh 2" are different
 * territories with different vacancies, and a typed "kafrelsheikh" does not say which one. The
 * owner's standing rule across this app is that territory is never inferred from free text — an
 * address does not set an area, and neither does a typed answer that merely resembles one. An
 * unrecognised or ambiguous typed area is refused, with a reason a screen can show, rather than
 * silently opening a new folder or being guessed onto an existing one.
 *
 * `canonicalAreaNames` is handed in rather than read here, so this stays PURE like the rest of
 * this module — the live list comes from `au.canonical_areas` via
 * `listCandidateFolderAreaOptions`/`listCanonicalMedicalRepAreaNames` in candidate-folder-options.ts,
 * which both the propose-time suggestion and the file-time write already have to reach separately.
 */
export function resolveCanonicalMedicalRepArea(
  raw: string | null | undefined,
  canonicalAreaNames: readonly string[],
): { area: string; refusal: null } | { area: null; refusal: string } {
  const cleaned = cleanFolderKey(raw);
  if (!cleaned) return { area: null, refusal: "No area was given." };
  const key = normalizedAreaMatchKey(cleaned);
  const match = canonicalAreaNames.find((name) => normalizedAreaMatchKey(name) === key);
  if (match) return { area: match, refusal: null };
  return {
    area: null,
    refusal: `"${cleaned}" is not one of the current areas — file this CV manually once the area is confirmed.`,
  };
}

/**
 * The region code a District Manager folder is keyed on, or the sentence saying why there isn't one.
 *
 * The region shelf is the one shelf whose vocabulary is CLOSED and lives in this repository —
 * `candidateRegionCodes`, eight codes, no database read — so unlike the area shelf there is nothing
 * to look up and nothing to be uncertain about. That is exactly why it was the easiest one to leave
 * unguarded: `fileCandidateToFolder` stored whatever key arrived, and a stale tab, a typo in a
 * hand-made request, or a future caller passing a region NAME ("Delta (3)") instead of its code
 * would have opened a folder `candidateFolderLabel` cannot name and `districtManagerFolderOptions`
 * never lists. The CV would be filed, off the pool screen, and in a folder nobody opens.
 *
 * Returns the CANONICAL upper-case code, never the caller's casing, so "ue" and "UE" land in one
 * folder — the same property `resolveCanonicalMedicalRepArea` holds for an area's spelling.
 */
export function resolveCandidateRegionFolderCode(
  raw: string | null | undefined,
): { code: CandidateRegionCode; refusal: null } | { code: null; refusal: string } {
  const cleaned = cleanFolderKey(raw);
  if (!cleaned) return { code: null, refusal: "No region was given." };
  const upper = cleaned.toUpperCase();
  const match = candidateRegionCodes.find((code) => code === upper);
  if (match) return { code: match, refusal: null };
  return {
    code: null,
    refusal: `"${cleaned}" is not one of this system's regions — file this CV manually once the region is confirmed.`,
  };
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
export function candidateFolderRefusal(
  candidate: Pick<Candidate, "status"> | null | undefined,
  // Defaults to the POSITION shelves, so all nine existing callers keep the rule they had.
  kind: CandidateStorageFolderKind | null = null,
): string | null {
  if (!candidate) return "Candidate not found.";
  // THE DUPLICATE SHELF IS EXEMPT, and the exemption is the whole reason this takes a kind.
  //
  // The rule below exists because "folders are for good CVs waiting on a seat", so a rejected CV has
  // no business on one. Archiving a duplicate is the opposite act — it is a discard of a REDUNDANT
  // RECORD, and a duplicate is at least as likely to be rejected as anything else. Refusing it there
  // would mean the one shelf built for tidying could not tidy the rows most in need of it.
  if (kind === DUPLICATE_FOLDER_KIND) return null;
  if (normalizeCandidateStatus(candidate.status) === "rejected") {
    return "A rejected CV cannot be filed. Folders are for good CVs waiting on a seat — change the status first if this one is back in play.";
  }
  return null;
}

export function canFileCandidate(
  candidate: Pick<Candidate, "status"> | null | undefined,
  kind: CandidateStorageFolderKind | null = null,
): boolean {
  return candidateFolderRefusal(candidate, kind) === null;
}

// ── Reading a filed candidate ────────────────────────────────────────────────────────────────────

/**
 * Everything this module needs off a candidate to place it on a shelf — a structural type rather
 * than `Candidate`, so a pool row, a test fixture and the folder screen can all be answered about
 * without any of them having to build a whole candidate.
 */
export type FiledCandidate = {
  folder?: { kind: CandidateStorageFolderKind; key: string; filedAt: string; filedByHrId: string | null } | null;
  /**
   * The hand-built folders this CV sits in — `ats_cv_folder_items`, added 2026-09-12.
   *
   * A SECOND way to be off the pool, and an independent one: the four shelves above are a single
   * value on the candidate row, while this is a many-to-many membership so a CV can be copied into
   * several folders at once. Optional because most callers build a candidate-shaped object without
   * it; absent and empty mean the same thing, which is the safe direction — a caller that never
   * loaded the memberships leaves the CV VISIBLE rather than hiding somebody by omission.
   */
  cvFolderIds?: readonly string[] | null;
};

/**
 * True when this CV is filed and therefore OFF the main pool.
 *
 * The single authority for that question, asked once here rather than as `candidate.folder !== null`
 * scattered across four screens — the pool, the CV database, the screening queue and the folder view
 * itself all have to agree, and they disagreed exactly when red-flag.ts's question was inline.
 *
 * TWO WAYS TO BE FILED SINCE 2026-09-12, deliberately OR-ed HERE rather than at the call sites. The
 * owner was asked directly whether a CV in one of his own folders should stay in the main list and
 * chose the shelf's behaviour — it disappears — so "filed" now means "on a shelf OR in at least one
 * hand-built folder". Putting that OR in this function is what carried the change to the pool, the
 * screening queue, the CV database and the folder suggestions without touching any of them: every
 * one of those already asked here, which is the whole reason the question was centralised.
 */
export function isFiledCandidate(candidate: FiledCandidate | null | undefined): boolean {
  return Boolean(candidate?.folder) || isInCvFolder(candidate);
}

/**
 * True when this CV sits in at least one folder a PERSON made by hand — the tree, not the shelves.
 *
 * Its own question because the two filings leave the screening lists on different rules. A shelf is
 * filled by the system as often as by a person: a CV's declared area files it the evening it
 * arrives, before anybody has read it, so an undecided shelved CV must stay in front of the screener
 * (see `isShelvedFromReview`). A hand-built folder is only ever somebody's own act. The owner, asked
 * on 2026-09-18 where a CV he moves into a folder such as "Archive" should still appear, answered
 * "only inside that folder": it leaves every decision tab on every screen, whatever its status.
 */
export function isInCvFolder(candidate: Pick<FiledCandidate, "cvFolderIds"> | null | undefined): boolean {
  return (candidate?.cvFolderIds?.length ?? 0) > 0;
}

/** A filed candidate plus the one other thing the review queue has to know: has anybody decided. */
export type ReviewQueueCandidate = FiledCandidate & { status?: string | null };

/**
 * Is this CV off the SCREENING queue because somebody filed it?
 *
 * ── WHY THIS IS NOT JUST `isFiledCandidate` ─────────────────────────────────────────────────────
 *
 * The shelf's stated purpose is that "a good-but-not-now CV stops being offered for review again" —
 * offered AGAIN, which presumes somebody read it once. Filing in practice runs the other way round:
 * a CV arrives on WhatsApp, its declared area files it to a position shelf the same evening, and it
 * leaves the queue before any human has opened it.
 *
 * Measured on production 2026-09-18: 417 of 1,121 candidates were filed, and 371 of those 417 were
 * still `new` — undecided, unread, and absent from the screening page's own pool, its "New CVs"
 * count (252 against a true 624) and its search. A live applicant filed to Sohag1 on 15 September
 * could not be found by name, and the full-text CV search answered "0 CVs mention" for her.
 *
 * So being filed took a CV off the queue only once a DECISION existed — and since 2026-10-19 a
 * shelf takes nobody off it at all. The decision tabs came after this rule: the page opens on "Not
 * decided yet", so a decided CV is no longer offered for review again whatever shelf it sits on, and
 * the old exclusion was left doing only harm. It took the CV out of the pile it had just been decided
 * INTO. On 19 Oct 2026, 11 of the 19 CVs shortlisted on Screening in the previous three days sat on a
 * District Manager, Medical Rep or Other shelf, and none of the 11 could be found under Shortlisted —
 * the owner's report, "when i filter on the shortlisted i donot find what i short listed". A shelved
 * CV now sits on the tab its decision names, exactly as an unfiled one does.
 *
 * THE DUPLICATE ARCHIVE IS NOT A SHELF and is exempt on purpose: that filing is a discard of a
 * redundant record rather than a CV parked for a seat, so it stays out whatever its status says —
 * the behaviour tests/candidate-folders.test.ts already pins.
 *
 * A HAND-BUILT FOLDER IS EXEMPT TOO, since 2026-09-18, for the opposite reason from the shelf rule
 * above: nothing but a person ever puts a CV there. The owner makes a folder such as "Archive" and
 * moves CVs into it precisely so they stop crowding his lists, and he chose, asked directly, that
 * such a CV appear "only inside that folder". See `isInCvFolder`.
 *
 * The status is no longer read here at all: what was decided about a CV picks its TAB, never whether
 * it is on the page.
 */
export function isShelvedFromReview(candidate: ReviewQueueCandidate | null | undefined): boolean {
  if (!isFiledCandidate(candidate)) return false;
  if (isDuplicateArchive(candidate?.folder?.kind)) return true;
  return isInCvFolder(candidate);
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
  /**
   * Records archived as duplicates — out of the pool, and NOT on a shelf.
   *
   * A third bucket rather than a fifth shelf, for the reason DUPLICATE_FOLDER_KIND gives: the four
   * shelves are the owner's own list and every folder screen draws one heading per kind, so an
   * archive among them would put "Duplicates" on screens that are about which seat a good CV is
   * waiting for.
   *
   * It must not fall into `pool` either. The unknown-kind fallback below deliberately leaves a row
   * a human can see rather than hiding it — right for a kind nobody can name, wrong here, where the
   * kind is known and the whole point is that the record has been taken out of circulation. Without
   * this bucket an archived duplicate reappears in the pool on the folders tab, which is the one
   * screen that would make the archive look broken.
   *
   * Added so the archive is REVERSIBLE and visible: these are what a "Duplicates" section lists, and
   * DELETE /api/recruitment/candidates/[id]/folder puts any of them back.
   */
  archived: Candidate[];
  /**
   * CVs in the hand-built folder tree and on no shelf — out of the pool, and not on any shelf here.
   *
   * A FOURTH bucket for the same reason `archived` is a third: the shelves are the owner's own list
   * of four and every folder screen draws one heading per kind, so a fifth heading would appear on
   * screens that are about which seat a CV is waiting for. The tree has its own screen, which renders
   * these from `ats_cv_folders` — this bucket exists so they cannot fall into `pool` on the way.
   *
   * A CV that is BOTH on a shelf and in the tree stays on its shelf. The shelf is the older, narrower
   * statement ("waiting for a seat in Nasr City") and it is what the shelf screen must keep showing;
   * the tree screen finds it through its own membership rows either way, so neither screen loses it.
   */
  cabinet: Candidate[];
} {
  const pool: Candidate[] = [];
  const archived: Candidate[] = [];
  const cabinet: Candidate[] = [];
  const byKind = new Map<CandidateFolderKind, Map<string, CandidateFolder>>();
  for (const kind of candidateFolderKinds) byKind.set(kind, new Map());
  let filedCount = 0;

  for (const candidate of candidates) {
    const folder = candidate.folder ?? null;
    // Narrowed with the shelf predicate, so the archive kind never reaches a shelf helper.
    const groupKey = folder && isCandidateFolderKind(folder.kind) ? candidateFolderKey(folder.kind, folder.key) : null;
    // A row whose kind is unknown or whose key is empty is NOT hidden. The database constraint makes
    // that shape unreachable through the app, but a hand-written SQL fix could produce it, and the
    // safe failure for "I cannot tell which folder this is" is to leave the CV where a human will
    // see it rather than to hide it in a folder nobody can name.
    // The archive first: a known kind, deliberately out of both the pool and the shelves.
    if (folder && isDuplicateArchive(folder.kind)) {
      archived.push(candidate);
      filedCount += 1;
      continue;
    }
    if (!folder || !groupKey || !isCandidateFolderKind(folder.kind)) {
      // No shelf — but the hand-built tree is a second way to be filed, and a CV in it must not fall
      // back into the pool here. Asked AFTER the shelf so a CV that is both keeps its shelf.
      if ((candidate.cvFolderIds?.length ?? 0) > 0) {
        cabinet.push(candidate);
        filedCount += 1;
        continue;
      }
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

  return { archived, cabinet, filedCount, pool, shelves };
}
