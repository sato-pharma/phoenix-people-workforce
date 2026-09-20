// Recruitment / ATS — "who has already opened this CV?", as one manager's screen shows it.
//
// The owner, 2026-09-20: "any opened CV must appear on this CV — that this person, his name, opened
// this CV at the date and time. Especially between all district managers, because the same CV goes
// to the area in CNS, Anti-infective and Pedia. It must appear that someone from Sato called <name>,
// his title, and when exactly he viewed this CV."
//
// WHY IT IS A BANNER ON THE CARD AND NOT A COLUMN IN A REPORT. The same applicant sits in several
// managers' folders at once — one Nasr City CV lands in three district managers' folders, one per
// line — and nothing told any of them that a colleague had already read it. "I will call" (see
// candidate-call-claims.ts) says a CV has been TAKEN; this says it has been LOOKED AT, which is the
// weaker and far more common fact and the one that stops three people reading and judging one
// person independently.
//
// THIS REVERSES A DELIBERATE SILENCE. Until 2026-09-20 the open was recorded silently and no portal
// screen read it back (hiring-manager-view.ts, manager-cv-engagement.ts): the manager-engagement
// report measures opens, and a manager who knows he is measured behaves differently. The owner has
// ruled for visibility between colleagues. The report and its numbers are unchanged; only the card
// now says who has read it.
//
// PURE. No database, no Next import — the loader is candidate-openers-db.ts. A "use client" card
// imports the TYPES from here and must not drag a Supabase client into the bundle.

import { canonicalHrIdKey } from "@/lib/hr-id";

/** One colleague's reading of one CV, shaped for a card. Never carries an HR id: names, not codes. */
export type CandidateOpener = {
  /** First time this person opened the CV — the moment the banner leads with. */
  firstOpenedAt: string;
  /** Most recent time, equal to `firstOpenedAt` for somebody who opened it once. */
  lastOpenedAt: string;
  name: string;
  /** How many times they opened it. Advisory: the count can undercount by one on a race. */
  openCount: number;
  /** Their job title, or null when the directory holds none. */
  title: string | null;
};

/** candidateId -> everybody except the viewer who has opened it. An absent key means nobody has. */
export type CandidateOpeners = Record<string, CandidateOpener[]>;

/** One row of `ats_candidate_views`, as the loader reads it. */
export type CandidateViewRow = {
  candidateId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  viewCount: number;
  viewerHrId: string;
};

/** What the directory knows about one employee, keyed by `openerDirectoryKey`. */
export type OpenerDirectoryEntry = { name: string | null; title: string | null };

/**
 * The one spelling of an HR id this module compares on: upper-case canonical.
 *
 * `ats_candidate_views.viewer_hr_id` is stored that way by construction, while `employees.hr_id` is
 * mixed case — 178 of 179 rows in production — so a plain equality between the two silently returns
 * nobody. Both sides go through here.
 */
export function openerDirectoryKey(value: string | null | undefined): string | null {
  return canonicalHrIdKey(value)?.toUpperCase() ?? null;
}

/**
 * What to call somebody who has opened a CV but has no employee row to take a name from.
 *
 * A code is the one thing the owner's rule forbids on a screen, and inventing a name is worse. The
 * fact "someone opened it, and when" is still worth showing, so the row keeps its time and says so.
 */
export const UNNAMED_OPENER = "A colleague";

function textOrNull(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Fold view rows into the per-candidate list a card renders.
 *
 *   • The VIEWER is never in his own list. He does not need telling that he opened a CV, and showing
 *     it would make every CV he touches look contested — the same reasoning listOtherViewersByCandidate
 *     gives for the screening queue.
 *   • Newest reading first, so the freshest fact leads the banner.
 *   • A row with no candidate or no viewer is dropped; there is nothing to say about it.
 */
export function buildCandidateOpeners(
  rows: readonly CandidateViewRow[],
  directory: ReadonlyMap<string, OpenerDirectoryEntry>,
  viewerHrId: string | null | undefined,
): CandidateOpeners {
  const me = openerDirectoryKey(viewerHrId);
  const byCandidate: CandidateOpeners = {};

  for (const row of rows) {
    const candidateId = String(row.candidateId ?? "").trim();
    const viewer = openerDirectoryKey(row.viewerHrId);
    if (!candidateId || !viewer) continue;
    if (me && viewer === me) continue;

    const entry = directory.get(viewer);
    const first = String(row.firstSeenAt ?? "");
    const last = String(row.lastSeenAt ?? "") || first;
    const opener: CandidateOpener = {
      firstOpenedAt: first || last,
      lastOpenedAt: last,
      name: textOrNull(entry?.name) ?? UNNAMED_OPENER,
      openCount: Math.max(1, Number(row.viewCount ?? 1) || 1),
      title: textOrNull(entry?.title),
    };
    (byCandidate[candidateId] ??= []).push(opener);
  }

  for (const list of Object.values(byCandidate)) {
    list.sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt));
  }
  return byCandidate;
}

/**
 * The banner's headline. Counts PEOPLE, not opens: three opens by one manager is one colleague.
 */
export function candidateOpenersHeadline(openers: readonly CandidateOpener[]): string {
  return openers.length === 1
    ? "This CV was already opened by 1 colleague"
    : `This CV was already opened by ${openers.length} colleagues`;
}

/**
 * True when a second, later opening is worth a line of its own.
 *
 * The screening screen records an open 2.5 seconds after the document renders and again on a
 * refresh, so "last opened" a few seconds after "first opened" is one reading, not two. A minute
 * apart is the smallest gap that is a real return to the CV.
 */
export function openerReopened(opener: CandidateOpener): boolean {
  if (opener.openCount < 2) return false;
  const first = Date.parse(opener.firstOpenedAt);
  const last = Date.parse(opener.lastOpenedAt);
  return Number.isFinite(first) && Number.isFinite(last) && last - first >= 60_000;
}
