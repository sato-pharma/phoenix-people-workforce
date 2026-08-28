"use client";

// Recruitment / ATS — screening mode: the review queue.
//
// WHY THIS EXISTS. Measured through the real UI against production on 2026-08-24, screening one
// candidate in the pool cost four clicks and 8-31 seconds of waiting before a human read a word:
// open the profile (~2.6-5.7s), click the CV filename, wait for the document to render
// (2.8-25s+), close the modal, click "Back to the pool", then find your place again in a
// 426-row table. Twenty candidates took 5 minutes 40 seconds of pure machine time and 80 clicks,
// and two of the twenty never rendered at all. That is why reading the CVs in WhatsApp was
// genuinely faster, and it is the actual defect — not the columns.
//
// So this is not another view of the table. It is the loop every real ATS is built around:
// ONE candidate on screen, the CV already rendered beside the facts, a decision, and the next one
// loads itself. The next candidate's profile and CV bytes are prefetched while you read the
// current one, so the wait moves off the critical path instead of being paid 426 times.
//
// The queue is whatever the pool is currently filtered to, in the order it is displayed, so
// "screen every District Manager in Alex-BHR" is a session with a beginning and an end.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileWarning,
  Loader2,
  Maximize2,
  Minimize2,
  Send,
  SkipForward,
  Sparkles,
  X,
} from "lucide-react";

import { CandidateFactsSummary } from "@/components/recruitment/candidate-facts-summary";
import { CvDocumentView } from "@/components/recruitment/cv-preview-modal";
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import { managerPickerLabel, managerSeatLabel } from "@/lib/recruitment/manager-grouping";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import { suggestPositions } from "@/lib/recruitment/position-suggestion";
// Type-only: vacancy-options reads the service-role client and must never enter this bundle.
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateScreeningFacts, candidateScreeningRoleFamily } from "@/lib/recruitment/candidate-screening-facts";
import type { CandidateView, CandidateViewMap } from "@/lib/recruitment/candidate-views";
import {
  countByBand,
  orderForScreening,
  screeningBand,
  screeningBandDescriptions,
  screeningBandLabels,
  type ScreeningOrderInput,
} from "@/lib/recruitment/screening-order";
import {
  candidateStatusLabels,
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  normalizeCandidateStatus,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
import type { CandidateProfile } from "@/lib/recruitment/candidates";
import type { Candidate } from "@/lib/recruitment/types";

type LoadedCandidate = { profile: CandidateProfile; extraction: StoredCvExtraction | null };

// Chip colours. Deliberately muted against the dark header: this says where you are in the queue,
// it is not a verdict on the person, and a red badge beside somebody's name reads as one.
const bandChipClass: Record<ReturnType<typeof screeningBand>, string> = {
  field_force: "bg-emerald-500/15 text-emerald-300",
  pharma_adjacent: "bg-sky-500/15 text-sky-300",
  sales: "bg-indigo-500/15 text-indigo-300",
  unknown: "bg-amber-500/15 text-amber-300",
  unrelated: "bg-slate-500/20 text-slate-300",
  no_cv: "bg-slate-500/20 text-slate-400",
};

/**
 * What the ordering needs to know about one candidate, resolved through the SAME functions the row
 * and the Role filter use — so the queue cannot disagree with the table about who someone is.
 */
function describeForOrder(candidate: Candidate): ScreeningOrderInput {
  const facts = candidateScreeningFacts(candidate);
  return {
    createdAt: candidate.createdAt,
    family: candidateScreeningRoleFamily(facts, candidateRowAppliedFor(candidate).text),
    hasPharmaExperience: facts.pharmaRep?.value ?? null,
    // A file the extractor already judged not to be a CV is a settled answer, not an open question,
    // so it goes to the back rather than sitting among the ones only a person can read.
    notACv: candidate.notACv,
  };
}

/**
 * How long a CV must actually be on screen before it counts as read.
 *
 * Marking on render would count the candidates you fly past with the arrow key while looking for
 * where you stopped, and "seen" would then mean "the queue advanced through this", which is worse
 * than not tracking it at all — it would quietly hide people nobody has read. Two and a half
 * seconds is long enough that the document has painted and a person has looked at it, short enough
 * that a genuine skim still registers.
 */
const SEEN_DWELL_MS = 2500;

/**
 * The picker value meaning "not one of the open seats — I'll type it".
 *
 * A sentinel rather than an empty string, because empty already means something different and
 * important: no position at all, which is a legitimate send. Prefixed so it can never collide with
 * a vacancy id, which is always a number.
 */
const FREE_POSITION = "free:";
/**
 * "Send without a position", chosen deliberately.
 *
 * Needed only because a suggestion fills the picker when nothing has been chosen: with "" meaning
 * both "untouched" and "none", a recruiter who disagreed with the suggestion had no way to say so —
 * selecting the blank option handed them the suggestion straight back. This value says no, and
 * means it.
 */
const NO_POSITION = "none:";

/** "Nasr City · Medical Representative · Pedia" — a vacancy, as it reads in the picker. */
function vacancyPickerLabel(vacancy: VacancyOption): string {
  return positionFolderLabel({
    areaName: vacancy.areaName,
    jobTitle: vacancy.jobTitle,
    lineName: vacancy.lineName,
    regionName: vacancy.regionName,
    vacancyId: vacancy.id,
  });
}

/** "26 Aug, 05:07" — Cairo, per the standing rule that no raw UTC ever reaches a person. */
const seenAtFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function formatSeenAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return seenAtFormat.format(at);
}

