"use client";

/**
 * Phoenix CRM — the Super Admin's camera page (owner, 20 Nov 2026).
 *
 * Every item the Phoenix Camera sent, in three lists and a fourth tab for the daily limit. Phoenix rejects
 * nothing the camera sends ("leave the decision to the decision maker"), and records nothing by itself (owner,
 * 21 Nov 2026: "EVERY VISIT GOES TO MANUAL REVIEW FIRST"): every item waits here with its reasons until he
 * approves it, up to the rep's allowance for that day (3, raised here for one day only once the manager's
 * approval is in by email). A seal that does not hold is drawn in red; the time
 * the photo was taken, where that time came from, when it arrived and how long it took are on every row, and
 * so is the gap between the position and the shutter. The rep's phone reads only "sent".
 *
 * It fits the screen: a phone draws cards, the desktop a `table-fixed` table whose colgroup and header row come
 * from ONE array, so the two cannot disagree. No `overflow-x`, no ellipsis.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, X } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import {
  CrmButton,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmField,
  CrmPill,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import {
  CAMERA_DAILY_CAP_MAX,
  CAMERA_DAILY_CAP_MIN,
  CAMERA_REVIEWS_PATH,
  cameraDuration,
  cameraFixGapText,
  type CameraItemRow,
  type CameraPageView,
  type CameraTab,
  type CameraTimeSource,
} from "@/lib/phoenix-crm/camera-item-rules";
import type { ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";

const COLUMNS = [
  { head: "Photo", width: "30%" },
  { head: "Rep and time", width: "22%" },
  { head: "Checks", width: "26%" },
  { head: "Decision", width: "22%" },
] as const;

const TABS: ReadonlyArray<{ key: CameraTab | "limit"; label: string }> = [
  { key: "waiting", label: "Waiting" },
  { key: "recorded", label: "Recorded" },
  { key: "archive", label: "Archive" },
  { key: "limit", label: "Daily limit" },
];

const TIME_SOURCE_TEXT: Record<CameraTimeSource, string> = {
  anchor: "time from the phone's last check with Phoenix",
  satellites: "time from the satellites",
  unconfirmed: "time not confirmed",
};

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

function tookText(row: CameraItemRow): string | null {
  if (!row.takenAt) return null;
  const seconds = (Date.parse(row.receivedAt) - Date.parse(row.takenAt)) / 1000;
  return Number.isFinite(seconds) ? `Took ${cameraDuration(seconds)} to arrive` : null;
}

function customerText(row: CameraItemRow): string {
  if (row.customerName) return row.customerName;
  const proposed = row.proposedCustomer;
  if (proposed && typeof proposed.name === "string" && proposed.name.trim()) return proposed.name.trim();
  return "No customer named";
}

function proposedFacts(row: CameraItemRow): string | null {
  const proposed = row.proposedCustomer;
  if (!proposed) return null;
  const parts = [proposed.listType, proposed.customerType, proposed.speciality, proposed.proposedGrade ? `Grade ${String(proposed.proposedGrade)}` : null, proposed.phone]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function PhotoCell({ row }: { row: CameraItemRow }) {
  return (
    <div className="min-w-0 space-y-2">
      {row.photoUrl ? (
        <a className="block w-full min-w-0 sm:w-56" href={row.photoUrl} rel="noreferrer" target="_blank">
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link to a private photo, never an optimisable asset */}
          <img alt={`The photo sent for ${customerText(row)}`} className="h-40 w-full border border-slate-200 bg-slate-50 object-cover" src={row.photoUrl} />
        </a>
      ) : (
        <p className="text-xs text-slate-500">The photo could not be loaded.</p>
      )}
      <p className="break-words font-black text-slate-900" dir="auto">
        {customerText(row)}
      </p>
      {proposedFacts(row) ? (
        <p className="break-words text-xs text-slate-500" dir="auto">
          {proposedFacts(row)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <CrmPill tone="info">{row.intentLabel}</CrmPill>
        <CrmPill tone="neutral">{row.photoKindLabel}</CrmPill>
        {row.isTest ? <CrmPill tone="orange">Test account</CrmPill> : null}
      </div>
    </div>
  );
}

function TimeCell({ row }: { row: CameraItemRow }) {
  const took = tookText(row);
  return (
    <div className="min-w-0 space-y-1 text-xs text-slate-600">
      <p className="break-words text-sm font-black text-slate-900">{row.repName}</p>
      <p className="break-words">
        Taken {row.takenAt ? cairoDateTime(row.takenAt) : "at an unknown time"}
        {row.timeSource === "unconfirmed" ? null : `, ${TIME_SOURCE_TEXT[row.timeSource]}`}
      </p>
      {row.timeSource === "unconfirmed" ? <p className="font-black text-rose-700">Time not confirmed</p> : null}
      <p className="break-words">Arrived {cairoDateTime(row.receivedAt)}</p>
      {took ? <p className="break-words">{took}</p> : null}
    </div>
  );
}

function ChecksCell({ row }: { row: CameraItemRow }) {
  const gap = cameraFixGapText(row.fixGapSeconds);
  const sealProblems = [...row.sealProblems, ...row.locationProblems];
  return (
    <div className="min-w-0 space-y-1.5 text-xs text-slate-600">
      {row.sealHolds ? (
        <CrmPill tone="good">The seal holds</CrmPill>
      ) : (
        <div className="space-y-1 border-l-[3px] border-rose-500 bg-rose-50 px-2 py-1.5">
          <p className="font-black text-rose-700">The seal does not hold</p>
          {sealProblems.map((problem) => (
            <p className="break-words text-rose-700" key={problem}>
              {problem}
            </p>
          ))}
        </div>
      )}
      {row.sealHolds && sealProblems.length > 0
        ? sealProblems.map((problem) => (
            <p className="break-words font-bold text-rose-700" key={problem}>
              {problem}
            </p>
          ))
        : null}
      {row.warnings.map((warning) => (
        <p className="break-words text-amber-800" key={warning}>
          {warning}
        </p>
      ))}
      {row.lat !== null && row.lon !== null ? (
        <p className="break-words">
          <a
            className="font-bold text-orange-700 underline underline-offset-2"
            href={`https://www.google.com/maps?q=${row.lat},${row.lon}`}
            rel="noreferrer"
            target="_blank"
          >
            Open the position
          </a>
          {row.accuracyMeters !== null ? `, within ${Math.round(row.accuracyMeters)} m` : null}
        </p>
      ) : (
        <p className="font-black text-rose-700">No location</p>
      )}
      {gap ? <p className="break-words">{gap}</p> : null}
      {row.readerVerdict ? (
        <p className="break-words" dir="auto">
          Name read: {row.readerVerdict}
          {row.readerText ? ` · ${row.readerText}` : null}
        </p>
      ) : null}
      {row.outcome === "waiting" && row.reasons.length === 0 ? <CrmPill tone="good">Every check passed</CrmPill> : null}
      {row.reasons.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {row.reasons.map((reason) => (
            <CrmPill key={reason.key} tone="warn">
              {reason.label}
            </CrmPill>
          ))}
        </div>
      ) : null}
      {row.ruleRefusal ? <p className="break-words text-amber-800">{row.ruleRefusal}</p> : null}
    </div>
  );
}

