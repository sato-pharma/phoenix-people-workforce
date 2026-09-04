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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers, PanelLeft, X } from "lucide-react";

import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";
import {
  screeningWorkQueueEmptyLabels,
  screeningWorkQueueLabels,
  type ScreeningWorkQueue,
  type WorkQueueCounts,
} from "@/lib/recruitment/screening-queues";
import { FREE_POSITION, NO_POSITION } from "@/components/recruitment/vacancy-picker";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
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
import { EmptyNote, PaneSpine } from "@/components/recruitment/workstation/workstation-ui";
import { cn } from "@/lib/utils";

/** What one loaded candidate is: the profile, and the CV read if there is one. */
type LoadedCandidate = { profile: CandidateProfileShape; extraction: StoredCvExtraction | null };

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

export function ScreeningWorkstation({
  canSendToManagers,
  canWriteNotes,
  counts,
  filteredOut,
  focus,
  onToggleFocus,
  hiringManagers,
  overdueManagerFeedback,
  poolSize,
  positionSuggestions,
  rows,
  vacancies,
  vacancyStats,
}: {
  canSendToManagers: boolean;
  canWriteNotes: boolean;
  counts: WorkQueueCounts;
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
  vacancies: readonly WorkspaceVacancy[];
  vacancyStats: readonly VacancyApplicantStats[];
}) {
  const [queue, setQueue] = useState<ScreeningWorkQueue>("new");
  const [vacancyId, setVacancyId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);
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
  const [mobilePane, setMobilePane] = useState<MobilePane>("list");
  const showRail = railOpen && !focus;
  const showList = listOpen && !focus;
  const showPanel = panelOpen && !focus;

  const [loaded, setLoaded] = useState<Record<string, LoadedCandidate>>({});
  const [loadError, setLoadError] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, CandidateStatus>>({});
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});
  const [sentInSession, setSentInSession] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (queue !== "all" && !row.queues.includes(queue)) return false;
      if (vacancyId !== null && !row.vacancyIds.includes(vacancyId)) return false;
      if (!needle) return true;
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
  }, [queue, rows, search, vacancyId]);

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
      };
      const profile = data.profile;
      if (!res.ok || !profile) throw new Error(data.message ?? "Could not load this candidate.");
      setLoaded((prev) => ({ ...prev, [candidateId]: { extraction: data.latestCvExtraction ?? null, profile } }));
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

  const openCandidate = useCallback((id: string) => {
    setSelectedId(id);
    setActionError(null);
    // On a phone the list and the CV are the same square of screen, so choosing somebody has to
    // move you to them; at a desk both are already visible and this is a no-op.
    setMobilePane("cv");
  }, []);

  const decide = useCallback(
    async (status: CandidateStatus, note: string | null) => {
      // `selected`, not `selectedId`: a decision must never land on a candidate the list in front of
      // the reader is not showing. `selected` is null exactly when that is the case.
      const selectedId = selected?.id;
      if (!selectedId || busy) return;
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
        goToNext();
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "Could not save that decision.");
      } finally {
        setBusy(false);
      }
    },
    [busy, goToNext, selected],
  );

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
        // The name the SERVER confirmed — it is the thing that knows who was actually told, and no
        // raw HR_ID ever reaches a person.
        sent.push(data.result?.managerName ?? localName);
      } catch {
        failed.push(localName);
      }
    }
    if (sent.length > 0) setSentInSession((prev) => ({ ...prev, [selectedId]: sent.join(", ") }));
    if (failed.length > 0) setActionError(`Could not send this CV to ${failed.join(", ")}.`);
    setBusy(false);
  }, [busy, hiringManagers, selected, sendState]);

  const suggestedVacancyIds = selected?.vacancyIds ?? [];

  const listTitle = screeningWorkQueueLabels[queue];
  const chosenVacancy = vacancyId === null ? null : vacancies.find((vacancy) => vacancy.id === vacancyId) ?? null;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 w-full overflow-hidden bg-phx-surface-2",
        // ONE KEYBOARD-FOCUS TREATMENT for the whole workstation, declared once here rather than on
        // each of the ~40 controls below it. It is an INSET outline, so a focused row at the very
        // edge of a pane is not clipped by the pane's own overflow — which is exactly where the
        // list, the queue and the tab strip all put their controls.
        "[&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-[-2px] [&_:focus-visible]:outline-phx-accent",
      )}
    >
      {/* ── AREA 1 ─────────────────────────────────────────────────────────── */}
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
            setVacancyId(next);
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The one bar that exists only on smaller screens: the queue drawer's handle, and the
            pane switcher. At a workstation neither is needed and neither renders — and in focus it
            goes as well, because "the whole screen for the CV" has to mean the same thing on a
            phone as it does on a laptop. The way back out lives on the strip above the document. */}
        <div
          className={cn(
            "shrink-0 items-center gap-1.5 border-b border-phx-line bg-white px-2 py-1.5 xl:hidden",
            focus ? "hidden" : "flex",
          )}
        >
          <button
            className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
            onClick={() => setQueueOpen((open) => !open)}
            type="button"
          >
            {queueOpen ? <X className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />}
            Queue
          </button>
          <span className="min-w-0 flex-1 break-words text-[12px] font-semibold text-phx-ink-soft">
            {listTitle}
            {chosenVacancy ? ` · ${chosenVacancy.jobTitle}` : ""}
          </span>
          <span className="flex shrink-0 lg:hidden">
            {(["list", "cv", "panel"] as const).map((pane) => (
              <button
                aria-pressed={mobilePane === pane}
                className={cn(
                  "border border-l-0 px-2 py-1 text-[12px] font-bold transition first:border-l",
                  mobilePane === pane
                    ? "border-phx-accent-line bg-phx-accent text-white"
                    : "border-phx-line bg-white text-phx-ink-2",
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

        <div className="flex min-h-0 flex-1">
          {/* ── AREA 2 ───────────────────────────────────────────────────────── */}
          <div
            className={cn(
              "min-h-0 w-full shrink-0 lg:flex lg:w-[288px]",
              mobilePane === "list" && !focus ? "flex" : "hidden",
              showList ? undefined : "lg:hidden",
            )}
          >
            <WorkstationCandidateList
              decidedById={decided}
              emptyLabel={emptyLabelFor(queue, chosenVacancy?.jobTitle ?? null, search, poolSize, filteredOut)}
              onCollapse={() => setListOpen(false)}
              onSelect={openCandidate}
              onSearchChange={setSearch}
              rows={visible}
              search={search}
              selectedId={selectedId}
              title={listTitle}
              totalLabel={`${visible.length} of ${poolSize}`}
            />
          </div>
          {!showList && !focus ? (
            <PaneSpine label="Candidates" onOpen={() => setListOpen(true)} side="left" />
          ) : null}

          {/* ── AREA 3 + the CV ──────────────────────────────────────────────── */}
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col lg:flex",
              mobilePane === "cv" || focus ? "flex" : "hidden",
            )}
          >
            {selected ? (
              <>
                <WorkstationReviewHeader
                  busy={busy}
                  canSend={canSendToManagers}
                  decided={decided[selected.id] ?? null}
                  error={actionError}
                  focus={focus}
                  hiringManagers={hiringManagers}
                  onDecide={decide}
                  onNext={goToNext}
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
                  <DuplicateBanner onOpen={openCandidate} row={selected} />
                ) : null}
                <div className="min-h-0 flex-1">
                  <WorkstationCvPane
                    attachedCount={entry?.profile.files.length ?? 0}
                    error={entryError}
                    file={cvFile}
                    loading={!entry && !entryError}
                    notACv={selected.notACv || entry?.extraction?.isCv === false}
                  />
                </div>
              </>
            ) : (
              <EmptyNote>Nothing is selected. Pick somebody from the list to read their CV.</EmptyNote>
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
              onCollapse={() => setPanelOpen(false)}
              onNoteCountChange={(count) => {
                // Keyed on the VISIBLE selection, like every other write on this screen — the panel
                // is fed from `selected`, so counting a note against anything else is impossible.
                if (!selected) return;
                setNoteCounts((prev) => ({ ...prev, [selected.id]: count }));
              }}
              onTabChange={setTab}
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
function DuplicateBanner({
  onOpen,
  row,
}: {
  onOpen: (id: string) => void;
  row: WorkspaceCandidateRow;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-phx-warn-line bg-phx-warn-bg px-4 py-1.5">
      <Layers aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-warn" />
      <span className="text-[12px] font-bold text-phx-warn">
        {row.duplicateCount} records share this phone number.
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
      <span className="w-full text-[11px] leading-tight text-phx-ink-soft">
        It may be the same person applying twice, or two people sharing a handset. Read both before merging anything —
        nothing is merged from here.
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