export function CandidateScreeningSession({
  candidates,
  onClose,
  hiringManagers = [],
  initialViews = {},
  openVacancies = [],
  positionSuggestions = { areas: [], jobTitles: [] },
  variant = "overlay",
}: {
  candidates: Candidate[];
  onClose: (decidedCount: number) => void;
  /**
   * The managers a CV can be pushed to without leaving the queue.
   *
   * Added 2026-08-27 at the owner's instruction, in his own words: "I want to be able to send to a
   * manager from this place, I don't have to shortlist and go to other table." He was describing a
   * real dead end. Screening could say yes or no and nothing else, so the single most valuable
   * outcome of reading a CV — getting it in front of the person who will actually interview —
   * meant leaving the queue, finding that one row again in a 434-line table, and starting over
   * there. Shortlisting is a note to yourself; sending is the thing that moves a hire forward.
   *
   * Empty by default, and the control is then not rendered at all: a caller that has not loaded
   * the managers must show no button rather than one that cannot work.
   */
  hiringManagers?: HiringManagerOption[];
  /**
   * What this viewer has already read, loaded server-side. Defaults to "nothing", which is both
   * the pre-migration state and the correct behaviour for a session with no HR_ID — the queue
   * simply works the way it did before this existed rather than failing.
   */
  initialViews?: CandidateViewMap;
  /**
   * The open seats a CV can be sent FOR, read live from the organogram.
   *
   * Added 2026-08-28, again in the owner's own words: "before sending the CV to the manager, I
   * should be able to choose his area and his job title, so the same title, same area are
   * consolidated ... he goes to a folder called Nasr City Medical Reps." The manager's inbox folds
   * on what is chosen here, so this picker is the whole feature — everything downstream is filing.
   *
   * Empty by default and the picker is then not rendered: a caller that has not loaded the
   * vacancies shows the send bar exactly as it was, which still works.
   */
  openVacancies?: VacancyOption[];
  /**
   * Titles and areas already used on a send, offered under the free-typed fields. The owner asked
   * for free typing ALONGSIDE the vacancy list, knowing it can drift; these suggestions are what
   * hold that drift down without refusing anybody the freedom he asked for.
   */
  positionSuggestions?: { jobTitles: string[]; areas: string[] };
  /**
   * `overlay` keeps the original behaviour — a full-screen layer over the pool, opened and closed
   * without leaving the page. `page` is the same queue rendered as a route of its own, so it has a
   * link that can be bookmarked, reopened, and returned to. Both render identically; only the
   * outermost positioning differs, because a fixed-inset layer inside a page shell would cover the
   * shell's own navigation.
   */
  variant?: "overlay" | "page";
}) {
  // Best worth meeting first. The TABLE stays newest-first — that is a record of what arrived —
  // but only ~53 of 381 undecided CVs are field-force shaped, so meeting them in arrival order
  // means seven strangers between every real candidate. Nothing is hidden and nothing is
  // auto-rejected: every candidate is still in this queue and still gets a human decision.
  const queue = useMemo(() => orderForScreening(candidates, describeForOrder), [candidates]);
  const bands = useMemo(() => countByBand(candidates, describeForOrder), [candidates]);

  const [views, setViews] = useState<CandidateViewMap>(initialViews);

  /** Nobody has judged this one AND this viewer has never opened it. */
  const isFresh = useCallback(
    (candidate: Candidate, seen: CandidateViewMap) =>
      normalizeCandidateStatus(candidate.status) === "new" && !seen[candidate.id],
    [],
  );

  // Start where the work is. Re-entering the queue after a break should not make you click past
  // everyone you already judged — and, since 2026-08-27, nor past everyone you already READ.
  //
  // That second half is the whole complaint this fixes. Before views existed, the only thing that
  // moved this index was a decision, so reading forty CVs and judging none of them left the queue
  // convinced you had never started: 370 of 434 production candidates sat at status 'new' with no
  // timestamp of any kind. Landing on the first genuinely untouched person is what makes the queue
  // resumable instead of merely re-openable.
  //
  // Computed once, on mount, deliberately. Recomputing as decisions land would yank the queue
  // forward under the reader's hands the moment they judged somebody.
  const [index, setIndex] = useState(() => {
    const firstFresh = queue.findIndex((candidate) => isFresh(candidate, initialViews));
    if (firstFresh >= 0) return firstFresh;
    // Everything has been read or judged. Falling back to the first undecided keeps the old
    // behaviour for the one case it was right about; failing that, the start.
    return Math.max(0, queue.findIndex((candidate) => normalizeCandidateStatus(candidate.status) === "new"));
  });
  const [loaded, setLoaded] = useState<Record<string, LoadedCandidate>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, CandidateStatus>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);
  const managerRef = useRef<HTMLSelectElement | null>(null);

  // ── Sending, from inside the queue ─────────────────────────────────────────
  //
  // The chosen manager is remembered ACROSS candidates on purpose. Screening is done in runs —
  // eleven CVs went to one manager in a single sitting on 2026-08-26 — so re-picking the same
  // person from a 31-name list eleven times is the paperwork this mode exists to delete.
  const [sendManagerHrId, setSendManagerHrId] = useState("");
  /**
   * The position being hired for — remembered across candidates for exactly the same reason as the
   * manager, and more so: filling one vacancy means reading a run of CVs for that one vacancy.
   *
   * A vacancy id as a string, or FREE_POSITION when the recruiter is typing one that is not an open
   * seat yet, or "" for no position at all.
   */
  const [positionChoice, setPositionChoice] = useState("");
  const [freeAreaName, setFreeAreaName] = useState("");
  const [freeJobTitle, setFreeJobTitle] = useState("");
  /** Who each candidate was sent to in THIS session, so the confirmation survives stepping back. */
  const [sentInSession, setSentInSession] = useState<Record<string, string>>({});
  /** A full-bleed reading mode for the page variant — see `shellClass` for why it is needed. */
  const [expanded, setExpanded] = useState(false);

  const current = queue[index] ?? null;
  const total = queue.length;

  // One fetch per candidate, ever — the cache is keyed by id and never evicted, so stepping back
  // through people you have already seen is instant.
  const inFlight = useRef<Set<string>>(new Set());
  const load = useCallback(
    async (candidateId: string | undefined) => {
      if (!candidateId || inFlight.current.has(candidateId)) return;
      inFlight.current.add(candidateId);
      try {
        const res = await fetch(`/api/recruitment/candidates/${candidateId}`);
        const data = (await res.json().catch(() => ({}))) as {
          profile?: CandidateProfile;
          latestCvExtraction?: StoredCvExtraction | null;
          message?: string;
        };
        const profile = data.profile;
        if (!res.ok || !profile) throw new Error(data.message ?? "Could not load this candidate.");
        setLoaded((prev) => ({ ...prev, [candidateId]: { extraction: data.latestCvExtraction ?? null, profile } }));
      } catch (caught) {
        setFailed((prev) => ({
          ...prev,
          [candidateId]: caught instanceof Error ? caught.message : "Could not load this candidate.",
        }));
        inFlight.current.delete(candidateId);
      }
    },
    [],
  );

  // The current one, then the next — the prefetch is the whole point. By the time a decision is
  // made on this candidate, the following profile is usually already in hand.
  useEffect(() => {
    void load(queue[index]?.id);
    void load(queue[index + 1]?.id);
  }, [queue, index, load]);

  const entry = current ? loaded[current.id] : undefined;
  const cvFile = useMemo(() => (entry ? primaryCvFile(entry.profile.files) : null), [entry]);

  // "I have now read this one."
  //
  // Fired by the document actually being on screen, never by a button. The defect this whole mode
  // exists to fix is that screening 434 CVs cost too many clicks; answering it with a 435th — a
  // "mark as read" control the reader must remember to press — would have reproduced the problem
  // in a new place, and a marker a tired person forgets to set is worse than none, because the
  // queue then swears they never looked.
  //
  // Optimistic and best-effort in both directions: the badge updates locally the moment the dwell
  // passes, and a failed POST is swallowed. Losing one mark costs re-reading one CV; a red error
  // thrown across the queue at 4am costs the session.
  const markedSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const candidateId = current?.id;
    // `entry` is the gate that matters: it means the profile and CV have actually arrived, so the
    // timer measures time in front of a document rather than time in front of a spinner.
    if (!candidateId || !entry || markedSeen.current.has(candidateId)) return;

    const timer = setTimeout(() => {
      markedSeen.current.add(candidateId);
      const seenAt = new Date().toISOString();
      setViews((previous) => {
        const existing = previous[candidateId];
        return {
          ...previous,
          [candidateId]: {
            firstSeenAt: existing?.firstSeenAt ?? seenAt,
            lastSeenAt: seenAt,
            viewCount: (existing?.viewCount ?? 0) + 1,
          },
        };
      });
      void fetch(`/api/recruitment/candidates/${candidateId}/seen`, { method: "POST" }).catch(() => {
        // Deliberately silent. See above — this must never interrupt somebody mid-queue.
      });
    }, SEEN_DWELL_MS);

    return () => clearTimeout(timer);
  }, [current?.id, entry]);

  const goTo = useCallback(
    (next: number) => {
      setError(null);
      setNote("");
      setIndex(Math.min(Math.max(next, 0), total - 1));
    },
    [total],
  );

  /**
   * Jump to the next CV this viewer has never opened and nobody has judged.
   *
   * Searches FORWARD from where you are and then, only if there is nothing ahead, wraps to the
   * start — so pressing it repeatedly walks the unread pile in order instead of bouncing back to
   * the same person. Returns false when there is genuinely nothing left, which is what lets the
   * button disable itself honestly rather than becoming a no-op that looks broken.
   */
  const jumpToNextFresh = useCallback(() => {
    const from = index + 1;
    const ahead = queue.findIndex((candidate, at) => at >= from && isFresh(candidate, views));
    if (ahead >= 0) {
      goTo(ahead);
      return true;
    }
    const wrapped = queue.findIndex((candidate) => isFresh(candidate, views));
    if (wrapped >= 0 && wrapped !== index) {
      goTo(wrapped);
      return true;
    }
    return false;
  }, [goTo, index, isFresh, queue, views]);

  const decide = useCallback(
    async (status: CandidateStatus) => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${current.id}/status`, {
          body: JSON.stringify({ note: note.trim() || undefined, status }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data.message ?? "Could not save that decision.");
        }
        setDecided((prev) => ({ ...prev, [current.id]: status }));
        setNote("");
        // Auto-advance. Not advancing past the last one — the summary bar is the ending.
        if (index < total - 1) setIndex(index + 1);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that decision.");
      } finally {
        setBusy(false);
      }
    },
    [busy, current, index, note, total],
  );

  /**
   * Push this CV to a manager without leaving the queue.
   *
   * Deliberately NOT a decision. It does not advance, and it does not shortlist: sending a CV to a
   * District Manager to read is a different act from judging it, and collapsing the two would mean
   * a recruiter could never send one without also recording a verdict they may not have reached.
   * The queue stays exactly where it is so the next thing pressed can be Shortlist, Reject, or
   * Skip — whichever the reader actually meant.
   *
   * The failure is shown, never swallowed. This is the one action here that reaches another human,
   * and "it quietly did nothing" is precisely the defect that made this send visible in the first
   * place: three of five production sends failed silently inside a `catch {}` in August.
   */
  /**
   * Choose the position, and let it choose the manager.
   *
   * Picking a vacancy pre-selects the manager that vacancy reports to. That is the point of picking
   * rather than typing: the organogram already knows who owns the seat, and choosing the wrong
   * manager is how a CV lands where nobody is looking. It only ever FILLS the manager, never clears
   * one — a recruiter who deliberately picked the National Sales Manager keeps them, and a vacancy
   * whose own manager seat is vacant (a real row here) changes nothing.
   */
  const choosePosition = useCallback(
    (value: string) => {
      setPositionChoice(value);
      if (value === FREE_POSITION || !value) return;
      const vacancy = openVacancies.find((option) => String(option.id) === value);
      const managerHrId = vacancy?.managerHrId;
      if (!managerHrId) return;
      if (!hiringManagers.some((manager) => manager.hrId === managerHrId)) return;
      setSendManagerHrId(managerHrId);
    },
    [hiringManagers, openVacancies],
  );

  // ── What this CV looks like it is FOR ──────────────────────────────────────
  //
  // The owner, 2026-08-28: "why don't we use the help of the AI to recommend? And that's your
  // confirm. The HR confirm." So the picker opens on an answer and a person keeps or changes it.
  //
  // DERIVED, NEVER STORED. Writing the suggestion into state on each candidate would need an effect
  // that sets state, which is a lint error in this repository, and would also fight the deliberate
  // stickiness of `positionChoice` — the position is remembered across candidates because filling
  // one vacancy means reading a run of CVs for that one vacancy. Deriving it means a recruiter's own
  // choice always wins and the suggestion only ever speaks into an empty picker.
  const suggestion = useMemo(
    () => (current ? suggestPositions(current, openVacancies) : { confident: null, shortlist: [] }),
    [current, openVacancies],
  );

  /**
   * The position that will actually be sent.
   *
   * `positionChoice` is what the recruiter chose, and it wins whenever they have chosen anything at
   * all — including NO_POSITION, which is how they say no to a suggestion.
   */
  const effectivePosition =
    positionChoice === NO_POSITION
      ? ""
      : positionChoice || (suggestion.confident ? String(suggestion.confident.vacancy.id) : "");

  /**
   * The manager who will actually be sent to.
   *
   * A suggested position carries its own manager, the same way picking a vacancy by hand does — the
   * organogram already knows who owns the seat. Only ever fills an empty picker, and only with
   * somebody who is actually in the list: a seat whose own manager post is vacant is a real row
   * here, and it must leave the send disabled rather than address a CV to nobody.
   */
  const suggestedManagerHrId =
    positionChoice === "" && suggestion.confident?.vacancy.managerHrId
      ? suggestion.confident.vacancy.managerHrId
      : "";
  const effectiveManagerHrId =
    sendManagerHrId ||
    (hiringManagers.some((manager) => manager.hrId === suggestedManagerHrId) ? suggestedManagerHrId : "");

  const sendToManager = useCallback(async () => {
    if (!current || busy || !effectiveManagerHrId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${current.id}/notify-manager`, {
        // The position, when one is chosen. A picked vacancy sends only its ID — the server reads
        // the seat back and stamps that, so the words on this screen can never disagree with the
        // words in the folder. A typed one sends the words, and the server cleans them.
        body: JSON.stringify({
          managerHrId: effectiveManagerHrId,
          ...(positionChoice === FREE_POSITION
            ? { positionAreaName: freeAreaName, positionJobTitle: freeJobTitle }
            : effectivePosition
              ? { vacancyId: Number(effectivePosition) }
              : {}),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        result?: { managerName?: string };
        message?: string;
      };
      if (!res.ok) throw new Error(data.message ?? "Could not send this CV to that manager.");
      // The NAME the server confirmed, not the one this component guessed from its own list — per
      // the standing rule that a raw HR_ID never reaches a person, and because the server is the
      // thing that knows who was actually told. Read from `result`, which is the envelope both
      // notify-manager routes answer with; reading it off the top level silently missed every time
      // and fell through to the local guess, which was right only because the list is the same one.
      const managerName =
        data.result?.managerName ??
        hiringManagers.find((manager) => manager.hrId === effectiveManagerHrId)?.name ??
        effectiveManagerHrId;
      setSentInSession((previous) => ({ ...previous, [current.id]: managerName }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send this CV to that manager.");
    } finally {
      setBusy(false);
    }
  }, [busy, current, effectiveManagerHrId, effectivePosition, freeAreaName, freeJobTitle, hiringManagers, positionChoice]);

  const decidedCount = Object.keys(decided).length;

  // Keyboard is what makes a queue a queue. Ignored while typing a note, so "s" in "salary" does
  // not shortlist somebody.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // SELECT counts as typing. It is not a text field, but its own keys ARE letters — typing "n"
      // in an open manager list jumps to Nosiba — so leaving it out would mean the shortcut for
      // the note field silently hijacked the picker the moment somebody used it.
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;
      if (event.key === "Escape") {
        event.preventDefault();
        // Blur whatever is actually focused, not the note specifically — the manager picker is a
        // focusable field too, and Escape from it must let go of it rather than of the note.
        if (typing) target?.blur();
        // Escape leaves full-bleed reading before it leaves the queue. Anything else would make
        // the widest, most useful way to read a CV the one that costs a whole session to exit.
        else if (expanded) setExpanded(false);
        else onClose(decidedCount);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") { event.preventDefault(); void decide("shortlisted"); }
      else if (key === "r") { event.preventDefault(); void decide("rejected"); }
      else if (key === "arrowright" || key === " ") { event.preventDefault(); goTo(index + 1); }
      else if (key === "arrowleft") { event.preventDefault(); goTo(index - 1); }
      else if (key === "n") { event.preventDefault(); noteRef.current?.focus(); }
      // U for unseen. The one key that makes a 434-long queue usable on the second visit.
      else if (key === "u") { event.preventDefault(); jumpToNextFresh(); }
      // M FOCUSES the picker — it does not send. Every other shortcut here is reversible inside
      // this screen; a send reaches another human's notifications and cannot be taken back, so it
      // stays a deliberate press of a button. The key removes the hunting, not the intent.
      else if (key === "m") { event.preventDefault(); managerRef.current?.focus(); }
      // F for full width, page variant only — the overlay is already full-bleed.
      else if (key === "f" && variant === "page") { event.preventDefault(); setExpanded((on) => !on); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, decidedCount, expanded, goTo, index, jumpToNextFresh, onClose, variant]);

  // A fixed layer for the overlay; a tall flex column that fills its parent for the page. The
  // overlay's z-index and backdrop would fight the portal shell's own chrome if a page reused them.
  //
  // `expanded` lets the PAGE borrow the overlay's geometry on demand, and it is not a flourish.
  // Measured on a 1366×850 laptop: inside the admin shell the CV pane is 652px wide against an
  // 816px Word page, while the overlay — which covers the ~292px sidebar — gets ~986px. So the
  // same document that reads perfectly in the overlay is squeezed on its own page, which is the
  // regression the owner reported as the CV "appearing as one text". Fit-to-width in the viewer
  // handles the squeeze; this removes the cause, and hands the whole screen to the only task on
  // this page that wants it.
  const fullBleed = variant === "overlay" || expanded;
  const shellClass = fullBleed
    ? "fixed inset-0 z-[190] flex flex-col bg-slate-900"
    : "flex h-[calc(100vh-4rem)] min-h-[32rem] flex-col overflow-hidden rounded-lg bg-slate-900";

  if (!current) {
    return (
      <div
        className={
          variant === "overlay"
            ? "fixed inset-0 z-[190] flex items-center justify-center bg-slate-900/80 p-6"
            : "flex min-h-[24rem] items-center justify-center rounded-lg bg-slate-900/80 p-6"
        }
      >
        <div className="rounded-lg bg-white p-6 text-center">
          <p className="text-sm text-slate-700">There is nobody in this queue — clear a filter and try again.</p>
          <button
            className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            onClick={() => onClose(0)}
            type="button"
          >
            Back to the pool
          </button>
        </div>
      </div>
    );
  }

  // Counted across the WHOLE QUEUE, from the status each candidate actually carries, not from what
  // was decided in this sitting.
  //
  // This is the defect the owner reported as "the rejected and the shortlisted became zero and
  // everything is lost". The work was never lost — 31 shortlisted, 12 rejected and 21 sent were
  // all sitting safely in production while the header read 0 — but the counter was a session
  // variable that started empty on every mount, so the screen swore nothing had been done. A
  // scoreboard that resets is not a cosmetic problem: it is the screen telling a tired person at
  // 4am that last night's four hours did not happen.
  //
  // `decided` still wins per candidate, because it holds the answer that is newer than the prop.
  const statusOf = (candidate: Candidate) =>
    decided[candidate.id] ?? normalizeCandidateStatus(candidate.status);
  const shortlisted = queue.filter((candidate) => statusOf(candidate) === "shortlisted").length;
  const rejected = queue.filter((candidate) => statusOf(candidate) === "rejected").length;
  const seenCount = queue.filter((candidate) => Boolean(views[candidate.id])).length;
  const freshRemaining = queue.filter((candidate) => isFresh(candidate, views)).length;
  const thisDecision = decided[current.id] ?? null;
  const currentView: CandidateView | undefined = views[current.id];
  const firstSeenLabel = formatSeenAt(currentView?.firstSeenAt);
  // Has anybody already been shown this CV?
  //
  // Two sources, and both are needed. `sentInSession` is what happened a moment ago on this screen;
  // `managerNotified` is the stamp on the row, which is the only half that survives a reload. Asking
  // just the row would make the confirmation vanish the instant it mattered most — the send does not
  // re-fetch the queue — and asking just the session would present a candidate already sitting with
  // a District Manager as untouched, which is how the same CV reaches the same person twice.
  const sentNow = sentInSession[current.id] ?? null;
  const priorSend = current.managerNotified;
  const priorSendSeat = priorSend ? managerSeatLabel(priorSend) : "";
  const priorSendAt = formatSeenAt(priorSend?.sentAt);
  // The POSITION the last send was filed under — a different thing from the manager's own seat
  // above, and the one that answers "have I already sent this person for this vacancy?".
  const priorSendPosition = current.sentFor ? positionFolderLabel(current.sentFor) : "";
  // The status the row already carried before this session — so a candidate somebody judged last
  // week is not silently presented as untouched.
  //
  // Normalized rather than cast. A legacy free-text status (production carried 'Candidate Created'
  // on 225 rows before the 2026-08-15 backfill) would index candidateStatusLabels to `undefined`
  // and throw on .toLowerCase() below — a raw cast asserts a shape the column does not guarantee.
  const existingStatus: CandidateStatus = normalizeCandidateStatus(current.status) ?? "new";
  const currentBand = screeningBand(describeForOrder(current));
  const loadError = failed[current.id];

  return (
    <div className={shellClass}>
      {/* Where you are, what you have done, and the way out. Progress is not decoration here: the
          reason the pool felt endless is that it never said how much was left. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-700 px-4 py-2.5 text-white">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black tabular-nums">
            {index + 1} <span className="text-slate-400">/ {total}</span>
          </span>
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-orange-500 transition-[width]"
              style={{ width: `${Math.round(((index + 1) / total) * 100)}%` }}
            />
          </div>
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{candidateDisplayName(current.fullName)}</p>
        {/* Which group this person is in, and how many are in it. Without this the queue's order is
            invisible and reads as random — and the one thing a screener must never have to wonder
            is why they are being shown this person now. */}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${bandChipClass[currentBand]}`}
          title={screeningBandDescriptions[currentBand]}
        >
          {screeningBandLabels[currentBand]} · {bands[currentBand]}
        </span>
        {/* The running totals, and they are the REAL ones — every shortlist and rejection this
            queue carries, not just the ones made since this screen opened. */}
        <div className="flex items-center gap-3 text-xs tabular-nums">
          <span className="text-emerald-400">{shortlisted} shortlisted</span>
          <span className="text-rose-400">{rejected} rejected</span>
          <span className="text-slate-400" title="CVs you have opened at least once">
            {seenCount} read
          </span>
        </div>
        {/* The way back into the unread pile. Disabled rather than hidden when the pile is empty:
            "0 left to read" is the single most useful thing this header can say at the end of a
            session, and a button that vanishes reads as a bug. */}
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-slate-700 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-slate-600 disabled:cursor-default disabled:opacity-40"
          disabled={freshRemaining === 0}
          onClick={() => jumpToNextFresh()}
          title="Jump to the next CV you have never opened — press U"
          type="button"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {freshRemaining} never read
          <kbd className="text-[10px] font-normal opacity-70">U</kbd>
        </button>
        {/* Full-width reading. Page variant only — the overlay already covers everything, so the
            control would be a lie there. */}
        {variant === "page" ? (
          <button
            aria-label={expanded ? "Leave full width" : "Read at full width"}
            aria-pressed={expanded}
            className="rounded-md p-1.5 text-slate-300 transition hover:bg-slate-700 hover:text-white"
            onClick={() => setExpanded((on) => !on)}
            title={expanded ? "Back to the page — press F or Escape" : "Read at full width — press F"}
            type="button"
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        ) : null}
        <button
          aria-label="Leave screening mode"
          className="rounded-md p-1.5 text-slate-300 transition hover:bg-slate-700 hover:text-white"
          onClick={() => onClose(decidedCount)}
          type="button"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* The CV, already open. This is the single biggest change: the document is the thing a
            screener actually reads, and it used to be three layers down. */}
        <div className="min-h-0 flex-1 overflow-auto bg-slate-100">
          {loadError ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <p className="text-sm text-rose-600">{loadError}</p>
            </div>
          ) : !entry ? (
            <div className="flex h-full items-center justify-center gap-2 p-6 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading the CV…</span>
            </div>
          ) : cvFile ? (
            // Keyed by file id so switching candidates tears the old document down rather than
            // painting the new one underneath it.
            <CvDocumentView
              downloadUrl={`/api/recruitment/files/${cvFile.id}/download`}
              fileName={cvFile.fileName}
              key={cvFile.id}
              mimeType={cvFile.mimeType}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileWarning className="h-6 w-6 text-amber-500" />
              <p className="text-sm font-semibold text-slate-700">No readable CV attached</p>
              <p className="max-w-sm text-xs text-slate-500">
                {entry.profile.files.length === 0
                  ? "Nothing was attached to this candidate."
                  : `${entry.profile.files.length} file(s) attached, none of them a CV this viewer can draw.`}
              </p>
            </div>
          )}
        </div>

        {/* The facts and the decision, side by side with the document so nothing needs closing. */}
        <aside className="flex w-full shrink-0 flex-col overflow-auto border-t border-slate-200 bg-white lg:w-[380px] lg:border-l lg:border-t-0">
          <div className="flex-1 space-y-3 p-4">
            <div>
              <p className="text-base font-black leading-tight text-slate-900">
                {candidateDisplayName(current.fullName)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {[current.email, current.phone].filter(Boolean).join(" · ") || "No contact details"}
              </p>
              {/* Have I read this one before?
                  The question the owner actually asked for, answered in the one place he is
                  already looking. "First time" is stated as loudly as the alternative on purpose:
                  a badge that only ever appears when something is true trains a reader to see its
                  absence as "the feature is broken" rather than as an answer. */}
              {currentView ? (
                <p
                  className="mt-1.5 inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                  title={
                    currentView.viewCount > 1
                      ? `Opened ${currentView.viewCount} times — first on ${firstSeenLabel ?? "an earlier session"}`
                      : undefined
                  }
                >
                  <Eye className="h-3 w-3" />
                  {/* The FIRST time, not the last. "You have had this open before" is the useful
                      sentence; the last view is usually thirty seconds ago because it is this one. */}
                  Seen before{firstSeenLabel ? ` · ${firstSeenLabel}` : ""}
                  {currentView.viewCount > 1 ? ` · ${currentView.viewCount}×` : ""}
                </p>
              ) : (
                <p className="mt-1.5 inline-flex items-center gap-1 rounded bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                  <Sparkles className="h-3 w-3" />
                  First time
                </p>
              )}
              {existingStatus !== "new" && !thisDecision ? (
                <p className="ml-1.5 mt-1.5 inline-flex rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  Already {candidateStatusLabels[existingStatus].toLowerCase()}
                </p>
              ) : null}
            </div>

            {entry ? (
              <CandidateFactsSummary candidate={entry.profile.candidate} columns={1} extraction={entry.extraction} />
            ) : null}
          </div>

          <div className="sticky bottom-0 space-y-2 border-t border-slate-200 bg-white p-3">
            {error ? <p className="text-xs text-rose-600">{error}</p> : null}
            {thisDecision ? (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                <Check className="h-3.5 w-3.5" />
                Saved as {candidateStatusLabels[thisDecision].toLowerCase()}
              </p>
            ) : null}
            {/* Optional, and deliberately one line: a reason is worth having, but a required field
                would turn a two-second decision back into a form. */}
            <input
              className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
              maxLength={CANDIDATE_STATUS_NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Reason (optional) — press N"
              ref={noteRef}
              value={note}
            />
            {/* ── Send this CV to a manager, from right here ─────────────────────────────────
                The owner's words: "I want to be able to send to a manager from this place, I don't
                have to shortlist and go to other table, make the two options available." So both
                options sit in the same bar — sending is not a consequence of shortlisting and does
                not become one. Rendered only when the caller actually loaded the manager list; a
                picker with nothing in it is worse than no picker. */}
            {hiringManagers.length > 0 ? (
              <div className="space-y-1.5 rounded-md border border-orange-200 bg-orange-50/70 p-2">
                {/* What is already true, before offering to change it. */}
                {sentNow ? (
                  <p className="flex items-start gap-1.5 text-[11px] font-bold text-orange-800">
                    <Check className="mt-px h-3 w-3 shrink-0" />
                    <span>Sent to {sentNow}</span>
                  </p>
                ) : priorSend ? (
                  <p className="flex items-start gap-1.5 text-[11px] font-semibold text-orange-800">
                    <Check className="mt-px h-3 w-3 shrink-0" />
                    {/* Name, seat, and Cairo time — never an HR_ID, never raw UTC. The seat is the
                        one frozen onto the row at send time, so a manager who has since moved area
                        does not silently rewrite where this CV went. */}
                    <span>
                      Sent to {priorSend.name}
                      {priorSendSeat ? ` · ${priorSendSeat}` : ""}
                      {priorSendPosition ? ` for ${priorSendPosition}` : ""}
                      {priorSendAt ? ` on ${priorSendAt}` : ""}
                    </span>
                  </p>
                ) : null}
                {/* ── Which position is this CV FOR? ────────────────────────────────────────
                    The owner, 2026-08-28: "before sending the CV to the manager, I should be able
                    to choose his area and his job title, so the same title, same area are
                    consolidated." This is that choice. It is what the manager's inbox folds on, so
                    it is chosen BEFORE the send rather than sorted out afterwards.

                    Optional, deliberately. A send with no position is what every send looked like
                    until today, and refusing one would block the flow rather than improve the
                    filing — the manager's screen keeps those under their own heading. */}
                {openVacancies.length > 0 ? (
                  <div className="space-y-1.5">
                    <select
                      aria-label="Which position is this CV for"
                      className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 outline-none focus:border-orange-400"
                      onChange={(event) => choosePosition(event.target.value)}
                      title="The position this CV is for — the manager sees it filed under this"
                      value={positionChoice === NO_POSITION ? NO_POSITION : effectivePosition}
                    >
                      <option value="">For which position? (optional)</option>
                      {/* The seats this CV looks like it is for, offered first and pre-selected when
                          there is only one of them. Never labelled as a machine's opinion — the
                          standing rule is that assistive inference is invisible to users — and never
                          the whole answer: every open vacancy is still listed below, in full. */}
                      {suggestion.shortlist.length > 0 ? (
                        <optgroup label={suggestion.confident ? "Looks like this one" : "Looks like one of these"}>
                          {suggestion.shortlist.map((entry) => (
                            <option key={`suggested-${entry.vacancy.id}`} value={String(entry.vacancy.id)}>
                              {vacancyPickerLabel(entry.vacancy)}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {suggestion.confident ? (
                        <option value={NO_POSITION}>No position — send without one</option>
                      ) : null}
                      <optgroup label="Open vacancies">
                        {openVacancies.map((vacancy) => (
                          <option key={vacancy.id} value={String(vacancy.id)}>
                            {vacancyPickerLabel(vacancy)}
                          </option>
                        ))}
                      </optgroup>
                      <option value={FREE_POSITION}>Another position — type it</option>
                    </select>
                    {/* WHY it looks like that, in facts off this CV — where they live, what they do
                        now — so a recruiter can check it against the page in front of them instead
                        of trusting it. No score and no percentage: a number invites believing the
                        number, which is the one thing this must not encourage. Shown only while the
                        suggestion is what the picker is actually holding. */}
                    {suggestion.confident && positionChoice === "" && suggestion.confident.reasons.length > 0 ? (
                      <p className="text-[11px] leading-tight text-slate-600">
                        {suggestion.confident.reasons.join(" · ")}
                      </p>
                    ) : null}
                    {positionChoice === FREE_POSITION ? (
                      <div className="grid grid-cols-2 gap-1.5">
                        {/* Suggestions, not a closed list: the point of this option is that the
                            position need not be an open seat yet. Offering what has already been
                            typed is what stops a second "Marketing Exec." opening a folder that
                            reads almost exactly like the first one. */}
                        <input
                          aria-label="Area"
                          className="h-8 min-w-0 rounded-md border border-slate-300 px-2 text-xs outline-none focus:border-orange-400"
                          list="screening-position-areas"
                          onChange={(event) => setFreeAreaName(event.target.value)}
                          placeholder="Area"
                          value={freeAreaName}
                        />
                        <input
                          aria-label="Job title"
                          className="h-8 min-w-0 rounded-md border border-slate-300 px-2 text-xs outline-none focus:border-orange-400"
                          list="screening-position-titles"
                          onChange={(event) => setFreeJobTitle(event.target.value)}
                          placeholder="Job title"
                          value={freeJobTitle}
                        />
                        <datalist id="screening-position-areas">
                          {positionSuggestions.areas.map((area) => (
                            <option key={area} value={area} />
                          ))}
                        </datalist>
                        <datalist id="screening-position-titles">
                          {positionSuggestions.jobTitles.map((title) => (
                            <option key={title} value={title} />
                          ))}
                        </datalist>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex items-center gap-1.5">
                  <select
                    aria-label="Send this CV to a manager"
                    className="h-8 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 outline-none focus:border-orange-400"
                    onChange={(event) => setSendManagerHrId(event.target.value)}
                    ref={managerRef}
                    title="Choose a manager — press M"
                    value={effectiveManagerHrId}
                  >
                    <option value="">Send to a manager…</option>
                    {hiringManagers.map((manager) => (
                      <option key={manager.hrId} value={manager.hrId}>
                        {managerPickerLabel(manager)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-orange-600 px-3 text-xs font-bold text-white transition hover:bg-orange-700 disabled:opacity-40"
                    disabled={busy || !effectiveManagerHrId}
                    onClick={() => void sendToManager()}
                    type="button"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {sentNow || priorSend ? "Send again" : "Send"}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <button
                className="flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => void decide("shortlisted")}
                type="button"
              >
                <Check className="h-4 w-4" /> Shortlist <kbd className="text-[10px] font-normal opacity-70">S</kbd>
              </button>
              <button
                className="flex items-center justify-center gap-1.5 rounded-md bg-rose-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-rose-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => void decide("rejected")}
                type="button"
              >
                <X className="h-4 w-4" /> Reject <kbd className="text-[10px] font-normal opacity-70">R</kbd>
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-40"
                disabled={index === 0}
                onClick={() => goTo(index - 1)}
                type="button"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Back
              </button>
              <div className="flex items-center gap-1">
                {/* Skip past everything already read, in one press. The pair matters: plain Skip
                    steps one forward through the queue as displayed, this one steps to the next
                    person nobody has looked at. Reviewing the pile you already know is a real
                    thing to want; being forced to is what made the queue feel endless. */}
                <button
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-50 disabled:opacity-40"
                  disabled={freshRemaining === 0}
                  onClick={() => jumpToNextFresh()}
                  title="Next CV nobody has read yet — press U"
                  type="button"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Next unread
                </button>
                <button
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
                  disabled={index >= total - 1}
                  onClick={() => goTo(index + 1)}
                  type="button"
                >
                  <SkipForward className="h-3.5 w-3.5" /> Skip <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
