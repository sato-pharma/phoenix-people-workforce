"use client";

/**
 * Phoenix CRM — the Super Admin's visit-recording page (owner, 2026-10-16).
 *
 * Three lists. The recorded visits WAITING FOR HIS APPROVAL, oldest first: a recorded visit of any type
 * counts in nothing until the Administrator approves it, and a recorded off-plan one reaches its manager
 * only after his yes ("any visit any type which is recorder must go for adminstarator approval first even
 * if in plan"). The REPS, one row per person, each with the switch that makes recording the visit the
 * first step of Add visit for that rep alone ("this only works to who the admin choose not everyone").
 * And the RECORDINGS of the last 90 days, each one playable, downloadable and deletable at any time —
 * nothing is deleted on its own (his answer 7).
 *
 * It fits the screen: a phone draws cards, the desktop a `table-fixed` table whose colgroup and header
 * row come from ONE array per table, so the two cannot disagree. No `overflow-x`, no ellipsis.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Trash2, X } from "lucide-react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmNote,
  CrmPill,
  CrmSearchField,
  CrmTable,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { CrmVisitRecordingPlayer } from "@/components/phoenix-crm/voice-playback";
import { Switch } from "@/components/ui/switch";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { cairoClock } from "@/lib/phoenix-crm/touch-trail-reader";
import {
  describeRecordingLength,
  describeRecordingSize,
  RECORDING_REVIEW_NOTE_MAX,
  recordingReviewLabel,
  type RecordingListRow,
  type RecordingRepRow,
  type RecordingReviewStatus,
  type VisitRecordingAdminView,
} from "@/lib/phoenix-crm/visit-recording-rules";

const WAITING_COLUMNS = [
  { head: "Visit", width: "27%" },
  { head: "Rep", width: "19%" },
  { head: "Listen", width: "26%" },
  { head: "Approve or refuse", width: "28%" },
] as const;

const REP_COLUMNS = [
  { head: "Rep", width: "30%" },
  { head: "Line and area", width: "34%" },
  { head: "Switched on", width: "22%" },
  { head: "Record visits", width: "14%" },
] as const;

const RECORDING_COLUMNS = [
  { head: "Visit", width: "26%" },
  { head: "Rep", width: "20%" },
  { head: "Length", width: "12%" },
  { head: "Listen", width: "24%" },
  { head: "Keep or delete", width: "18%" },
] as const;

const REVIEW_TONE: Record<RecordingReviewStatus, PillTone> = { pending: "warn", approved: "good", refused: "bad" };

function ColumnHeads({ columns }: { columns: ReadonlyArray<{ head: string; width: string }> }) {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <th className={crmThClassName} key={column.head}>
            {column.head}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function matches(query: string, values: ReadonlyArray<string>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => value.toLowerCase().includes(needle));
}

function switchedOnText(rep: RecordingRepRow): string {
  if (!rep.required) return "Off";
  const when = rep.setAt ? `${formatPhoenixLongDate(rep.setAt)}, ${cairoClock(rep.setAt).slice(0, 5)}` : null;
  return [rep.setByName ? `By ${rep.setByName}` : null, when].filter(Boolean).join(" · ") || "On";
}

function visitWhenText(row: RecordingListRow): string {
  return `${formatPhoenixLongDate(row.visitDate)}, ${cairoClock(row.capturedAt).slice(0, 5)}`;
}

/** Who decided and when, with the refusal's note. Empty while it waits. */
function reviewedText(row: RecordingListRow): string {
  if (row.reviewStatus === "pending") return "";
  const when = row.reviewedAt ? `${formatPhoenixLongDate(row.reviewedAt)}, ${cairoClock(row.reviewedAt).slice(0, 5)}` : null;
  return [row.reviewedByName ? `By ${row.reviewedByName}` : null, when, row.reviewNote].filter(Boolean).join(" · ");
}

function ReviewPill({ row }: { row: RecordingListRow }) {
  return <CrmPill tone={REVIEW_TONE[row.reviewStatus]}>{recordingReviewLabel(row.reviewStatus)}</CrmPill>;
}

