"use client";

// Recruitment / ATS — the screening workstation.
//
// ── WHAT THIS REPLACES, AND WHY ─────────────────────────────────────────────────────────────────
//
// The screening page was a wide candidate table. Reading one CV meant: find the row, open the
// drawer, open the CV modal on top of the drawer, read, close both, find where you were, decide,
// find the next row. Seven moves per candidate, over a pool that runs past 500, and the ordering
// facts the recruiter needed — is this a duplicate, has a manager answered, is this even the right
// seat — were spread across three screens that could not be open at once.
//
// This is one screen, and it stays open for the whole session. Four areas, left to right:
//
//   1. WORK QUEUE      what needs attention, and which seat  — narrows, never navigates
//   2. CANDIDATE LIST  a compact vertical queue              — the CV is chosen here
//   3. CV              the real document, always open        — the largest thing on the screen
//   4. INTELLIGENCE    snapshot, fit, history, notes         — beside the CV, not behind it
//
// The header and the decision bar sit above 3 and 4, so a decision is always in the same place.
//
// ── THE FOUR THINGS THIS SHELL OWNS ─────────────────────────────────────────────────────────────
//
// STATE. Queue, vacancy, search, selection and open tab all live here, and none of them is a route
// change: narrowing the list must never cost a page load, and it must never lose the CV that is
// open. The server's own filters (status, area, seen, region…) DO stay in the URL, because those
// change what is loaded and a recruiter shares that link.
//
// THE CACHE. One fetch per candidate, ever, keyed by id and never evicted, plus a prefetch of the
// NEXT one while the current is being read — so by the time a decision is made the following CV is
// usually already in hand. Stepping back through people already read is instant.
//
// OPTIMISTIC DECISIONS THAT DO NOT MOVE THE LIST. A decided row keeps its position and wears its
// new status until the page is reloaded. This is deliberate and it is the single most important
// interaction rule here: a queue that yanks a row out from under the cursor the moment it is
// actioned loses the reader's place on every decision, which is precisely the cost this screen
// exists to remove. The counts in the rail are the server's and are honest about being a snapshot.
//
// THE RESPONSIVE COLLAPSE. Four panes at a workstation; three at a laptop; one at a time on a
// phone, chosen by a segmented control. No pane ever overflows sideways — the fits-the-screen rule
// is absolute, so every fixed column is `shrink-0` and the CV pane is `min-w-0 flex-1`.
//
// ── A CV'S OWN PAGE ─────────────────────────────────────────────────────────────────────────────
//
// Pressing a CV in the list opens it in a NEW TAB, on a page of its own (`ownPage`): the CV, its
// details and its decisions — no work queue, no list. The owner asked for exactly that on
// 2026-09-18, because reading in the pane beside the list cost him his place in it on every CV.
// It is this same component rather than a second screen, so a verdict given there is the same
// verdict, through the same code, as one given here; and the two tabs report their writes to each
// other (screening-tab-sync.ts), so the list he goes back to already shows what he decided.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileSearch, FileX2, Layers, PanelLeft, X } from "lucide-react";

