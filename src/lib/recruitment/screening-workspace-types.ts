// Recruitment / ATS — the SHAPES the screening workstation renders, and nothing else.
//
// SPLIT OUT OF `screening-workspace.ts` FOR ONE REASON: that module loads candidates, views, open
// vacancies and interviews, so it reaches the Supabase SERVICE-ROLE client. Every workstation
// component is `"use client"`, and a client module that names a type from a server module drags the
// server module into the browser bundle — which fails the build outright when it works and ships a
// service-role import when it does not. The same split already exists twice in this module
// (`screening-link.ts` beside `screening-queue.ts`, `stale-send-thresholds.ts` beside
// `stale-send-check.ts`), for exactly this reason.
//
// SO THIS FILE IS PURE, and must stay pure: types, and imports of other pure modules. Nothing that
// touches the database, the filesystem, or a credential may ever be imported here.
//
// The two option types below are structural copies of `VacancyOption` and `HiringManagerOption`
// rather than re-exports, which is the convention `manager-picker.tsx` and `vacancy-picker.tsx`
// already follow for the same reason. They are checked against the real ones by assignment at the
// one place both meet — the server component that hands a loaded workspace to the client shell.

import type { AppliedForSource } from "@/lib/recruitment/applied-for";
import type { CandidateRating } from "@/lib/recruitment/candidate-rating";
import type { CandidateRedFlag } from "@/lib/recruitment/red-flag";
import type { CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { RequisitionRecommendation } from "@/lib/recruitment/requisition-match";
import type { RoleFitVerdict } from "@/lib/recruitment/role-fit";
import type { ScreeningBand } from "@/lib/recruitment/screening-order";
import type { ScreeningWorkQueue } from "@/lib/recruitment/screening-queues";

/** A fact plus whether it is safe to read as settled — the module's standing convention. */
export type RowFact = { confirmed: boolean; value: string } | null;

/**
 * WHY a pair is being offered as a possible duplicate. Never a claim that they ARE one.
 *
 * `phone` is the stronger of the two and still not proof — families share a handset, and
 * candidate-matching.ts records phone matching once merging three different applicants into one
 * record. `name` is weaker again. The identity rule that actually merges is LOCKED to national ID
 * and email, neither of which has a single collision in production.
 */
export type DuplicateReason = "phone" | "name";

/**
 * One line in the candidate list, and the source for the header above the CV.
 *
 * Everything here is a STRING the screen prints, resolved server-side. The client re-derives
 * nothing: a list that re-runs the band computation and the place matcher over 555 rows on every
 * keystroke is the page the owner described as slow.
 */
export type WorkspaceCandidateRow = {
  id: string;
  fullName: string;

  /**
   * The job they are asking us FOR. Printed ABOVE and larger than the current role, because the
   * question a recruiter is answering is "is this person right for the seat", and a list that leads
   * with somebody's current title answers a question nobody asked.
   */
  appliedForText: string | null;
  /** How we know — "stated" is their own words, everything else was derived. Shown, never hidden. */
  appliedForSource: AppliedForSource | null;

  /** What they do NOW. Secondary to the above, deliberately. */
  currentRole: RowFact;
  currentEmployer: RowFact;

  /** Where they are, in words — their stated area, else their region, else null. */
  locationLabel: string | null;
  /** True when the applicant told us, false when it was read off an address. Different weight. */
  locationDeclared: boolean;
  regionCode: CandidateRegionCode | null;

  /** "6.9 yrs", "8 mo", or null when the CV was never read for one. Never a zero. */
  experienceLabel: string | null;
  experienceConfirmed: boolean;
  /** The band the applicant TAPPED, when they answered on WhatsApp. A bracket, not a measurement. */
  declaredExperience: string | null;

  source: string | null;
  /**
   * The star on this CV, 1 to 3, or null for one nobody has starred.
   *
   * Beside the status and never inside it — see candidate-rating.ts. It is also the TOP key of the
   * queue order, so a row carrying one is at the top of the list it appears in.
   */
  rating: CandidateRating | null;
  status: CandidateStatus | null;
  /** The raw column, for the handful of production rows still carrying pre-vocabulary free text. */
  statusRaw: string;
  statusNote: string | null;
  statusChangedAt: string | null;

  band: ScreeningBand;
  /** Met over answered dimensions, or null when too little is on file. NOT an AI score — role-fit.ts. */
  fitScore: number | null;
  fitVerdict: RoleFitVerdict;
  /** The job the fit was read AGAINST, so a score is never shown without saying against what. */
  fitRoleLabel: string;

  /** How many records look like this person, counting this one. 1 means no twin — never 0. */
  duplicateCount: number;
  /** The OTHER names on that number — the whole difference between a re-upload and two people. */
  duplicateNames: string[];
  /** Those other records' ids, so a reader can open the twin and compare rather than guess. */
  duplicateIds: string[];
  /** The strongest evidence behind the pairing, so the screen never implies more than it has. */
  duplicateReason: DuplicateReason | null;

  /** Has THIS viewer opened the CV before. Never anybody else's reading — see candidate-views.ts. */
  seen: boolean;
  /**
   * How many of the three checked CV findings the reader produced and the record still lacks.
   *
   * A POINTER, not a total: the badge checks experience, national ID and job title, because
   * reading the whole extraction for every row costs 1,549 kB against 105 kB for these three.
   * The CV Data tab loads everything and stays the authority on exactly what is unsaved — so
   * this can undercount, which is the safe direction for a number whose only job is to say
   * "this CV is worth opening". See cv-findings.ts.
   */
  unsavedFindings: number;
  /**
   * The OTHER screeners who have opened it, by name. Empty when nobody else has.
   *
   * Kept apart from `seen` rather than folded into it, because the two mean different things: `seen`
   * decides whether the queue offers this CV to YOU again, while this only says the work may already
   * be done by somebody else. Two people sharing one queue with no sight of each other's reading do
   * the same CVs twice and cannot tell which — measured 2026-09-05, one person held 200 of the 249
   * recorded views and 127 of the 133 decisions.
   */
  alsoReadBy: string[];
  /**
   * Who has this CV open RIGHT NOW, by name, or null when nobody has.
   *
   * Distinct from `alsoReadBy`, which is permanent history. This is a five-minute lease that
   * expires on its own, so it answers the collision `alsoReadBy` cannot: two screeners opening the
   * same CV in the same minute, both reading it, one of the two readings wasted.
   */
  beingReadBy: string | null;
  redFlags: CandidateRedFlag[];

  sentToManagerAt: string | null;
  sentToManagerName: string | null;
  /** The seat it was sent FOR — "Nasr City · Medical Representative · Pedia". */
  sentForLabel: string | null;
  sentForVacancyId: number | null;
  /** When somebody answered: a note after the send, or a status move after it. Null = still open. */
  answeredAt: string | null;

  interviewToday: boolean;
  noteCount: number;

  phone: string | null;
  email: string | null;
  /**
   * The applicant's LinkedIn profile as a link that is safe to open, or null when the CV gave none.
   *
   * Resolved here rather than printed raw, because the stored column is not guaranteed to hold a
   * LinkedIn address at all — see linkedInProfileHref. Null is what hides the button.
   */
  linkedinUrl: string | null;
  createdAt: string;
  notACv: boolean;

  /**
   * WHERE this CV is filed, in the words a person reads - "Medical Representative · Sohag1".
   *
   * Null when it is filed nowhere, which is the ordinary case. It exists because an undecided filed
   * CV is back in this queue since 2026-09-18 (isShelvedFromReview in candidate-folder.ts), and a
   * row that silently rejoined the pile would leave the reader unable to tell it from one that was
   * never filed - the same argument `seatReason` below makes for the seat pile. A hand-built folder
   * has no name on the row, so it says so in words rather than printing an id.
   */
  folderLabel: string | null;

  /**
   * WHY this CV is in the chosen vacant seat pile, in plain words - "Filed to the Menoufia 1
   * folder", "Chose Menoufia 1 on WhatsApp", "Email subject names Menoufia 1".
   *
   * Null outside seat mode, which is every load that does not name one open seat in the link. A
   * queue that silently gains eleven rows is a queue nobody trusts, and the recruiter has no way to
   * tell a CV somebody FILED here from one a matcher guessed at unless the row says which. Names,
   * never a folder key and never an id - see vacancy-seat-queue.ts.
   */
  seatReason: string | null;

  /** Which piles this row belongs to. Precomputed so the rail filters without re-classifying. */
  queues: ScreeningWorkQueue[];
  /** The open seats this CV is attributed to. Precomputed so the vacancy rail filters in one pass. */
  vacancyIds: number[];
  /**
   * Which open requisition this CV should be attached to, or why it stays shortlisted (owner,
   * 2026-10-16 — never a Reject). Null when the reader cannot attach, or the CV is already decided.
   */
  requisitionRecommendation: RequisitionRecommendation | null;
};

/**
 * One open seat, as the workstation renders it.
 *
 * Structurally identical to `VacancyOption` — including `managerHrId` and `standingInFor`, which
 * `VacancyPickerOption` deliberately omits: the send panel needs the manager id to pre-select the
 * recipient when a seat is picked, and the picker itself never does.
 */
export type WorkspaceVacancy = {
  id: number;
  jobTitle: string;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  standingInFor: string | null;
};

/** One manager a CV can be sent to. Structurally identical to `HiringManagerOption`. */
export type WorkspaceManager = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  seatTier: string | null;
  /** Folders on the manager's shelf; see `HiringManagerOption.folders`. */
  folders?: string[];
};