function DecidedText({ row }: { row: CameraItemRow }) {
  if (!row.decision) {
    if (row.outcome === "recorded") return <CrmPill tone="good">Recorded at once</CrmPill>;
    if (row.outcome === "archived") return <CrmPill tone="neutral">Archived after 36 hours</CrmPill>;
    return null;
  }
  return (
    <div className="min-w-0 space-y-1 text-xs text-slate-600">
      <CrmPill tone={row.decision === "approved" ? "good" : "bad"}>{row.decision === "approved" ? "Approved" : "Rejected"}</CrmPill>
      <p className="break-words">
        {row.decidedByName ? `By ${row.decidedByName}` : null}
        {row.decidedAt ? `, ${cairoDateTime(row.decidedAt)}` : null}
      </p>
      {row.decisionNote ? (
        <p className="break-words" dir="auto">
          {row.decisionNote}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A waiting camera visit's day: how many of the rep's allowance are approved, and the one-day raise (owner,
 * 21 Nov 2026: "IF MORE NEEDED WE NEED APPROVAL FROM MANAGERS VIA EMAIL AND SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY
 * ONLY"). The manager's approval is required and kept beside it.
 */
function DayAllowance({ row }: { row: CameraItemRow }) {
  const router = useRouter();
  const day = row.allowanceDay;
  const [raising, setRaising] = useState(false);
  const [value, setValue] = useState(String((day?.allowance ?? CAMERA_DAILY_CAP_MIN) + 1));
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!day) return null;
  const full = day.approved >= day.allowance;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await crmPost("/api/phoenix-crm/camera-reviews/day-allowance", { itemId: row.id, allowance: Number(value), managerApproval: approval.trim() }, "saved");
      setRaising(false);
      router.refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-1.5 border-l-[3px] border-slate-300 px-2 py-1 text-xs text-slate-600">
      <p className="break-words font-bold text-slate-800">
        {day.approved} of {day.allowance} camera {day.allowance === 1 ? "visit" : "visits"} approved for {utcDate(`${day.day}T12:00:00Z`)}
      </p>
      {day.raisedBy ? (
        <p className="break-words" dir="auto">
          Raised by {day.raisedBy} on the manager&apos;s approval: {day.managerApproval}
        </p>
      ) : null}
      {raising ? (
        <div className="min-w-0 space-y-2">
          <CrmField htmlFor={`camera-day-${row.id}`} label={`Camera visits for that day only (${Math.max(CAMERA_DAILY_CAP_MIN, day.approved)} to ${CAMERA_DAILY_CAP_MAX})`}>
            <input
              className={crmInputClassName}
              id={`camera-day-${row.id}`}
              inputMode="numeric"
              max={CAMERA_DAILY_CAP_MAX}
              min={Math.max(CAMERA_DAILY_CAP_MIN, day.approved)}
              onChange={(event) => setValue(event.target.value)}
              step={1}
              type="number"
              value={value}
            />
          </CrmField>
          <CrmField htmlFor={`camera-day-approval-${row.id}`} label="The manager's email approval: who approved it and when">
            <textarea
              className={crmTextareaClassName}
              id={`camera-day-approval-${row.id}`}
              maxLength={500}
              onChange={(event) => setApproval(event.target.value)}
              value={approval}
            />
          </CrmField>
          <div className="flex flex-wrap gap-2">
            <CrmButton busy={busy} disabled={busy || approval.trim().length < 3} onClick={save} size="sm" variant="primary">
              Save for that day
            </CrmButton>
            <CrmButton disabled={busy} onClick={() => setRaising(false)} size="sm" variant="ghost">
              Cancel
            </CrmButton>
          </div>
        </div>
      ) : full ? (
        <CrmButton onClick={() => setRaising(true)} size="sm" variant="secondary">
          Raise that day
        </CrmButton>
      ) : null}
      {error ? <p className="break-words font-bold text-rose-700">{error}</p> : null}
    </div>
  );
}

function DecisionCell({ row }: { row: CameraItemRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">("");
  const [error, setError] = useState<string | null>(null);

  const open = !row.decision && row.outcome !== "archived";
  // Taking back a validation recorded at once tells the rep what is wrong with the photo, so it needs the reason.
  const needsReason = row.outcome === "recorded" && Boolean(row.validatedPlaceId);

  async function decide(decision: "approved" | "rejected") {
    setBusy(decision);
    setError(null);
    try {
      await crmPost(
        "/api/phoenix-crm/camera-reviews/decide",
        { id: row.id, decision, note: note.trim() || null, ...(decision === "rejected" && needsReason ? { refusalReason: reason } : {}) },
        "decided",
      );
      router.refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <DecidedText row={row} />
      {open && row.outcome === "waiting" ? <DayAllowance row={row} /> : null}
      {open ? (
        <>
          {row.outcome === "waiting" ? (
            row.approveLabel ? (
              <CrmButton busy={busy === "approved"} disabled={busy !== null} onClick={() => decide("approved")} size="sm" variant="success">
                <Check aria-hidden className="h-4 w-4" />
                {row.approveLabel}
              </CrmButton>
            ) : row.cannotApprove ? (
              <p className="break-words text-xs font-bold text-slate-600">{row.cannotApprove}</p>
            ) : null
          ) : null}
          {rejecting ? (
            <div className="min-w-0 space-y-2">
              {needsReason ? <RefusalReasonField disabled={busy !== null} id={`camera-reason-${row.id}`} onChange={setReason} value={reason} /> : null}
              <CrmField htmlFor={`camera-note-${row.id}`} label="Note for the record (the rep never reads it)">
                <textarea
                  className={crmTextareaClassName}
                  id={`camera-note-${row.id}`}
                  maxLength={500}
                  onChange={(event) => setNote(event.target.value)}
                  value={note}
                />
              </CrmField>
              <div className="flex flex-wrap gap-2">
                <CrmButton
                  busy={busy === "rejected"}
                  disabled={busy !== null || (needsReason && !reason)}
                  onClick={() => decide("rejected")}
                  size="sm"
                  variant="danger"
                >
                  <X aria-hidden className="h-4 w-4" />
                  {row.outcome === "recorded" ? "Reject and take it back" : "Reject"}
                </CrmButton>
                <CrmButton disabled={busy !== null} onClick={() => setRejecting(false)} size="sm" variant="ghost">
                  Cancel
                </CrmButton>
              </div>
            </div>
          ) : (
            <CrmButton disabled={busy !== null} onClick={() => setRejecting(true)} size="sm" variant="danger">
              <X aria-hidden className="h-4 w-4" />
              Reject
            </CrmButton>
          )}
        </>
      ) : null}
      {error ? <p className="break-words text-xs font-bold text-rose-700">{error}</p> : null}
    </div>
  );
}

function DailyLimit({ cap }: { cap: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(cap));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await crmPost<{ cap: number }>("/api/phoenix-crm/camera-reviews/cap", { cap: Number(value) }, "saved");
      setValue(String(saved.cap));
      setMessage({ tone: "good", text: `Saved. From now on you may approve ${saved.cap} camera ${saved.cap === 1 ? "visit" : "visits"} of a rep's day.` });
      router.refresh();
    } catch (failure) {
      setMessage({ tone: "bad", text: messageOf(failure) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminTableShell
      description="How many camera visits of one rep's Phoenix day (it ends at 02:00) you may approve. Every visit waits for you first. For more on one day, raise that day on the visit itself once the manager's approval is in by email. The rep is never told the number."
      title="Daily limit"
    >
      <div className="max-w-md space-y-3 px-4 py-4">
        <CrmField htmlFor="camera-daily-cap" label={`Camera visits per rep per day (${CAMERA_DAILY_CAP_MIN} to ${CAMERA_DAILY_CAP_MAX})`}>
          <input
            className={crmInputClassName}
            id="camera-daily-cap"
            inputMode="numeric"
            max={CAMERA_DAILY_CAP_MAX}
            min={CAMERA_DAILY_CAP_MIN}
            onChange={(event) => setValue(event.target.value)}
            step={1}
            type="number"
            value={value}
          />
        </CrmField>
        <CrmButton busy={busy} disabled={busy || value === String(cap)} onClick={save} variant="primary">
          Save the limit
        </CrmButton>
        {message ? <p className={message.tone === "good" ? "text-sm font-bold text-emerald-700" : "text-sm font-bold text-rose-700"}>{message.text}</p> : null}
      </div>
    </AdminTableShell>
  );
}

const LIST_TEXT: Record<CameraTab, { title: string; description: string; empty: string }> = {
  waiting: {
    title: "Waiting for your decision",
    description: "Every camera item waits here first, with its checks. Approve records it in the rep's name, up to the rep's allowance for that day; Reject archives it. The rep reads only that it was sent.",
    empty: "Nothing from the camera waits for you.",
  },
  recorded: {
    title: "Recorded",
    description: "Approved by you. One recorded at once before 21 November can still be rejected: the visit is taken back and the place refused.",
    empty: "Nothing from the camera has been recorded yet.",
  },
  archive: {
    title: "Archive",
    description: "Rejected, or taken more than 36 hours before it arrived.",
    empty: "The archive is empty.",
  },
};

export function CameraReviewsBoard({ showLimit, view }: { showLimit: boolean; view: CameraPageView }) {
  const active: CameraTab | "limit" = showLimit ? "limit" : view.tab;
  const text = LIST_TEXT[view.tab];
  return (
    <div className="min-w-0 space-y-4">
      <nav aria-label="Camera reviews" className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            aria-current={tab.key === active ? "page" : undefined}
            className={
              tab.key === active
                ? "inline-flex min-h-10 items-center border border-orange-600 bg-orange-600 px-3 text-sm font-black text-white"
                : "inline-flex min-h-10 items-center border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 hover:border-slate-400"
            }
            href={`${CAMERA_REVIEWS_PATH}?tab=${tab.key}`}
            key={tab.key}
          >
            {tab.key === "waiting" ? `${tab.label} (${view.waitingCount})` : tab.key === "limit" ? `${tab.label}: ${view.cap}` : tab.label}
          </Link>
        ))}
      </nav>

      {showLimit ? (
        <DailyLimit cap={view.cap} />
      ) : (
        <AdminTableShell description={text.description} title={`${text.title} (${view.rows.length})`}>
          {view.rows.length === 0 ? (
            <CrmEmpty title={text.empty} />
          ) : (
            <>
              <CrmCardsOnPhone>
                {view.rows.map((row) => (
                  <div className="min-w-0 space-y-3 px-4 py-4" key={row.id}>
                    <PhotoCell row={row} />
                    <TimeCell row={row} />
                    <ChecksCell row={row} />
                    <DecisionCell row={row} />
                  </div>
                ))}
              </CrmCardsOnPhone>
              <CrmTable columns={[...COLUMNS.map((column) => column.width)]}>
                <ColumnHeads columns={COLUMNS} />
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.id}>
                      <td className={crmTdClassName}>
                        <PhotoCell row={row} />
                      </td>
                      <td className={crmTdClassName}>
                        <TimeCell row={row} />
                      </td>
                      <td className={crmTdClassName}>
                        <ChecksCell row={row} />
                      </td>
                      <td className={crmTdClassName}>
                        <DecisionCell row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </CrmTable>
            </>
          )}
        </AdminTableShell>
      )}
    </div>
  );
}
