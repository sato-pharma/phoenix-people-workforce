// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Leavers tab's decisions, as pure functions: how far a person's exit papers have come, what their
// mailbox tasks add up to, and where HR Forms is from this seat. Free of Supabase so the client
// component imports it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { hiringDocumentSignal, type HiringDocumentSignal } from "@/lib/hiring-documents/readiness-signal";
import type { ExitRoute } from "@/lib/hiring-pack/types";
import type {
  HiringDocumentDefinition,
  HiringLeaver,
  HiringLeaverMailbox,
} from "@/lib/hiring-documents/types";
import { daysBetweenKeys } from "@/lib/hr/talent-acquisition-logic";

/** Who is most recently gone comes first. A person with no last working day stays on the list, last. */
export function leaversNewestFirst<T extends { fullName: string; hrId: string; lastWorkingDate: string | null }>(
  leavers: readonly T[],
): T[] {
  return [...leavers].sort(
    (left, right) =>
      (right.lastWorkingDate ?? "").localeCompare(left.lastWorkingDate ?? "") ||
      left.fullName.localeCompare(right.fullName) ||
      left.hrId.localeCompare(right.hrId),
  );
}

/**
 * One person can hold several mailbox tasks, and the screen has one line. An unfinished one wins:
 * someone with one mailbox revoked and another still pending has not been dealt with.
 */
export function leaverMailboxStanding(statuses: ReadonlyArray<string | null>): HiringLeaverMailbox {
  if (statuses.length === 0) return "none";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.includes("revoked")) return "revoked";
  // Only a status the register does not know is left, and that must not read as finished.
  return statuses.every((status) => status === "not_applicable") ? "not_needed" : "pending";
}

export type LeaverExitPaper = {
  document: HiringDocumentDefinition;
  signal: HiringDocumentSignal;
  /** "either": one of the two labour papers, neither chosen yet. "greyed": the other one was chosen. */
  standing: "either" | "greyed" | "owed";
};

export type LeaverExitPapers = {
  /** The first paper not yet received, which is where "Receive papers" opens. */
  firstOutstandingId: string | null;
  papers: LeaverExitPaper[];
  received: number;
  total: number;
};

/** Asked by name, as the line's own papers are. A paper renamed away is simply owed, and stays in the count. */
const ROUTE_PAPERS: ReadonlyArray<{ matches: RegExp; route: ExitRoute }> = [
  { matches: /\bresignation request\b/iu, route: "resignation" },
  { matches: /\bmutual termination\b/iu, route: "mutualTermination" },
];

function routeOfPaper(document: HiringDocumentDefinition): ExitRoute | null {
  return ROUTE_PAPERS.find(({ matches }) => matches.test(document.name))?.route ?? null;
}

/**
 * Which of the two labour papers has been chosen. Only one is ever signed, so both stay open until one
 * is, and then the other is greyed (owner, 2026-11-03: "make resign and agreemennt both open", "if i
 * chose any of them the other is greuyed"). Choosing is the route picked in HR Forms or the one paper
 * received, and how the record says they left never chooses for anyone.
 */
function chosenExitRoute(
  exitDocuments: readonly HiringDocumentDefinition[],
  leaver: Pick<HiringLeaver, "documents" | "exitRoute">,
): ExitRoute | null {
  if (leaver.exitRoute) return leaver.exitRoute;
  const received = exitDocuments.filter(
    (document) => routeOfPaper(document) && leaver.documents[document.id]?.status === "submitted",
  );
  return received.length === 1 ? routeOfPaper(received[0]) : null;
}

/**
 * Every paper the checklist flags as an exit paper, in its own order. A joining paper a leaver never
 * handed in is the All employees question, and would bury these. Counted by the tick, as the joiners'
 * papers are; whether a scan sits behind the tick is what `signal` says. The two labour papers share
 * one place in the count, so everyone can finish.
 */
export function leaverExitPapers(
  documents: readonly HiringDocumentDefinition[],
  leaver: Pick<HiringLeaver, "documents" | "exitRoute">,
): LeaverExitPapers {
  const exitDocuments = documents.filter((document) => document.isExitDocument);
  const chosen = chosenExitRoute(exitDocuments, leaver);
  const papers = exitDocuments.map((document): LeaverExitPaper => {
    const entry = leaver.documents[document.id];
    const signal: HiringDocumentSignal = entry ? hiringDocumentSignal(entry) : "pending";
    const route = routeOfPaper(document);
    const standing = !route || route === chosen ? "owed" : chosen ? "greyed" : "either";
    return { document, signal, standing };
  });
  const isReceived = ({ document }: LeaverExitPaper) => leaver.documents[document.id]?.status === "submitted";
  const owed = papers.filter((paper) => paper.standing === "owed");
  const either = papers.filter((paper) => paper.standing === "either");
  const outstanding = papers.filter((paper) => paper.standing !== "greyed" && !isReceived(paper));
  return {
    firstOutstandingId: outstanding[0]?.document.id ?? null,
    papers,
    received: owed.filter(isReceived).length + (either.some(isReceived) ? 1 : 0),
    total: owed.length + (either.length > 0 ? 1 : 0),
  };
}

/**
 * The papers read on the line itself. Asked by name, so a paper renamed on the checklist drops off the
 * line and stays in the count and in the list beneath it.
 */
const NAMED_PAPERS = [
  { label: "Form 6", matches: /\bform\s*6\b/iu },
  { label: "Employee clearance", matches: /\bemployee clearance\b/iu },
  { label: "Company clearance", matches: /\bcompany clearance\b/iu },
] as const;

export function leaverNamedPapers(
  exit: LeaverExitPapers,
  leaver: Pick<HiringLeaver, "documents">,
): Array<{ label: string; received: boolean }> {
  return NAMED_PAPERS.flatMap(({ label, matches }) => {
    const paper = exit.papers.find(({ document }) => matches.test(document.name));
    return paper ? [{ label, received: leaver.documents[paper.document.id]?.status === "submitted" }] : [];
  });
}

/** How long ago, from the day alone. A last working day can still be ahead while notice runs out. */
export function leaverDaysLabel(todayKey: string, dayKey: string): string {
  const days = daysBetweenKeys(todayKey, dayKey);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1) return `In ${days} days`;
  if (days === -1) return "Yesterday";
  return `${Math.abs(days)} days ago`;
}

/**
 * HR Forms from whichever seat this screen is open in: both modules sit side by side under each one,
 * and HR Forms already lists the people who have left, because Form 6 is filed after they have gone.
 */
export function leaverHrFormsHref(pathname: string | null, hrId: string): string {
  const base = pathname && /hiring-documents\/?$/u.test(pathname)
    ? pathname.replace(/hiring-documents\/?$/u, "hiring-pack")
    : "/hiring-pack";
  return `${base}?hrId=${encodeURIComponent(hrId)}`;
}