export function VisitRecordingAdmin({ view }: { view: VisitRecordingAdminView }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const reps = useMemo(() => view.reps.filter((rep) => matches(query, [rep.name, rep.lineName, rep.areaName, rep.regionName])), [query, view.reps]);
  const switchedOn = view.reps.filter((rep) => rep.required).length;

  async function toggle(rep: RecordingRepRow, required: boolean) {
    setBusy(`rep:${rep.hrId}`);
    setError(null);
    try {
      await crmPost("/api/phoenix-crm/recording/admin", { hrId: rep.hrId, required }, "result");
      router.refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }

  async function download(row: RecordingListRow) {
    setBusy(`download:${row.path}`);
    setError(null);
    try {
      const result = await crmPost<{ url: string }>("/api/phoenix-crm/recording/admin/download", { path: row.path }, "download");
      window.location.assign(result.url);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: RecordingListRow) {
    setBusy(`delete:${row.path}`);
    setError(null);
    try {
      await crmPost("/api/phoenix-crm/recording/admin/delete", { path: row.path }, "deleted");
      setConfirmDelete(null);
      router.refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }

  async function review(row: RecordingListRow, decision: "approve" | "refuse") {
    if (decision === "refuse" && !note.trim()) {
      setError("Write a note explaining why, then refuse.");
      return;
    }
    setBusy(`review:${row.visitId}`);
    setError(null);
    try {
      await crmPost("/api/phoenix-crm/recording/admin/review", { visitId: row.visitId, decision, note: decision === "refuse" ? note : "" }, "reviewed");
      setRefusing(null);
      setNote("");
      router.refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }

  function reviewActions(row: RecordingListRow) {
    if (!view.canReview) {
      return <p className="break-words text-xs font-semibold text-slate-500">Only the Administrator approves a recorded visit.</p>;
    }
    const working = busy === `review:${row.visitId}`;
    if (refusing === row.visitId) {
      const noteId = `recording-refuse-${row.visitId}`;
      return (
        <div className="grid min-w-0 gap-2">
          <CrmField hint="Needed to refuse. The visit then counts in nothing." htmlFor={noteId} label="Why it is refused">
            <textarea
              className={crmTextareaClassName}
              disabled={working}
              id={noteId}
              maxLength={RECORDING_REVIEW_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              value={note}
            />
          </CrmField>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton busy={working} disabled={busy !== null} onClick={() => void review(row, "refuse")} size="sm" variant="danger">
              Refuse
            </CrmButton>
            <CrmButton
              disabled={working}
              onClick={() => {
                setRefusing(null);
                setNote("");
              }}
              size="sm"
              variant="secondary"
            >
              Back
            </CrmButton>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-wrap gap-2">
        <CrmButton busy={working} disabled={busy !== null} onClick={() => void review(row, "approve")} size="sm" variant="primary">
          {working ? null : <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          Approve
        </CrmButton>
        <CrmButton
          disabled={busy !== null}
          onClick={() => {
            setRefusing(row.visitId);
            setNote("");
          }}
          size="sm"
          variant="secondary"
        >
          <X aria-hidden className="h-3.5 w-3.5 shrink-0" />
          Refuse
        </CrmButton>
      </div>
    );
  }

  function listenCell(row: RecordingListRow) {
    if (row.deleted) return <p className="break-words text-xs font-semibold text-slate-500">The recording was deleted.</p>;
    return (
      <div className="grid min-w-0 gap-1">
        <CrmVisitRecordingPlayer seconds={row.seconds} visitId={row.visitId} />
        <span className="text-xs font-semibold text-slate-500">
          {describeRecordingLength(row.seconds)} · {describeRecordingSize(row.bytes)}
        </span>
      </div>
    );
  }

  function repSwitch(rep: RecordingRepRow) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Switch
          checked={rep.required}
          label={`Record visits: ${rep.name}`}
          onChange={(next) => {
            if (busy) return;
            void toggle(rep, next);
          }}
        />
        <span className="text-xs font-black text-slate-600">{busy === `rep:${rep.hrId}` ? "Saving" : rep.required ? "On" : "Off"}</span>
      </div>
    );
  }

  function recordingActions(row: RecordingListRow) {
    if (confirmDelete === row.path) {
      return (
        <div className="grid min-w-0 gap-2">
          <p className="break-words text-xs font-bold text-rose-800">Delete this recording for good? It cannot be brought back.</p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton busy={busy === `delete:${row.path}`} disabled={busy !== null} onClick={() => void remove(row)} size="sm" variant="danger">
              Delete for good
            </CrmButton>
            <CrmButton onClick={() => setConfirmDelete(null)} size="sm" variant="secondary">
              Keep it
            </CrmButton>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-wrap gap-2">
        <CrmButton busy={busy === `download:${row.path}`} disabled={busy !== null} onClick={() => void download(row)} size="sm" variant="secondary">
          {busy === `download:${row.path}` ? null : <Download aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          Download
        </CrmButton>
        <CrmButton disabled={busy !== null} onClick={() => setConfirmDelete(row.path)} size="sm" variant="danger">
          <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
          Delete
        </CrmButton>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}

      <section className="min-w-0 border border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <h2 className="text-base font-black text-slate-950">Waiting for your approval</h2>
          <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
            Every recorded visit waits here first, whatever its type: planned, out of plan, out of list or a pharmacy. It counts in nothing
            until it is approved, and an out-of-plan visit reaches the district manager and SFE only after that. Refused, it never counts.
            {view.waiting.length > 0 ? ` ${view.waiting.length} waiting, oldest first.` : ""}
          </p>
        </header>

        {view.waiting.length === 0 ? (
          <CrmEmpty message="A recorded visit appears here as soon as the rep logs it." title="Nothing is waiting" />
        ) : (
          <>
            <CrmCardsOnPhone>
              {view.waiting.map((row) => (
                <CrmCard
                  accent="border-l-amber-500"
                  key={row.path}
                  meta={visitWhenText(row)}
                  status={<CrmPill tone="info">{row.visitTypeLabel}</CrmPill>}
                  title={row.customerName}
                >
                  <div className="grid min-w-0 gap-3">
                    <CrmFacts
                      facts={[
                        { label: "Rep", value: row.repName },
                        { label: "Line and area", value: `${row.lineName} · ${row.areaName}` },
                      ]}
                    />
                    {listenCell(row)}
                    {reviewActions(row)}
                  </div>
                </CrmCard>
              ))}
            </CrmCardsOnPhone>

            <CrmTable columns={[...WAITING_COLUMNS.map((column) => column.width)]}>
              <ColumnHeads columns={WAITING_COLUMNS} />
              <tbody>
                {view.waiting.map((row) => (
                  <tr key={row.path}>
                    <td className={crmTdClassName}>
                      <span className="font-black text-slate-900">{row.customerName}</span>
                      <div className="mt-1 text-xs font-semibold text-slate-500">{visitWhenText(row)}</div>
                      <div className="mt-1.5">
                        <CrmPill tone="info">{row.visitTypeLabel}</CrmPill>
                      </div>
                    </td>
                    <td className={crmTdClassName}>
                      {row.repName}
                      <div className="mt-1 text-xs font-semibold text-slate-500">
                        {row.lineName} · {row.areaName}
                      </div>
                    </td>
                    <td className={crmTdClassName}>{listenCell(row)}</td>
                    <td className={crmTdClassName}>{reviewActions(row)}</td>
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </>
        )}
      </section>

      <section className="min-w-0 border border-slate-200 bg-white">
        <header className="grid min-w-0 gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-950">Reps</h2>
            <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
              Switch a rep on and Add visit opens with the recorder: the rep records the conversation, from at least 30 seconds up to 15
              minutes, and only then logs the visit. Switched off, Add visit is exactly as before. {switchedOn} of {view.reps.length} switched
              on.
            </p>
          </div>
          <CrmSearchField id="visit-recording-rep-search" label="Find a rep" onChange={setQuery} placeholder="Name, line or area" value={query} />
        </header>

        {reps.length === 0 ? (
          <CrmEmpty message="No rep matches that search." title="No rep found" />
        ) : (
          <>
            <CrmCardsOnPhone>
              {reps.map((rep) => (
                <CrmCard
                  accent={rep.required ? "border-l-orange-500" : "border-l-slate-300"}
                  key={rep.hrId}
                  meta={`${rep.lineName} · ${rep.areaName}`}
                  status={rep.required ? <CrmPill tone="warn">Records visits</CrmPill> : null}
                  title={rep.name}
                >
                  <div className="grid min-w-0 gap-2">
                    {repSwitch(rep)}
                    {rep.required ? <p className="break-words text-xs font-semibold text-slate-500">{switchedOnText(rep)}</p> : null}
                  </div>
                </CrmCard>
              ))}
            </CrmCardsOnPhone>

            <CrmTable columns={[...REP_COLUMNS.map((column) => column.width)]}>
              <ColumnHeads columns={REP_COLUMNS} />
              <tbody>
                {reps.map((rep) => (
                  <tr key={rep.hrId}>
                    <td className={crmTdClassName}>
                      <span className="font-black text-slate-900">{rep.name}</span>
                    </td>
                    <td className={crmTdClassName}>
                      {rep.lineName}
                      <div className="mt-1 text-xs font-semibold text-slate-500">{[rep.areaName, rep.regionName].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className={crmTdClassName}>{switchedOnText(rep)}</td>
                    <td className={crmTdClassName}>{repSwitch(rep)}</td>
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </>
        )}
      </section>

      <section className="min-w-0 border border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <h2 className="text-base font-black text-slate-950">Recordings</h2>
          <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
            Every visit recorded since {formatPhoenixLongDate(view.since)}, newest first, with the decision on each. Older recordings stay
            stored. A recording is deleted only from here, one at a time.
          </p>
        </header>

        {view.recordings.length === 0 ? (
          <CrmEmpty message="A visit recorded by a switched-on rep appears here once the visit is logged." title="No recordings yet" />
        ) : (
          <>
            <CrmCardsOnPhone>
              {view.recordings.map((row) => (
                <CrmCard key={row.path} meta={visitWhenText(row)} status={<ReviewPill row={row} />} title={row.customerName}>
                  <div className="grid min-w-0 gap-3">
                    <CrmFacts
                      facts={[
                        { label: "Rep", value: row.repName },
                        { label: "Visit", value: row.visitTypeLabel },
                        { label: "Line and area", value: `${row.lineName} · ${row.areaName}` },
                        { label: "Length", value: `${describeRecordingLength(row.seconds)} · ${describeRecordingSize(row.bytes)}` },
                        ...(row.reviewStatus === "pending" ? [] : [{ label: "Decided", value: reviewedText(row) }]),
                      ]}
                    />
                    <CrmVisitRecordingPlayer seconds={row.seconds} visitId={row.visitId} />
                    {recordingActions(row)}
                  </div>
                </CrmCard>
              ))}
            </CrmCardsOnPhone>

            <CrmTable columns={[...RECORDING_COLUMNS.map((column) => column.width)]}>
              <ColumnHeads columns={RECORDING_COLUMNS} />
              <tbody>
                {view.recordings.map((row) => (
                  <tr key={row.path}>
                    <td className={crmTdClassName}>
                      <span className="font-black text-slate-900">{row.customerName}</span>
                      <div className="mt-1 text-xs font-semibold text-slate-500">
                        {visitWhenText(row)} · {row.visitTypeLabel}
                      </div>
                      <div className="mt-1.5">
                        <ReviewPill row={row} />
                      </div>
                      {row.reviewStatus === "pending" ? null : (
                        <div className="mt-1 break-words text-xs font-semibold text-slate-500">{reviewedText(row)}</div>
                      )}
                    </td>
                    <td className={crmTdClassName}>
                      {row.repName}
                      <div className="mt-1 text-xs font-semibold text-slate-500">
                        {row.lineName} · {row.areaName}
                      </div>
                    </td>
                    <td className={crmTdClassName}>
                      {describeRecordingLength(row.seconds)}
                      <div className="mt-1 text-xs font-semibold text-slate-500">{describeRecordingSize(row.bytes)}</div>
                    </td>
                    <td className={crmTdClassName}>
                      <CrmVisitRecordingPlayer seconds={row.seconds} visitId={row.visitId} />
                    </td>
                    <td className={crmTdClassName}>{recordingActions(row)}</td>
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </>
        )}
      </section>
    </div>
  );
}