import {
  adminChipDepthClassName,
  adminPanelDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";

import {
  BULK_DECISION_MAX,
  bulkDecidableStatuses,
  candidateStatusLabels,
  type BulkDecidableStatus,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";
import {
  screeningWorkQueueEmptyLabels,
  screeningWorkQueueLabels,
  type ScreeningWorkQueue,
  type WorkQueueCounts,
} from "@/lib/recruitment/screening-queues";
import { DUPLICATE_FOLDER_KEY, DUPLICATE_FOLDER_KIND } from "@/lib/recruitment/candidate-folder";
import { FREE_POSITION, NO_POSITION } from "@/components/recruitment/vacancy-picker";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { ExtractedCvValue, StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
import type { ScreeningQuestionLabel } from "@/lib/recruitment/whatsapp-answers";
import type {
  WorkspaceCandidateRow,
  WorkspaceManager,
  WorkspaceVacancy,
} from "@/lib/recruitment/screening-workspace-types";
import type { VacancyApplicantStats } from "@/lib/recruitment/vacancy-applicants";
import { WorkstationCandidateList } from "@/components/recruitment/workstation/workstation-candidate-list";
import { WorkstationCvPane, type CvPaneFile } from "@/components/recruitment/workstation/workstation-cv-pane";
import {
  WorkstationIntelligencePanel,
  type IntelligenceTab,
} from "@/components/recruitment/workstation/workstation-intelligence";
import { WorkstationQueuePanel } from "@/components/recruitment/workstation/workstation-queue-panel";
import { WorkstationReviewHeader, type SendState } from "@/components/recruitment/workstation/workstation-review-header";
import { parseCandidateRating, type CandidateRating } from "@/lib/recruitment/candidate-rating";
import {
  openScreeningTabChannel,
  type ScreeningTabChannel,
  type ScreeningTabMessage,
} from "@/lib/recruitment/screening-tab-sync";
import { Action, Band, BandSays } from "@/components/recruitment/workstation/workstation-look";
import { EmptyNote, PaneSpine } from "@/components/recruitment/workstation/workstation-ui";
import { cn } from "@/lib/utils";
import { candidateDecisionTabLabels, type CandidateDecisionTab } from "@/lib/recruitment/candidate-decision-tabs";

/**
 * What one loaded candidate is: the profile, the CV read if there is one, and the wording of the
 * admin-defined WhatsApp questions their answers are printed under (null when it could not be read).
 */
type LoadedCandidate = {
  profile: CandidateProfileShape;
  extraction: StoredCvExtraction | null;
  screeningQuestions: ScreeningQuestionLabel[] | null;
};

/**
 * The half of `CandidateProfile` this screen touches.
 *
 * Structurally typed for the same reason the option types are: `candidates.ts` reaches the
 * service-role client, so naming its type from a `"use client"` module would pull it into the
 * browser bundle.
 */
type CandidateProfileShape = {
  candidate: Candidate;
  files: Array<{
    id: string;
    candidateId: string | null;
    applicationId: string | null;
    kind: string;
    fileName: string;
    mimeType: string | null;
    sizeBytes: number | null;
    driveFileId: string | null;
    externalUrl: string | null;
    uploadedByHrId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

/** Which single pane is on screen below the laptop breakpoint. */
type MobilePane = "list" | "cv" | "panel";

/**
 * How long a decision can be taken back.
 *
 * Ten seconds is the width of "I pressed the wrong one", and deliberately not longer. The undo is a
 * strip across the screen; leaving it up for a minute turns it into furniture that gets pressed by
 * accident, and an undo pressed by accident is itself an undecided candidate back in the queue.
 * Nothing is lost when it expires — the decision is on the record and can be changed the ordinary
 * way, with a reason.
 */
const UNDO_WINDOW_MS = 10_000;

/** A decision that can still be taken back, with what each candidate must be put back to. */
type PendingUndo = {
  moves: Array<{ id: string; note: string | null; status: CandidateStatus }>;
  /** The sentence on the strip — already resolved to names, never ids. */
  label: string;
  expiresAt: number;
};

export function ScreeningWorkstation({
  canDecide,
  candidateHref,
  canReply,
  openCandidateId,
  canSendToManagers,
  canWriteNotes,
  counts,
  decisionTab,
  filteredOut,
  focus,
  onToggleFocus,
  hiringManagers,
  overdueManagerFeedback,
  ownPage,
  poolSize,
  onSelectVacancy,
  onLeaveWhatsAppSearch,
  positionSuggestions,
  rows,
  seatLabel,
  vacancies,
  vacancyId,
  vacancyStats,
  whatsAppSearch,
}: {
  /**
   * May this reader decide candidates — the gate on both the single verdict and the bulk one.
   *
   * Its own prop rather than a second use of `canWriteNotes`, even though the two are the same
   * value today. They answer different questions, and the day notes are gated separately from
   * decisions, a shared prop would move who can reject fifty CVs without anybody editing this file.
   * `candidates: update`, the grant every verdict route asserts.
   */
  canDecide: boolean;
  /**
   * May this reader answer an applicant on WhatsApp — `recruitment: update`, the reply route's own
   * grant. It rode on `canDecide` until 2026-09-18.
   */
  canReply: boolean;
  /**
   * The address of one CV in this queue, so every row can be a real link.
   *
   * The rows were `<button>`s, which no browser can open in a new tab by any means — not
   * ctrl-click, not middle-click, not the context menu. That is what the owner hit on 2026-09-18:
   * reading a CV pushed him down one shared scroll and getting back to his place in the list was
   * the expensive part of every single CV.
   */
  candidateHref: (candidateId: string) => string;
  /**
   * The CV named in the URL, opened on arrival. Null on an ordinary load.
   *
   * Only the INITIAL selection. Moving through the list with J and K stays component state and
   * deliberately pushes no URL, so reading forty CVs never leaves forty entries in the back button.
   */
  openCandidateId: string | null;
  /**
   * This tab is ONE CV's own page — the tab a press in the list opens — rather than the list.
   *
   * `rows` then holds that one CV and nothing else, and the screen is the CV, its details and the
   * decisions: no work queue, no list, no seat line, no "next candidate". Every narrowing is
   * skipped, because the reader pressed THIS CV and must get it whatever the list's filters say —
   * the "New CVs" default alone would otherwise hide a CV that was decided last week.
   */
  ownPage: boolean;
  canSendToManagers: boolean;
  canWriteNotes: boolean;
  counts: WorkQueueCounts;
  /**
   * The decision tab the server loaded — Not decided yet, Shortlisted, Sent to manager, Rejected,
   * Hired or All. Names the list when the work queue is "Everyone", because then the tab IS the pile.
   */
  decisionTab: CandidateDecisionTab;
  filteredOut: number;
  /** Every pane folded at once, so the document has the screen. Owned by the page so the filter
      bar above this component folds with it. */
  focus: boolean;
  onToggleFocus: () => void;
  hiringManagers: readonly WorkspaceManager[];
  overdueManagerFeedback: number;
  poolSize: number;
  /** Passed straight through to the send panel's free-typed inputs — see WorkstationReviewHeader. */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  rows: readonly WorkspaceCandidateRow[];
  /** Go to — or leave — seat mode. A navigation, because the seat is in the link. */
  onSelectVacancy: (vacancyId: number | null) => void;
  /** Drop the WhatsApp Applicants search. A navigation too, because the search is in the link. */
  onLeaveWhatsAppSearch: () => void;
  /** The seat being screened, in words. Printed above the list so the pile names itself. */
  seatLabel: string | null;
  vacancies: readonly WorkspaceVacancy[];
  /** The seat the link names, or null for the ordinary queue. */
  vacancyId: number | null;
  vacancyStats: readonly VacancyApplicantStats[];
  /**
   * The search handed over by the WhatsApp Applicants page, in words (the job title, then each
   * filter picked), or null. Printed above the list with the one-press way out.
   */
  whatsAppSearch: string | null;
}) {
  // "EVERYONE" IS WHERE THE LIST OPENS, on every pile, since 2026-09-18. The DECISION TAB above the
  // page is the pile now — "Not decided yet" by default — and the list shows all of it, so the number
  // on the tab is the number of rows under it. Opening on the "New CVs" queue instead would narrow
  // the tab a second time (it leaves out the red-flagged and the rows with no CV) and show a list
  // shorter than the tab that opened it; on any other tab it would show nobody at all. The queues on
  // the rail are still one press away, as piles inside the tab.
  const [queue, setQueue] = useState<ScreeningWorkQueue>("all");
  const [search, setSearch] = useState("");
  // The CV in the link wins on arrival; otherwise the top of the queue, exactly as before. An id
  // that is not in this pile selects nothing and the effect below falls back to the first row.
  const [selectedId, setSelectedId] = useState<string | null>(openCandidateId ?? rows[0]?.id ?? null);
  const [tab, setTab] = useState<IntelligenceTab>("summary");
  const [queueOpen, setQueueOpen] = useState(false);
  // ── WHAT FOLDS, AND WHY FOCUS OVERRIDES RATHER THAN REPLACES ────────────────
  //
  // DESKTOP FOLDING, separate from `queueOpen` above, which is the small-screen drawer. All three
  // panes start open: folding is something a recruiter does when they want the document wide, never
  // a state they have to undo before the screen makes sense.
  //
  // Every pane keeps its OWN flag, and `focus` sits on top of all three as an override. Doing it
  // that way — rather than having focus write into the three flags — means leaving focus restores
  // exactly the arrangement the reader had before, with no effect and no second remembered copy of
  // the state. The owner's need is the whole screen for the document; the way back must cost one
  // press and must not rearrange his workspace as the price.
  const [railOpen, setRailOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  // A CV's own page has no list to start on — it IS the CV.
  const [mobilePane, setMobilePane] = useState<MobilePane>(ownPage ? "cv" : "list");
  const showRail = railOpen && !focus;
  const showList = listOpen && !focus;
  const showPanel = panelOpen && !focus;

  const [loaded, setLoaded] = useState<Record<string, LoadedCandidate>>({});
  const [loadError, setLoadError] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, CandidateStatus>>({});
  /**
   * The star put on a CV in THIS sitting, which outranks the stored one until the page reloads.
   *
   * Its own map rather than a field on `decided`, because a star is not a decision and the two are
   * independent in both directions: a CV can be starred and never judged, judged and never starred,
   * or judged AFTER being starred with the star still standing. Folding them together would mean
   * clearing one cleared the other.
   *
   * A key PRESENT and holding `null` means CLEARED HERE — distinct from an absent key, which means
   * nothing happened in this sitting and the stored value stands. `??` cannot tell those apart, so
   * every read goes through `ratingOf`.
   */
  const [rated, setRated] = useState<Record<string, CandidateRating | null>>({});
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});
  const [sentInSession, setSentInSession] = useState<Record<string, string>>({});
  // The requisition each CV was attached to in this sitting, by code — what the band says instead of
  // the recommendation once the press has landed.
  const [attachedInSession, setAttachedInSession] = useState<Record<string, string>>({});
  /** Archived to the Duplicates shelf in this session - dropped from the list without a reload. */
  const [archived, setArchived] = useState<Record<string, boolean>>({});
  /**
   * Ticked for a bulk decision — a SET, so testing 400 rendered rows against a 200-row selection
   * stays O(1) per row instead of a scan each.
   *
   * Kept even when a row leaves the list under a search or a queue change, so widening the list
   * brings the selection back rather than punishing the reader for looking. What is DECIDED is
   * narrowed to the visible rows at the moment of the press — see `markedVisible`.
   */
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set<string>());
  /**
   * The note this session wrote with each decision, so an undo restores the note as well as the
   * status. `decided` alone cannot: it remembers the verdict and forgets the reason, and a revert
   * that silently blanked a rejection reason would be a quiet data loss.
   */
  const [decidedNote, setDecidedNote] = useState<Record<string, string | null>>({});
  const [undoable, setUndoable] = useState<PendingUndo | null>(null);
  /**
   * Candidates whose CV CONTENTS match the current search, from the server.
   *
   * Null means "not asked". Empty means "asked, and nobody matched" — two different sentences, and
   * collapsing them into one would make a search that found nothing look like a search never run.
   *
   * The searchable CV text is 514 kB against the 683 kB this page already ships, so it stays in the
   * database and is fetched only when somebody asks. The instant box above is untouched.
   */
  const [cvSearch, setCvSearch] = useState<{
    query: string;
    ids: ReadonlySet<string>;
    truncated: boolean;
  } | null>(null);
  const [cvSearching, setCvSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The line to every other screening tab in this browser — see screening-tab-sync.ts. A ref, not
   * state: nothing renders from it, and every write below reports through it once the server has
   * confirmed. Null until mounted, and for good where the browser has no BroadcastChannel.
   */
  const tabs = useRef<ScreeningTabChannel | null>(null);
  const [sendState, setSendState] = useState<SendState>({
    freeAreaName: "",
    freeJobTitle: "",
    managerHrIds: [],
    position: "",
  });

  // ── What is actually in the list ────────────────────────────────────────────
  //
  // Three narrowings, applied in the cheapest order: the precomputed queue membership, then the
  // precomputed vacancy attribution, then the text search. None of them re-derives anything the
  // server already resolved — a list that re-runs the band computation over 555 rows on every
  // keystroke is the page this replaces.
  const visible = useMemo(() => {
    // A CV's own page shows the CV that was pressed, whatever pile the list was on — only an
    // archive made on this page takes it away. See `ownPage`.
    if (ownPage) return rows.filter((row) => !archived[row.id]);
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      // Archived in this session: gone from every pile at once, the way a reload would show it.
      if (archived[row.id]) return false;
      if (queue !== "all" && !row.queues.includes(queue)) return false;
      if (vacancyId !== null && !row.vacancyIds.includes(vacancyId)) return false;
      if (!needle) return true;
      // A CV-content match passes the text filter. A UNION, not a replacement: somebody who searched
      // "pharmacist" should keep the people whose JOB TITLE says pharmacist as well as the ones whose
      // CV body does, and a mode that swapped one set for the other would make results disappear on
      // a press that was meant to add to them.
      if (cvSearch && cvSearch.query === needle && cvSearch.ids.has(row.id)) return true;
      return [
        row.fullName,
        row.appliedForText,
        row.currentRole?.value,
        row.currentEmployer?.value,
        row.locationLabel,
        row.phone,
        row.email,
        row.source,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [archived, cvSearch, ownPage, queue, rows, search, vacancyId]);

  // FROM THE VISIBLE LIST, not from every row the server sent.
  //
  // This searched `rows`, which is the whole server-filtered pool — so a selection the CLIENT
  // narrowing had hidden was still "selected": the list rendered its empty state while the pane
  // beside it showed a candidate, with a live Shortlist / Reject / Send-to-manager header for
  // somebody not in the pile being looked at. `queue` defaults to "new" and the correcting effect
  // below deliberately bails on an empty list, so "Interviews today" — 0 in production, and
  // structurally 0 while no interview carries a scheduled_at — reproduced it in one click.
  //
  // Only the DERIVED value changes. `selectedId` is still remembered, so switching to an empty pile
  // blanks the pane and switching back restores the same CV; the reader never loses their place for
  // having looked. That is also what the comment further down has always claimed this does: "a
  // selection that has dropped out of the list is not a selection".
  const selected = useMemo(
    () => visible.find((row) => row.id === selectedId) ?? null,
    [visible, selectedId],
  );

  // The selection follows the list only when the list has moved out from under it. Re-selecting on
  // every narrowing would throw away the CV a reader has open the moment they type in the search
  // box, which is the opposite of what a search is for.
  const visibleIds = visible.map((row) => row.id).join(",");
  useEffect(() => {
    if (visible.length === 0) return;
    if (selectedId && visible.some((row) => row.id === selectedId)) return;
    setSelectedId(visible[0].id);
    // `visibleIds` is the dependency that matters; `visible` itself is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds]);

  // ── The cache, and the prefetch that makes the queue feel instant ───────────
  const inFlight = useRef<Set<string>>(new Set());
  const load = useCallback(async (candidateId: string | undefined) => {
    if (!candidateId || inFlight.current.has(candidateId)) return;
    inFlight.current.add(candidateId);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}`);
      const data = (await res.json().catch(() => ({}))) as {
        profile?: CandidateProfileShape;
        latestCvExtraction?: StoredCvExtraction | null;
        message?: string;
        screeningQuestions?: ScreeningQuestionLabel[] | null;
      };
      const profile = data.profile;
      if (!res.ok || !profile) throw new Error(data.message ?? "Could not load this candidate.");
      setLoaded((prev) => ({
        ...prev,
        [candidateId]: {
          extraction: data.latestCvExtraction ?? null,
          profile,
          screeningQuestions: data.screeningQuestions ?? null,
        },
      }));
    } catch (caught) {
      setLoadError((prev) => ({
        ...prev,
        [candidateId]: caught instanceof Error ? caught.message : "Could not load this candidate.",
      }));
      // Dropped from the in-flight set so a retry is possible; the cache entry is what stops a
      // second fetch of something that succeeded.
      inFlight.current.delete(candidateId);
    }
  }, []);

  const positionInList = visible.findIndex((row) => row.id === selectedId);
  useEffect(() => {
    if (!selectedId) return;
    void load(selectedId);
    // The NEXT one, while this one is being read. By the time a decision lands, the following CV is
    // usually already in hand — this is most of why the queue feels immediate.
    if (positionInList >= 0) void load(visible[positionInList + 1]?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, positionInList, visibleIds, load]);

  // A SELECTION THAT HAS DROPPED OUT OF THE LIST IS NOT A SELECTION. `selectedId` is remembered
  // state; `selected` is whether that person is still in the result set. Keying the panes off the
  // ROW rather than the remembered id is what keeps the middle and the right pane telling the same
  // story — a filter that empties the list used to leave the CV pane reading "nothing is selected"
  // while the intelligence beside it still showed the last candidate's name, role fit and briefing.
  // That reads as a verdict on whoever the recruiter is looking at now, not as stale state.
  const activeId = selected?.id ?? null;
  const entry = activeId ? loaded[activeId] : undefined;
  const entryError = activeId ? (loadError[activeId] ?? null) : null;
  const cvFile: CvPaneFile | null = useMemo(() => {
    if (!entry) return null;
    const file = primaryCvFile(entry.profile.files);
    return file ? { fileName: file.fileName, id: file.id, mimeType: file.mimeType } : null;
  }, [entry]);

  // "I have read this one." Fired by the document being on screen, never by a button — answering a
  // "too many clicks" problem with one more click reproduces it in a new place. Best-effort in both
  // directions: a failed POST costs re-reading one CV, and must never interrupt a session.
  const markedSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedId || !entry || markedSeen.current.has(selectedId)) return;
    const id = selectedId;
    const timer = setTimeout(() => {
      markedSeen.current.add(id);
      void fetch(`/api/recruitment/candidates/${id}/seen`, { method: "POST" }).catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, [entry, selectedId]);

  const goToNext = useCallback(() => {
    if (positionInList < 0) return;
    const next = visible[positionInList + 1];
    if (!next) return;
    setSelectedId(next.id);
    setActionError(null);
  }, [positionInList, visible]);

  // The other direction. `goToNext` has existed since the decision flow was built, because a
  // decision moves you on; navigating by keyboard needs the way back as well, or `k` is a key that
  // silently does nothing on the first press a reader tries it.
  const goToPrevious = useCallback(() => {
    if (positionInList <= 0) return;
    const previous = visible[positionInList - 1];
    if (!previous) return;
    setSelectedId(previous.id);
    setActionError(null);
  }, [positionInList, visible]);

  const openCandidate = useCallback((id: string) => {
    setSelectedId(id);
    setActionError(null);
    // On a phone the list and the CV are the same square of screen, so choosing somebody has to
    // move you to them; at a desk both are already visible and this is a no-op.
    setMobilePane("cv");
  }, []);

  // A press on a list row. The row's own link opens that CV on its own page in a NEW tab; what is
  // left to do in THIS tab is to remember which one was pressed. So the mark moves to it and nothing
  // else does — no pane switch, no scroll — and the reader comes back to the list with the CV they
  // opened highlighted, exactly where they left it.
  const markOpened = useCallback((id: string) => {
    setSelectedId(id);
    setActionError(null);
  }, []);

  // A CV's own page has no list to move within, so a twin opens on its own page too, in a tab of
  // its own — the same thing a press on it in the list does.
  const openTwin = useCallback(
    (id: string) => {
      window.open(candidateHref(id), "_blank", "noopener");
    },
    [candidateHref],
  );

  const decide = useCallback(
    async (status: CandidateStatus, note: string | null) => {
      // `selected`, not `selectedId`: a decision must never land on a candidate the list in front of
      // the reader is not showing. `selected` is null exactly when that is the case.
      const selectedId = selected?.id;
      if (!selectedId || busy) return;
      // Captured BEFORE the write, because afterwards it is gone: the row on screen holds the old
      // status only until the response lands, and the database has already overwritten it. A
      // session decision outranks the stored one — undoing a second press must restore the first.
      const wasStatus = decided[selectedId] ?? selected?.status ?? null;
      const wasNote = selectedId in decidedNote ? decidedNote[selectedId] : (selected?.statusNote ?? null);
      const name = selected?.fullName ?? "that candidate";
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${selectedId}/status`, {
          body: JSON.stringify({ note: note ?? undefined, status }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data.message ?? "Could not save that decision.");
        }
        setDecided((prev) => ({ ...prev, [selectedId]: status }));
        setDecidedNote((prev) => ({ ...prev, [selectedId]: note }));
        // The list this CV was opened from is still open in another tab, and it must not go on
        // offering a decided CV as "New".
        tabs.current?.post({ id: selectedId, kind: "decided", note, status });
        // No previous status means there is nothing to put back — a row whose stored status is not
        // in the vocabulary at all. Offering an undo that cannot run is worse than offering none.
        setUndoable(
          wasStatus
            ? {
                expiresAt: Date.now() + UNDO_WINDOW_MS,
                label: `${candidateStatusLabels[status]} ${name}`,
                moves: [{ id: selectedId, note: wasNote, status: wasStatus }],
              }
            : null,
        );
        goToNext();
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "Could not save that decision.");
      } finally {
        setBusy(false);
      }
    },
    [busy, decided, decidedNote, goToNext, selected],
  );

  /**
   * Attach the CV being read to an open requisition — the recommendation band's one press (owner,
   * 2026-10-16). The server opens the application, tells the hiring manager and keeps the CV
   * shortlisted; this records the shortlist the same way a Shortlist press would, then moves on, as
   * Shortlist does. No undo window: an application has been opened and a manager told, and taking
   * the status back would not take either of those back.
   */
  const attach = useCallback(
    async (requisitionId: string) => {
      const selectedId = selected?.id;
      if (!selectedId || busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${selectedId}/attach-requisition`, {
          body: JSON.stringify({ requisitionId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          requisitionCode?: string;
          status?: string;
        };
        if (!res.ok) throw new Error(data.message ?? "Could not attach that CV to the requisition.");
        const code = data.requisitionCode ?? "the requisition";
        setAttachedInSession((prev) => ({ ...prev, [selectedId]: code }));
        if (data.status === "shortlisted") {
          const note = `Attached to ${code}.`;
          setDecided((prev) => ({ ...prev, [selectedId]: "shortlisted" }));
          setDecidedNote((prev) => ({ ...prev, [selectedId]: note }));
          tabs.current?.post({ id: selectedId, kind: "decided", note, status: "shortlisted" });
        }
        goToNext();
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "Could not attach that CV to the requisition.");
      } finally {
        setBusy(false);
      }
    },
    [busy, goToNext, selected],
  );

  /**
   * The star on a row as the reader currently sees it: this sitting's, or the stored one.
   *
   * `id in rated` rather than `rated[id] ?? row.rating`, because taking a star OFF stores `null` and
   * `??` would fall straight through it back to the value on the record — the star would reappear
   * the instant it was cleared.
   */
  const ratingOf = useCallback(
    (row: { id: string; rating: CandidateRating | null }): CandidateRating | null =>
      row.id in rated ? (rated[row.id] ?? null) : row.rating,
    [rated],
  );

  /**
   * Star the CV being read 1, 2 or 3 — or take the star off.
   *
   * DELIBERATELY NOT A DECISION, and it behaves like none: it writes no status, offers no undo
   * window, and does not advance to the next candidate. Advancing would be actively wrong — rating
   * is what you do WHILE reading, often revised halfway down the document — and a control that
   * moved you on would make the second thought impossible.
   *
   * It also does not take the `busy` lock the decision uses. Starring is exclusive with nothing: it
   * writes one column on one row, and holding the whole bar for it would mean a star pressed a
   * moment before Shortlist silently swallowed the Shortlist.
   */
  const rate = useCallback(
    async (next: CandidateRating | null) => {
      const row = selected;
      if (!row) return;
      const was = row.id in rated ? (rated[row.id] ?? null) : row.rating;
      // Drawn IMMEDIATELY, then put back if the write fails. A star is a glance-speed act and the
      // round trip here is the same slow one every other control on this page pays. Rolling back on
      // failure is what keeps the optimism honest.
      setRated((prev) => ({ ...prev, [row.id]: next }));
      setActionError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${row.id}/rating`, {
          body: JSON.stringify({ rating: next }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const data = (await res.json().catch(() => ({}))) as {
          candidate?: { rating?: unknown };
          message?: string;
        };
        if (!res.ok) throw new Error(data.message ?? "Could not save that star.");
        // Trust the row that came back over the one that was asked for. They agree today; if the
        // ladder ever widens they might not, and the screen must show what was actually stored.
        const stored = parseCandidateRating(data.candidate?.rating);
        setRated((prev) => ({ ...prev, [row.id]: stored }));
        tabs.current?.post({ id: row.id, kind: "rated", rating: stored });
      } catch (caught) {
        setRated((prev) => ({ ...prev, [row.id]: was }));
        setActionError(caught instanceof Error ? caught.message : "Could not save that star.");
      }
    },
    [rated, selected],
  );

  /**
   * The ticked rows that are ACTUALLY IN THE LIST in front of the reader.
   *
   * Marks survive a narrowing, so widening the list again brings the selection back rather than
   * punishing the reader for looking. But a decision must never land on a candidate they cannot
   * see — the same rule `selected` follows, for the same reason. Every count printed beside a bulk
   * button is measured here, so what the button says is what the button does.
   */
  const markedVisible = useMemo(() => visible.filter((row) => marked.has(row.id)), [marked, visible]);

  /**
   * Ask the server which CVs actually CONTAIN the search term.
   *
   * Explicit rather than automatic. Typing is instant and local; this is a round trip over half a
   * megabyte of extracted text, and firing it on every keystroke would make the fast path feel slow
   * to pay for a search most sessions never run.
   *
   * The query is stamped into the result, and `visible` only honours a result whose query still
   * matches what is in the box — so editing the search term after a CV search silently retires it
   * rather than leaving stale matches in the list attached to words nobody typed.
   */
  const searchCvContents = useCallback(async () => {
    const needle = search.trim().toLowerCase();
    if (needle.length < 2 || cvSearching) return;
    setCvSearching(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/cv-search?q=${encodeURIComponent(needle)}`);
      const data = (await res.json().catch(() => ({}))) as {
        hits?: Array<{ candidateId: string }>;
        message?: string;
        truncated?: boolean;
      };
      if (!res.ok) throw new Error(data.message ?? "Could not search CV contents.");
      setCvSearch({
        ids: new Set((data.hits ?? []).map((hit) => hit.candidateId)),
        query: needle,
        truncated: data.truncated === true,
      });
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not search CV contents.");
    } finally {
      setCvSearching(false);
    }
  }, [cvSearching, search]);

  const toggleMark = useCallback((id: string) => {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearMarks = useCallback(() => setMarked(new Set<string>()), []);

  /**
   * Tick every row in the list, up to the cap.
   *
   * Capped rather than refused: a reader who has narrowed to 400 rows and wants them all is better
   * served by getting the first 200 and being told so than by a button that does nothing. The number
   * is the same constant the route and the database function enforce.
   */
  const markAllVisible = useCallback(() => {
    setMarked(new Set(visible.slice(0, BULK_DECISION_MAX).map((row) => row.id)));
  }, [visible]);

  /**
   * One verdict across every ticked candidate — a single request, not one per row.
   *
   * The server runs it as one transaction, so it cannot half-apply. That matters more than it looks:
   * a client-side loop that dies partway leaves some candidates decided while the screen reports a
   * failure, and the recruiter then re-decides rows that already moved.
   *
   * The response carries each candidate's PREVIOUS status. That is the only place it still exists
   * once the write has happened, and it is exactly what the undo strip needs.
   */
  const bulkDecide = useCallback(
    async (status: BulkDecidableStatus) => {
      const rows = markedVisible;
      if (rows.length === 0 || busy) return;
      const wasNoteById = new Map(
        rows.map((row) => [row.id, row.id in decidedNote ? decidedNote[row.id] : row.statusNote] as const),
      );
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch("/api/recruitment/candidates/bulk-status", {
          body: JSON.stringify({ ids: rows.map((row) => row.id), status }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          missing?: string[];
          moved?: Array<{ fromStatus: string | null; id: string }>;
        };
        if (!res.ok) throw new Error(data.message ?? "Could not save that decision.");

        const moved = data.moved ?? [];
        setDecided((prev) => {
          const next = { ...prev };
          for (const row of moved) next[row.id] = status;
          return next;
        });
        setDecidedNote((prev) => {
          const next = { ...prev };
          for (const row of moved) next[row.id] = null;
          return next;
        });
        // Any of these may be open on its own page in another tab.
        for (const row of moved) tabs.current?.post({ id: row.id, kind: "decided", note: null, status });

        // Only rows whose previous status is a real one can be put back. The rest are dropped from
        // the undo rather than failing it, so one unrecognised legacy row cannot cost the other 49.
        const restorable = moved
          .map((row) => ({
            id: row.id,
            note: wasNoteById.get(row.id) ?? null,
            status: (row.fromStatus ?? "") as CandidateStatus,
          }))
          .filter((row) => Boolean(row.status));

        setUndoable(
          restorable.length > 0
            ? {
                expiresAt: Date.now() + UNDO_WINDOW_MS,
                label: `${candidateStatusLabels[status]} ${moved.length} ${moved.length === 1 ? "candidate" : "candidates"}`,
                moves: restorable,
              }
            : null,
        );

        clearMarks();
        // "50 selected, 47 moved" is the truth and "done" is not. A missing row is a stale tab, not
        // a failure, so it is reported rather than thrown.
        const missing = data.missing?.length ?? 0;
        if (missing > 0) {
          setActionError(
            `${moved.length} decided. ${missing} could not be found — reload the page to see the current list.`,
          );
        }
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "Could not save that decision.");
      } finally {
        setBusy(false);
      }
    },
    [busy, clearMarks, decidedNote, markedVisible],
  );

  /**
   * Take the last decision back.
   *
   * Its own route, because a revert restores a DIFFERENT status per candidate and is deliberately
   * not bound by the two verdicts a bulk decision may set — putting somebody back to "sent to
   * manager" tells no lie, since they really were sent. The reversal is written to the history
   * rather than erasing the original, so the record shows a change of mind instead of a gap.
   */
  const undoLast = useCallback(async () => {
    const pending = undoable;
    if (!pending || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/recruitment/candidates/revert-status", {
        body: JSON.stringify({ moves: pending.moves }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        restored?: Array<{ id: string; status: CandidateStatus }>;
      };
      if (!res.ok) throw new Error(data.message ?? "Could not undo that.");

      const restored = data.restored ?? [];
      const noteById = new Map(pending.moves.map((move) => [move.id, move.note] as const));
      setDecided((prev) => {
        const next = { ...prev };
        for (const row of restored) next[row.id] = row.status;
        return next;
      });
      setDecidedNote((prev) => {
        const next = { ...prev };
        for (const row of restored) next[row.id] = noteById.get(row.id) ?? null;
        return next;
      });
      // An undo is a decision too, as far as the other tab can tell — it must see the verdict go.
      for (const row of restored) {
        tabs.current?.post({ id: row.id, kind: "decided", note: noteById.get(row.id) ?? null, status: row.status });
      }
      setUndoable(null);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not undo that.");
    } finally {
      setBusy(false);
    }
  }, [busy, undoable]);

  /**
   * The keyboard, for the reader who is doing this two hundred times.
   *
   * `J`/`K` and the arrows move; `S` shortlists; `U` takes the last decision back. They extend the
   * `F`-for-full-width handler that already lives in workstation-page-client and follow its rule
   * exactly: ignored while typing, so an "s" in a search term does not decide the CV underneath.
   *
   * REJECT IS DELIBERATELY NOT BOUND. It is the one verdict this screen asks a reason for — the
   * button opens a panel rather than deciding — and a single keystroke that skipped that panel would
   * quietly turn every rejection into an unexplained one. Shortlisting asks for nothing today, which
   * is why it can be a key. Rejecting many at once has its own control, with the same note field.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      // A CV's own page has no queue to move through, so these keys are left to the browser there:
      // the arrows scroll the page the reader is on instead of doing nothing at all.
      if (!ownPage && (key === "j" || event.key === "ArrowDown")) {
        event.preventDefault();
        goToNext();
        return;
      }
      if (!ownPage && (key === "k" || event.key === "ArrowUp")) {
        event.preventDefault();
        goToPrevious();
        return;
      }
      if (key === "u" && undoable) {
        event.preventDefault();
        void undoLast();
        return;
      }
      if (key === "s" && canDecide && selected) {
        event.preventDefault();
        void decide("shortlisted", null);
        return;
      }
      // ── THE STARS, ON THE NUMBER ROW ────────────────────────────────────────
      // The one place here where the key IS the value, which is why these are bound and Reject is
      // not: there is nothing to explain and nothing to confirm, and a mis-pressed 2 is undone by
      // pressing the right number or 0. `0` CLEARS — it is the key next to them on the same row,
      // never a rating of zero, which the ladder does not have.
      if (canDecide && selected && (key === "0" || key === "1" || key === "2" || key === "3")) {
        event.preventDefault();
        void rate(key === "0" ? null : (Number(key) as CandidateRating));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canDecide, decide, goToNext, goToPrevious, ownPage, rate, selected, undoLast, undoable]);

  // The window closes on its own. A timer rather than a rendered countdown: nothing here needs to
  // re-render ten times a second, and a ticking number beside a live control invites a race.
  useEffect(() => {
    if (!undoable) return;
    const remaining = undoable.expiresAt - Date.now();
    if (remaining <= 0) {
      setUndoable(null);
      return;
    }
    const timer = setTimeout(() => setUndoable(null), remaining);
    return () => clearTimeout(timer);
  }, [undoable]);

  /**
   * Every (candidate, manager) this session has already confirmed a send for.
   *
   * A ref, not state: nothing renders from it, and it must not be reset by a re-render mid-send. It
   * lives for the life of the page, so a genuine re-send is a reload — deliberately, because the
   * accident it prevents (a manager notified twice about one CV) is not recallable and the case it
   * blocks is rare.
   */
  const sentPairs = useRef<Set<string>>(new Set());

  /**
   * Send this CV to everyone chosen — one request per manager, in sequence.
   *
   * The route notifies ONE manager and stamps the candidate for that manager, which is the right
   * unit: each recipient gets their own notification, audit row and seat stamp. Sequential rather
   * than parallel because these writes land in the notification outbox and re-write the same
   * candidate row, and firing five at once is how two of them race over one stamp.
   *
   * PARTIAL SUCCESS IS REPORTED AS PARTIAL. Three sends where the second fails must not read as
   * "sent" and must not read as "failed" — the second lie would have a recruiter re-send to the two
   * managers who already have it.
   *
   * AND A SECOND PRESS DOES NOT SEND IT TWICE. The only guard used to be `busy`, which is false again
   * the moment the last request returns — and nothing cleared the picker, so the panel came back
   * enabled with the same managers still selected. One more click was a second REAL notification:
   * the alert's idempotency key is built from the send timestamp (candidateAlertIdempotencyKey), so
   * it does not dedupe, and a manager was told twice about the same CV.
   *
   * Guarded per (candidate, manager) rather than by clearing the picker, because the picker holding
   * its selection across candidates is the batch workflow — screening a pile for one seat and
   * sending each one as you go. Clearing it would have fixed the double press by breaking that.
   */
  const send = useCallback(async () => {
    // Same rule as `decide`: never send a CV the visible list is not showing.
    const selectedId = selected?.id;
    if (!selectedId || busy || sendState.managerHrIds.length === 0) return;
    // Everyone selected has already had this CV in this session — the shape of a double press.
    const targets = sendState.managerHrIds.filter((hrId) => !sentPairs.current.has(`${selectedId}:${hrId}`));
    if (targets.length === 0) {
      const names = sendState.managerHrIds
        .map((hrId) => hiringManagers.find((manager) => manager.hrId === hrId)?.name ?? "that manager")
        .join(", ");
      setActionError(`This CV has already gone to ${names}. Reload the page to send it again.`);
      return;
    }
    setBusy(true);
    setActionError(null);
    // A picked vacancy sends only its ID — the server reads the seat back and stamps that, so the
    // words on this screen can never disagree with the words in the folder. A typed one sends the
    // words, and the server cleans them. NO_POSITION is a deliberate "no seat", not an omission.
    const position =
      sendState.position === FREE_POSITION
        ? { positionAreaName: sendState.freeAreaName, positionJobTitle: sendState.freeJobTitle }
        : sendState.position && sendState.position !== NO_POSITION
          ? { vacancyId: Number(sendState.position) }
          : {};
    const sent: string[] = [];
    const sentTo: string[] = [];
    const failed: string[] = [];
    for (const managerHrId of targets) {
      const localName = hiringManagers.find((manager) => manager.hrId === managerHrId)?.name ?? "that manager";
      try {
        const res = await fetch(`/api/recruitment/candidates/${selectedId}/notify-manager`, {
          body: JSON.stringify({ managerHrId, ...position }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = (await res.json().catch(() => ({}))) as { result?: { managerName?: string }; message?: string };
        if (!res.ok) throw new Error(data.message ?? `Could not send this CV to ${localName}.`);
        // Recorded only on a CONFIRMED send. A failure must stay retryable — marking the pair here
        // regardless would turn one network blip into a CV nobody can ever send to that manager.
        sentPairs.current.add(`${selectedId}:${managerHrId}`);
        sentTo.push(managerHrId);
        // The name the SERVER confirmed — it is the thing that knows who was actually told, and no
        // raw HR_ID ever reaches a person.
        sent.push(data.result?.managerName ?? localName);
      } catch {
        failed.push(localName);
      }
    }
    if (sent.length > 0) {
      setSentInSession((prev) => ({ ...prev, [selectedId]: sent.join(", ") }));
      // The OTHER tab's guard has to hear this too. It has this same CV and very likely this same
      // manager still picked, and without the report one press there is a second real notification
      // — the exact accident the guard above exists to prevent, arriving by the tab it cannot see.
      tabs.current?.post({ id: selectedId, kind: "sent", managerHrIds: sentTo, names: sent.join(", ") });
    }
    if (failed.length > 0) setActionError(`Could not send this CV to ${failed.join(", ")}.`);
    setBusy(false);
  }, [busy, hiringManagers, selected, sendState]);

  // ── WHAT THE OTHER TABS DID ─────────────────────────────────────────────────
  //
  // A CV pressed in the list is read and decided in a tab of its own (screening-tab-sync.ts). What
  // that tab reports is recorded here exactly as if it had been done here — the same maps the
  // optimistic writes above fill — so the row keeps its place and wears the verdict, and nothing
  // moves under the reader. Archiving is deliberately NOT reported: it takes a row OUT of the list,
  // and a list that shrinks while the reader is away snaps back to the top, which is the lost place
  // this whole change exists to remove. An archived CV leaves the list on the next load.
  useEffect(() => {
    const receive = (message: ScreeningTabMessage) => {
      if (message.kind === "decided") {
        setDecided((prev) => ({ ...prev, [message.id]: message.status }));
        setDecidedNote((prev) => ({ ...prev, [message.id]: message.note }));
      } else if (message.kind === "rated") {
        setRated((prev) => ({ ...prev, [message.id]: message.rating }));
      } else if (message.kind === "sent") {
        for (const hrId of message.managerHrIds) sentPairs.current.add(`${message.id}:${hrId}`);
        setSentInSession((prev) => ({ ...prev, [message.id]: message.names }));
      } else {
        setNoteCounts((prev) => ({ ...prev, [message.id]: message.count }));
      }
    };
    const channel = openScreeningTabChannel(receive);
    tabs.current = channel;
    return () => {
      channel?.close();
      tabs.current = null;
    };
  }, []);

  /**
   * Put this record on the Duplicates shelf.
   *
   * A SHELF, not a delete - fileCandidateToFolder writes folder_kind/key/filed_at and the pool
   * filter drops it; every byte of the candidate, its files and its history stays, and it can be put
   * back from the folder. That is the whole reason a one-click action is defensible on evidence this
   * weak: the worst outcome of a wrong press is a CV in the wrong folder, not a lost applicant.
   *
   * Optimistic on the LIST only. The row is dropped locally so the reader moves on, and the server's
   * own counts are refreshed on the next load - the same rule the decision path already follows.
   */
  const archiveDuplicate = useCallback(
    async (candidateId: string) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${candidateId}/folder`, {
          body: JSON.stringify({ key: DUPLICATE_FOLDER_KEY, kind: DUPLICATE_FOLDER_KIND }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data.message ?? "Could not archive this CV.");
        }
        setArchived((prev) => ({ ...prev, [candidateId]: true }));
        goToNext();
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "Could not archive this CV.");
      } finally {
        setBusy(false);
      }
    },
    [busy, goToNext],
  );

  /**
   * Write ONE reader finding onto the candidate record.
   *
   * The reason this exists at all: `cv-auto-apply.ts` writes a finding unattended only at high
   * confidence, and that gate is correct. But for a candidate created by automatic intake there was
   * no screen where a human ever saw the low-confidence proposals, so they waited for a review that
   * never came — 215 candidates carrying a good yearsExperience against a null column on 2026-09-05,
   * and 120 carrying a nationalId on a pool holding four. This puts them in front of the one person
   * already reading the CV.
   *
   * ONE FIELD PER PRESS, deliberately. These are the readings the extractor itself hedged on, so a
   * person confirms each against the document in front of them; a bulk "apply everything" would be
   * the unattended write the confidence gate exists to prevent, wearing a button.
   *
   * The route is schema-driven (`listWritableCvFields`), so no allow-list here can drift from the
   * field registry — and `updateCandidate` recomputes `national_id_norm` on write, which is what
   * makes an accepted national id immediately usable by the locked identity rule.
   */
  /**
   * Write ONE reader finding onto the record.
   *
   * ONE FIELD PER PRESS, deliberately, and a save-all button was built and removed on
   * 2026-09-05 rather than shipped. These are the readings the extractor itself hedged on —
   * `cv-auto-apply` declined them precisely because it is not confident — so a control that
   * applies several at once is the unattended write the confidence gate exists to prevent,
   * wearing a button. `nationalId` makes it sharper than a style preference: a wrong one feeds
   * the locked identity rule in candidate-matching.ts and can make two different people look
   * like one.
   *
   * Making the 271 candidates who have findings REACHABLE is the fix — the row badge and the
   * pile — not making it cheaper to accept a reading without looking at it.
   */
  const acceptReaderFinding = useCallback(
    async (fieldKey: string, value: ExtractedCvValue) => {
      const candidateId = selected?.id;
      if (!candidateId || busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${candidateId}`, {
          body: JSON.stringify({ [fieldKey]: value }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const data = (await res.json().catch(() => ({}))) as { candidate?: Candidate; message?: string };
        if (!res.ok) throw new Error(data.message ?? "Could not save that reading.");
        // Replace the cached record with the SERVER's, so the row stops offering a finding that is
        // now saved. Trusting a locally patched copy would leave the button on screen until reload
        // whenever the server normalised the value differently from the reader's raw proposal.
        const saved = data.candidate;
        if (saved) {
          setLoaded((prev) => {
            const entry = prev[candidateId];
            if (!entry) return prev;
            return { ...prev, [candidateId]: { ...entry, profile: { ...entry.profile, candidate: saved } } };
          });
        }
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "Could not save that reading.");
      } finally {
        setBusy(false);
      }
    },
    [busy, selected],
  );

  const suggestedVacancyIds = selected?.vacancyIds ?? [];

  // On "Everyone" the decision tab IS the pile, so the list is named after it — "Rejected", not
  // "Everyone", when the reader is on the Rejected tab. The "All" tab keeps the queue's own name.
  const listTitle =
    queue === "all" && decisionTab !== "all" ? candidateDecisionTabLabels[decisionTab] : screeningWorkQueueLabels[queue];
  const chosenVacancy = vacancyId === null ? null : vacancies.find((vacancy) => vacancy.id === vacancyId) ?? null;
  // The phone's pane switch. A CV's own page has no list pane, so it offers none.
  const mobilePanes: readonly MobilePane[] = ownPage ? ["cv", "panel"] : ["list", "cv", "panel"];

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 w-full overflow-hidden",
        // THE TRAY (2026-10-19, the owner's "Full polish there too"). Every pane is a card resting on
        // a recessed ground, 8px apart, so the cockpit reads as four objects rather than one grid of
        // hairlines. In focus the tray gives its padding back: the whole screen is the document.
        focus ? "bg-white" : cn("gap-2 bg-phx-paper-2 p-2", adminRecessedDepthClassName),
        // ONE KEYBOARD-FOCUS TREATMENT for the whole workstation, declared once here rather than on
        // each of the ~40 controls below it. It is an INSET outline, so a focused row at the very
        // edge of a pane is not clipped by the pane's own overflow — which is exactly where the
        // list, the queue and the tab strip all put their controls.
        "[&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-[-2px] [&_:focus-visible]:outline-phx-accent",
      )}
    >
      {/* ── AREA 1 ─────────────────────────────────────────────────────────────────────────────
          Not on a CV's own page: the work queue picks piles, and that page is one CV. The list it
          was opened from is still open in the other tab, with its queue exactly as it was. */}
      {ownPage ? null : (
        <>
          <div
            className={cn(
              "z-20 w-[212px] shrink-0",
              queueOpen && !focus ? "absolute inset-y-0 left-0 flex shadow-[6px_0_18px_rgba(15,23,42,0.14)]" : "hidden",
              showRail ? "xl:static xl:flex xl:shadow-none" : "xl:hidden",
            )}
          >
            <WorkstationQueuePanel
              counts={counts}
              onCollapse={() => setRailOpen(false)}
              onSelectQueue={(next) => {
                setQueue(next);
                setQueueOpen(false);
                setMobilePane("list");
              }}
              onSelectVacancy={(next) => {
                // A LINK, not a piece of state: picking a seat changes what the SERVER loads, because
                // for that seat the filed CVs are read back in and the email applicants are matched.
                onSelectVacancy(next);
                setQueue("all");
                setQueueOpen(false);
                setMobilePane("list");
              }}
              overdueManagerFeedback={overdueManagerFeedback}
              queue={queue}
              vacancies={vacancies}
              vacancyId={vacancyId}
              vacancyStats={vacancyStats}
            />
          </div>
          {/* What the folded rail leaves behind. It replaces the pane in the flex row rather than
              overlaying it, so folding actually GIVES the width to the CV — which is the only reason
              somebody folds it. */}
          {!showRail && !focus ? <PaneSpine label="Work queue" onOpen={() => setRailOpen(true)} side="left" /> : null}
          {queueOpen && !focus ? (
            <button
              aria-label="Close the work queue"
              className="absolute inset-0 z-10 bg-phx-ink/20 xl:hidden"
              onClick={() => setQueueOpen(false)}
              type="button"
            />
          ) : null}
        </>
      )}

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", focus ? null : "gap-2")}>
        {/* The one bar that exists only on smaller screens: the queue drawer's handle, and the
            pane switcher. At a workstation neither is needed and neither renders — and in focus it
            goes as well, because "the whole screen for the CV" has to mean the same thing on a
            phone as it does on a laptop. The way back out lives on the strip above the document.
            A small card of its own on the tray, like the panes under it. */}
        <div
          className={cn(
            `shrink-0 items-center gap-1.5 border border-phx-line bg-white px-3 py-1.5 xl:hidden ${adminSoftDepthClassName}`,
            // A SEGMENTED CONTROL, not three loose buttons. The three panes are one choice, so they
            // are drawn as one object with a shared frame — which is also what stops the row from
            // reading as five competing controls on a 375px phone.
            focus ? "hidden" : "flex",
            // A CV's own page has no queue to open, so all that is left here is the CV / Details
            // switch — and that is a phone's control. At a laptop both are on screen already, and
            // the bar would be an empty strip.
            ownPage && "lg:hidden",
          )}
        >
          {ownPage ? null : (
            <Action
              onClick={() => setQueueOpen((open) => !open)}
              title={queueOpen ? "Close the work queue" : "Open the work queue"}
              tone="ghost"
            >
              {queueOpen ? (
                <X aria-hidden className="h-3.5 w-3.5" />
              ) : (
                <PanelLeft aria-hidden className="h-3.5 w-3.5" />
              )}
              Queue
            </Action>
          )}
          <span className="min-w-0 flex-1 break-words text-[12px] font-semibold leading-snug text-phx-ink-soft">
            {ownPage ? (selected?.fullName ?? null) : (
              <>
                {listTitle}
                {chosenVacancy ? ` · ${chosenVacancy.jobTitle}` : ""}
              </>
            )}
          </span>
          {/* The house segment: a recessed tray, the chosen pane lifted onto white with the accent
              rule under it — the same object as the recruitment kit's tab bar, at a phone's size. */}
          <span
            className={cn("flex shrink-0 gap-0.5 border border-phx-line bg-phx-surface-2 p-0.5 lg:hidden", adminRecessedDepthClassName)}
          >
            {mobilePanes.map((pane) => (
              <button
                aria-pressed={mobilePane === pane}
                className={cn(
                  "relative px-2.5 py-1.5 text-[12px] font-bold leading-none transition-colors",
                  mobilePane === pane
                    ? cn("bg-white text-phx-accent-press after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:bg-phx-accent", adminChipDepthClassName)
                    : "text-phx-ink-soft hover:bg-white/70 hover:text-phx-ink",
                )}
                key={pane}
                onClick={() => setMobilePane(pane)}
                type="button"
              >
                {pane === "list" ? "List" : pane === "cv" ? "CV" : "Details"}
              </button>
            ))}
          </span>
        </div>

        {/* ── THE BANDS, AS ONE STACK ────────────────────────────────────────────────────────────
            Every band below is a full-width line the page says to the reader, and on the tray they
            sit together in ONE soft card — never five loose strips floating between the panes.
            `empty:hidden` is what keeps it honest: with no band showing the card has no children at
            all, so it draws nothing and costs no gap. The bands keep their own bottom rule, so the
            card has no bottom edge of its own. */}
        <div
          className={`flex shrink-0 flex-col overflow-hidden border border-b-0 border-phx-line bg-white empty:hidden ${adminSoftDepthClassName}`}
        >
          {/* ── The undo offer ────────────────────────────────────────────────
              Across the full width, above both panes, because it belongs to the DECISION and not to
              whichever CV happens to be open — after a bulk verdict the row it refers to may not be
              on screen at all. It wraps rather than scrolling, per the fits-the-screen rule. */}
          {undoable ? (
            <Band
              footnote="Or press U. This offer goes in a few seconds; after that the decision can still be changed the ordinary way, with a reason."
              tone="accent"
            >
              <BandSays>{undoable.label}.</BandSays>
              <Action disabled={busy} onClick={() => void undoLast()} tone="quiet">
                Undo
              </Action>
            </Band>
          ) : null}

          {/* ── Search inside the CVs ─────────────────────────────────────────
              Offered only once something is typed, and only while the instant search is narrower than
              the CV search could be. Wraps rather than scrolling, per the fits-the-screen rule. */}
          {search.trim().length >= 2 ? (
            cvSearch && cvSearch.query === search.trim().toLowerCase() ? (
              <Band
                footnote={
                  cvSearch.truncated ? (
                    // NEVER a silent cut. A list stopped at the cap reads as a complete answer, and a
                    // recruiter who believes they have seen every match stops looking.
                    <>
                      More than {cvSearch.ids.size} CVs match. Add another word to narrow it — every
                      word must appear, so &ldquo;{search.trim()} cairo&rdquo; is a smaller list.
                    </>
                  ) : null
                }
              >
                <BandSays>
                  {cvSearch.ids.size} {cvSearch.ids.size === 1 ? "CV mentions" : "CVs mention"}
                  {" "}&ldquo;{search.trim()}&rdquo;
                </BandSays>
                <Action onClick={() => setCvSearch(null)} tone="ghost">
                  Clear
                </Action>
              </Band>
            ) : (
              <Band footnote="The box above searches names, roles and numbers. This reads what the CV itself says — skills, employers, universities.">
                <Action disabled={cvSearching} onClick={() => void searchCvContents()} tone="quiet">
                  {cvSearching ? "Searching CVs..." : `Search inside CVs for "${search.trim()}"`}
                </Action>
              </Band>
            )
          ) : null}

          {/* ── SCREENING ONE VACANT SEAT ───────────────────────────────────────────────────────────
              The way out is one press, and it is the whole reason this line still exists after the
              page header started naming the seat itself. The header says WHICH seat and what is in the
              pile; this says how to stop looking at only that seat — and it has to live here rather
              than up there because leaving seat mode also puts the work queue back on "Everyone", which
              is state the workstation owns.

              Wraps at 375px rather than scrolling sideways; no ellipsis, no id. Not on a CV's own page,
              which is one CV and not a pile — leaving seat mode there would change nothing on it. */}
          {seatLabel && !ownPage ? (
            <Band tone="accent">
              <BandSays>One vacant seat: {seatLabel}</BandSays>
              <Action
                onClick={() => {
                  onSelectVacancy(null);
                  setQueue("all");
                }}
                tone="quiet"
              >
                Show everyone
              </Action>
            </Band>
          ) : null}

          {/* ── A SEARCH FROM THE WHATSAPP APPLICANTS PAGE ──────────────────────────────────────────
              Named here as well as in the page header, because full bleed hides that header and this
              line is then the only thing saying why the pile is short. The way out is one press, as it
              is for a seat. Wraps at 375px rather than scrolling sideways; no ellipsis, no code. */}
          {whatsAppSearch && !ownPage ? (
            <Band tone="accent">
              <BandSays>WhatsApp applicants: {whatsAppSearch}</BandSays>
              <Action
                onClick={() => {
                  onLeaveWhatsAppSearch();
                  setQueue("all");
                }}
                tone="quiet"
              >
                Show everyone
              </Action>
            </Band>
          ) : null}

          {/* ── The bulk verdict ──────────────────────────────────────────────
              Only once something is ticked. A permanently visible bar advertising an action nobody
              has set up yet is furniture, and the row tick-boxes are how it is reached. */}
          {canDecide && markedVisible.length > 0 ? (
            <Band
              footnote={
                <>
                  One decision, applied together — it either moves all of them or none. Every move is
                  written to each candidate&rsquo;s history, and can be taken back for a few seconds
                  afterwards.
                </>
              }
            >
              <BandSays>{markedVisible.length} selected</BandSays>
              {bulkDecidableStatuses.map((status) => (
                <Action disabled={busy} key={status} onClick={() => void bulkDecide(status)} tone="quiet">
                  {candidateStatusLabels[status]} all {markedVisible.length}
                </Action>
              ))}
              {visible.length > markedVisible.length ? (
                <Action onClick={markAllVisible} tone="ghost">
                  Select all {Math.min(visible.length, BULK_DECISION_MAX)} in this list
                </Action>
              ) : null}
              <Action onClick={clearMarks} tone="ghost">
                Clear
              </Action>
            </Band>
          ) : null}
        </div>

        <div className={cn("flex min-h-0 flex-1", focus ? null : "gap-2")}>
          {/* ── AREA 2 ─────────────────────────────────────────────────────────────────────────
              Not on a CV's own page — that page is the tab a press in THIS list opens. */}
          {ownPage ? null : (
            <>
              <div
                className={cn(
                  "min-h-0 w-full shrink-0 lg:flex lg:w-[288px]",
                  mobilePane === "list" && !focus ? "flex" : "hidden",
                  showList ? undefined : "lg:hidden",
                )}
              >
                <WorkstationCandidateList
                  candidateHref={candidateHref}
                  decidedById={decided}
                  emptyLabel={emptyLabelFor(queue, chosenVacancy?.jobTitle ?? null, search, poolSize, filteredOut)}
                  markedIds={marked}
                  onCollapse={() => setListOpen(false)}
                  onSelect={markOpened}
                  onToggleMark={canDecide ? toggleMark : null}
                  onSearchChange={setSearch}
                  ratedById={rated}
                  rows={visible}
                  search={search}
                  selectedId={selectedId}
                  title={listTitle}
                  // Of the TAB's pile — the rows the server sent — so "12 of 28" on the Rejected tab
                  // reads against the 28 that tab reported, not against every CV in the pool.
                  totalLabel={`${visible.length} of ${rows.length}`}
                />
              </div>
              {!showList && !focus ? (
                <PaneSpine label="Candidates" onOpen={() => setListOpen(true)} side="left" />
              ) : null}
            </>
          )}

          {/* ── AREA 3 + the CV ──────────────────────────────────────────────── */}
          {/* THE FOCAL COLUMN. The one place on the page that carries the PANEL depth — the candidate
              under review and their CV are what this whole screen is for, so they are the two
              surfaces that sit highest off the tray; everything around them is a soft card. In
              focus both give their frame back and the document runs edge to edge. */}
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col lg:flex",
              mobilePane === "cv" || focus ? "flex" : "hidden",
              focus ? null : "gap-2",
            )}
          >
            {selected ? (
              <>
                {/* Who, what can be done, and the duplicate line — ONE card, with the accent rule
                    along its top edge marking it as the subject of the page. */}
                <div
                  className={
                    focus
                      ? "shrink-0"
                      : `relative shrink-0 border border-phx-line bg-white ${adminPanelDepthClassName}`
                  }
                >
                  {focus ? null : (
                    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-0.5 bg-phx-accent" />
                  )}
                  <WorkstationReviewHeader
                    attachedTo={attachedInSession[selected.id] ?? null}
                    busy={busy}
                    canDecide={canDecide}
                    canReply={canReply}
                    canSend={canSendToManagers}
                    decided={decided[selected.id] ?? null}
                    error={actionError}
                    focus={focus}
                    hiringManagers={hiringManagers}
                    canRate={canDecide}
                    onAttach={(requisitionId) => void attach(requisitionId)}
                    onDecide={decide}
                    onNext={ownPage ? null : goToNext}
                    onRate={rate}
                    rating={ratingOf(selected)}
                    onSend={() => void send()}
                    onSendStateChange={setSendState}
                    onToggleFocus={onToggleFocus}
                    positionSuggestions={positionSuggestions}
                    row={selected}
                    sendState={sendState}
                    sentConfirmation={sentInSession[selected.id] ?? null}
                    suggestedVacancyIds={suggestedVacancyIds}
                    vacancies={vacancies}
                  />
                  {selected.duplicateCount > 1 ? (
                    <DuplicateBanner
                      archiving={busy}
                      onArchive={(id) => void archiveDuplicate(id)}
                      onOpen={ownPage ? openTwin : openCandidate}
                      row={selected}
                    />
                  ) : null}
                </div>
                <div
                  className={
                    focus
                      ? "min-h-0 flex-1"
                      : `min-h-0 flex-1 overflow-hidden border border-phx-line bg-white ${adminPanelDepthClassName}`
                  }
                >
                  <WorkstationCvPane
                    attachedCount={entry?.profile.files.length ?? 0}
                    error={entryError}
                    file={cvFile}
                    loading={!entry && !entryError}
                    notACv={selected.notACv || entry?.extraction?.isCv === false}
                  />
                </div>
              </>
            ) : ownPage ? (
              // The page for ONE CV with no CV on it. Said plainly, because "pick somebody from the
              // list" points at a list this page does not have.
              <div
                className={`flex min-h-0 flex-1 items-center justify-center border border-phx-line bg-white ${adminSoftDepthClassName}`}
              >
                <EmptyNote
                  icon={<FileX2 aria-hidden className="h-5 w-5" />}
                  title={selectedId && archived[selectedId] ? "Archived as a duplicate" : "CV not found"}
                >
                  {selectedId && archived[selectedId]
                    ? "Archived as a duplicate. It is in the Duplicates folder and can be put back from there."
                    : "This CV could not be found. It may have been merged into another record."}
                </EmptyNote>
              </div>
            ) : (
              <div
                className={`flex min-h-0 flex-1 items-center justify-center border border-phx-line bg-white ${adminSoftDepthClassName}`}
              >
                <EmptyNote icon={<FileSearch aria-hidden className="h-5 w-5" />} title="No CV open">
                  Nothing is selected. Pick somebody from the list to read their CV.
                </EmptyNote>
              </div>
            )}
          </div>

          {/* ── AREA 4 ───────────────────────────────────────────────────────── */}
          <div
            className={cn(
              "min-h-0 w-full shrink-0 lg:flex lg:w-[322px]",
              mobilePane === "panel" && !focus ? "flex" : "hidden",
              showPanel ? undefined : "xl:hidden",
            )}
          >
            <WorkstationIntelligencePanel
              appliedForText={selected?.appliedForText ?? null}
              candidate={entry?.profile.candidate ?? null}
              canWriteNotes={canWriteNotes}
              extraction={entry?.extraction ?? null}
              loadError={entryError}
              loading={Boolean(activeId) && !entry && !entryError}
              noteCount={selected ? (noteCounts[selected.id] ?? selected.noteCount) : 0}
              onAcceptField={canWriteNotes ? (key, value) => void acceptReaderFinding(key, value) : null}
              onCollapse={() => setPanelOpen(false)}
              onNoteCountChange={(count) => {
                // Keyed on the VISIBLE selection, like every other write on this screen — the panel
                // is fed from `selected`, so counting a note against anything else is impossible.
                if (!selected) return;
                setNoteCounts((prev) => ({ ...prev, [selected.id]: count }));
                tabs.current?.post({ count, id: selected.id, kind: "notes" });
              }}
              onTabChange={setTab}
              screeningQuestions={entry?.screeningQuestions ?? null}
              tab={tab}
            />
          </div>
          {!showPanel && !focus ? <PaneSpine label="Intelligence" onOpen={() => setPanelOpen(true)} side="right" /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * "Two records share this phone number."
 *
 * REPORTS, NEVER MERGES. A shared handset is a re-upload roughly as often as it is two people — a
 * married couple, a brother sending his sister's CV, an internet café — and only a person reading
 * both records can tell those apart. So this names the other record and offers to open it; the
 * merge lives on the candidate's own screen, where the whole of both records is visible.
 */
/**
 * The pair, the EVIDENCE behind it, and the one action that resolves it.
 *
 * The sentence names what was actually matched rather than asserting a duplicate, because neither
 * signal is proof: candidate-matching.ts keeps the identity rule LOCKED to national ID then email —
 * neither of which has a single collision in production — and records that phone matching once
 * "merged three different applicants into one record". Families share a handset; Egyptian names
 * repeat. So this reports, offers both records to read, and lets a PERSON archive one.
 *
 * Archiving is a SHELF, not a delete: the row, its files and its history stay, and the CV can be put
 * back in the pool from the Duplicates folder. That is what makes a one-click action safe on
 * evidence this weak.
 */
function DuplicateBanner({
  archiving,
  onArchive,
  onOpen,
  row,
}: {
  archiving: boolean;
  onArchive: (id: string) => void;
  onOpen: (id: string) => void;
  row: WorkspaceCandidateRow;
}) {
  const evidence =
    row.duplicateReason === "phone"
      ? "share this phone number"
      : row.duplicateReason === "name"
        ? "carry this same name"
        : "look like the same person";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-phx-warn-line bg-phx-warn-bg px-4 py-1.5">
      <Layers aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-warn" />
      <span className="text-[12px] font-bold text-phx-warn">
        {row.duplicateCount} records {evidence}.
      </span>
      {row.duplicateIds.map((id, index) => (
        <button
          className="border border-phx-warn-line bg-white px-2 py-0.5 text-[12px] font-semibold text-phx-ink-2 transition hover:bg-phx-warn hover:text-white"
          key={id}
          onClick={() => onOpen(id)}
          type="button"
        >
          Open {row.duplicateNames[index] ?? "the other record"}
        </button>
      ))}
      {/* Archives the one ON SCREEN, never the other — the reader is looking at the record they are
          judging, and a button that acted on the twin would act on a CV they have not read. */}
      <button
        className="border border-phx-warn-line bg-white px-2 py-0.5 text-[12px] font-bold text-phx-warn transition hover:bg-phx-warn hover:text-white disabled:opacity-50"
        disabled={archiving}
        onClick={() => onArchive(row.id)}
        title="Move this record to the Duplicates folder. It leaves the pool and can be put back."
        type="button"
      >
        {archiving ? "Archiving..." : "Archive this one as a duplicate"}
      </button>
      <span className="w-full text-[11px] leading-tight text-phx-ink-soft">
        {row.duplicateReason === "name"
          ? "A shared name is the weakest signal there is - read both before archiving either."
          : "It may be the same person applying twice, or two people sharing a handset. Read both first."}{" "}
        Archiving files this record under Duplicates; nothing is merged and nothing is deleted.
      </span>
    </div>
  );
}

/**
 * What an empty list says.
 *
 * Never a generic "no results". An empty duplicate pile is good news, an empty list under a search
 * is a word to change, and an empty list under a server filter is a filter somebody should undo —
 * one sentence cannot mean all three, and the wrong one sends a recruiter looking for a bug.
 */
function emptyLabelFor(
  queue: ScreeningWorkQueue,
  vacancyTitle: string | null,
  search: string,
  poolSize: number,
  filteredOut: number,
): string {
  if (search.trim()) return `Nobody in this list matches “${search.trim()}”.`;
  if (vacancyTitle) return `Nobody in this pile is filed against ${vacancyTitle}.`;
  if (poolSize === 0 && filteredOut > 0) {
    return `The filters on this page hid all ${filteredOut} candidates. Clear them to see the pool.`;
  }
  return screeningWorkQueueEmptyLabels[queue];
}
