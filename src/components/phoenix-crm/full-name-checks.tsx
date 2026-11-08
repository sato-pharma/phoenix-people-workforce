"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { isAlreadyDecided, PlaceCheckSaved, useSavedOutcome, type PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { PLACE_SCHEDULE_TEXT, placeReadingText, placeSignboardText } from "@/components/phoenix-crm/validated-place-list";
import { DoctorNameFields } from "@/components/phoenix-crm/pm-name-fields";
import { CrmCardsOnPhone, CrmPill, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { phxButtonApproveClassName, phxButtonDangerClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { doctorFullNameProblem, splitDoctorName, type DoctorNameParts, type HeldFullName, type HeldFullNameBoard } from "@/lib/phoenix-crm/pm-name-rules";

/**
 * PM customers' full names waiting for a decision (owner, 2026-11-07, pm-name-rules.ts): the name a rep
 * wrote matched what was read off the signboard or timetable under 60%, or a validated customer's board was
 * never read. Approve renames the customer; reject keeps the old name and the customer stays blocked
 * until the rep writes another. The rep is never told it waited.
 *
 * 🔴 IT DECIDES LIKE EVERY OTHER PLACE CHECKS CONTROL (owner, 2026-11-08: "places checks is stale and
 * slow and many error"). Each press used to rebuild the whole page at once — the heaviest read in the
 * module — and keep the row's buttons live until that finished, so the next press on it answered "This
 * name was already decided" (the SFE Manager, 10:27 and 11:13 Cairo that morning), and the refusal showed
 * its raw code. Now the row draws its saved outcome the moment the server says yes, one re-read follows a
 * run of decisions (`placeCheckReread`), each row is busy on its own, and "already decided" settles it.
 *
 * 🔴 EDIT NAME IS THE SUPER ADMIN'S ALONE, NEVER THE SFE MANAGER'S (owner, 2026-11-08: "make an option to the
 * admin only, not the SFE, to edit the name by the reps to correct it, or add the third name"). `canCorrect`
 * comes from `canCorrectHeldFullName` on the server, and the route refuses a corrected name from anybody
 * else whatever this screen draws. It opens the rep's own three boxes on what the rep wrote, and Save and
 * approve renames the customer to the corrected name.
 *
 * 🔴 EVERY ROW OPENS ON ITS SIGNBOARD AND CLOSES AGAIN (owner, 2026-11-08: "to be able to accurate validate i
 * need the collapse and expand on every row carrying a dr name; if expanded the sign board photo with its
 * validation data appear and if collapsed collapsed"). Closed by default; "Show the board" opens the photo
 * (or, seated in a polyclinic, the timetable) and what the system read off it, where the rep stood and when.
 * The photo is asked for only when the row is opened.
 */
export function FullNameChecks({ canCorrect = false, rows }: { canCorrect?: boolean; rows: HeldFullName[] }) {
  const shown = rows.filter((row) => !row.isTest);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (customerId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });

  if (shown.length === 0) return null;

  const actions = (row: HeldFullName) => <FullNameDecision canCorrect={canCorrect} row={row} />;
  const match = (row: HeldFullName) => (row.percent === null ? "No board read" : `${row.percent}%`);
  const board = (row: HeldFullName) => (row.boardNames.length ? row.boardNames.join(" · ") : "Nothing was read off the board");

  return (
    <AdminTableShell
      description="A rep wrote a PM customer's first, middle and last name, and it matched the signboard or timetable under 60%, or the customer is validated and nothing was read off the board. Approve renames the customer. Reject keeps the old name, and the customer stays out of the plan and Add visit until the rep writes it again."
      title={`PM full names to check (${shown.length})`}
    >
      <CrmCardsOnPhone>
        {shown.map((row) => (
          <div className="space-y-2 px-4 py-4" key={row.customerId}>
            <p className="break-words font-bold text-slate-900" dir="auto">
              {row.fullName}
            </p>
            <p className="break-words text-xs text-slate-500" dir="auto">
              Now: {row.currentName}
            </p>
            <p className="text-xs text-slate-500">
              {row.repName}, {cairoDateTime(row.heldAt)}
            </p>
            <p className="break-words text-sm text-slate-700" dir="auto">
              Board: {board(row)} · <span className="font-bold">{match(row)}</span>
            </p>
            <BoardToggle customerId={row.customerId} onToggle={toggle} open={open.has(row.customerId)} />
            {open.has(row.customerId) ? <BoardPanel row={row} /> : null}
            {actions(row)}
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["30%", "30%", "12%", "28%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Customer</th>
            <th className={crmThClassName}>Read off the board</th>
            <th className={crmThClassName}>Match</th>
            <th className={crmThClassName}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <Fragment key={row.customerId}>
              <tr>
                <td className={crmTdClassName}>
                  <p className="font-bold text-slate-900" dir="auto">
                    {row.fullName}
                  </p>
                  <p className="mt-1 text-xs text-slate-500" dir="auto">
                    Now: {row.currentName}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.repName}, {cairoDateTime(row.heldAt)}
                  </p>
                  <div className="mt-2">
                    <BoardToggle customerId={row.customerId} onToggle={toggle} open={open.has(row.customerId)} controls={panelId(row.customerId)} />
                  </div>
                </td>
                <td className={crmTdClassName} dir="auto">
                  {board(row)}
                </td>
                <td className={crmTdClassName}>{match(row)}</td>
                <td className={crmTdClassName}>{actions(row)}</td>
              </tr>
              {open.has(row.customerId) ? (
                <TableRowDetail colSpan={4} id={panelId(row.customerId)}>
                  <BoardPanel row={row} />
                </TableRowDetail>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </CrmTable>
    </AdminTableShell>
  );
}

const panelId = (customerId: string) => `full-name-board-${customerId}`;

function BoardToggle({
  controls,
  customerId,
  onToggle,
  open,
}: {
  /** The panel's id, on the desktop table where the panel is a row of its own. */
  controls?: string;
  customerId: string;
  onToggle: (customerId: string) => void;
  open: boolean;
}) {
  const Icon = open ? ChevronUp : ChevronDown;
  return (
    <button
      {...(controls ? rowDetailToggleProps(controls, open) : { "aria-expanded": open })}
      className="inline-flex items-center gap-1 text-xs font-black text-orange-700 underline underline-offset-2"
      onClick={() => onToggle(customerId)}
      type="button"
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {open ? "Hide the board" : "Show the board"}
    </button>
  );
}

/** The opened row: every validated place of the customer, its photo and what was read off it. */
function BoardPanel({ row }: { row: HeldFullName }) {
  if (row.boards.length === 0) {
    return <p className="text-sm text-slate-500">This customer has no validated place in use, so there is no signboard photo to show.</p>;
  }
  return (
    <div className="min-w-0 space-y-4">
      {row.boards.map((board) => (
        <BoardEvidence board={board} fullName={row.fullName} key={board.placeId} />
      ))}
    </div>
  );
}

function BoardEvidence({ board, fullName }: { board: HeldFullNameBoard; fullName: string }) {
  const seated = board.seated;
  const readings = [placeReadingText("Photo", board.photo), placeReadingText("Capture location", board.pin)].filter((line): line is string => line !== null);
  const validated = `Validated ${cairoDateTime(board.validatedAt)} by ${board.validatedBy}`;
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap gap-3">
        <figure className="w-full min-w-0 space-y-1 sm:w-80">
          <CrmPhotoThumb
            alt={`${seated ? "The building" : "The signboard"} of ${fullName}`}
            caption={`${fullName} · ${validated}`}
            className="h-56 w-full"
            path={board.photoPath}
            rotatable
          />
          <figcaption className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">{seated ? "The building" : "The signboard"}</figcaption>
        </figure>
        {seated ? (
          <figure className="w-full min-w-0 space-y-1 sm:w-80">
            <CrmPhotoThumb
              alt={`The timetable that names ${fullName}`}
              caption={`${fullName} · the timetable of ${board.venueName ?? "the polyclinic"}`}
              className="h-56 w-full"
              path={board.schedulePhotoPath}
              rotatable
            />
            <figcaption className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">The timetable</figcaption>
          </figure>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1 text-sm text-slate-700">
        {board.placeLabel ? (
          <p className="break-words font-semibold" dir="auto">
            {board.placeLabel}
          </p>
        ) : null}
        {seated && board.venueName ? (
          <p className="break-words text-xs font-black text-slate-700" dir="auto">
            Seated in {board.venueName}
          </p>
        ) : null}
        {board.address ? (
          <p className="break-words text-xs text-slate-500" dir="auto">
            {board.address}
          </p>
        ) : null}
        {board.brickName || board.areaName ? (
          <p className="break-words text-xs text-slate-500" dir="auto">
            {[board.brickName, board.areaName].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <p className="break-words text-xs text-slate-500">{validated}</p>
        {readings.map((line) => (
          <p className="break-words text-xs text-slate-500" key={line}>
            {line}
          </p>
        ))}
        {board.mapsLink ? (
          <a className="inline-block text-xs font-black text-orange-700 underline underline-offset-2" href={board.mapsLink} rel="noreferrer" target="_blank">
            Open where they stood in Google Maps
          </a>
        ) : null}
        <div className="space-y-1 border-t border-slate-200 pt-2">
          {seated ? (
            board.schedule ? (
              <>
                <CrmPill tone={board.schedule.verdict === "match" ? "good" : board.schedule.verdict === "unjudged" ? "neutral" : "warn"}>
                  {PLACE_SCHEDULE_TEXT[board.schedule.verdict]}
                </CrmPill>
                {board.schedule.hoursRead ? (
                  <p className="break-words text-xs text-slate-700" dir="auto">
                    Hours read: {board.schedule.hoursRead}
                  </p>
                ) : null}
                {board.schedule.scheduleText ? (
                  <p className="break-words text-xs text-slate-700" dir="auto">
                    Read off the timetable: {board.schedule.scheduleText}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-slate-500">The timetable has not been read yet.</p>
            )
          ) : board.signboard ? (
            <>
              <CrmPill tone={board.signboard.verdict === "match" ? "good" : board.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
                {placeSignboardText(board.signboard)}
              </CrmPill>
              {board.signboard.signText ? (
                <p className="break-words text-xs text-slate-700" dir="auto">
                  Read off the sign: {board.signboard.signText}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-slate-500">The signboard has not been read yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function FullNameDecision({ canCorrect, row }: { canCorrect: boolean; row: HeldFullName }) {
  const router = useRouter();
  const { saved, markSaved } = useSavedOutcome(row);
  const [saving, setSaving] = useState<"approve" | "reject" | "correct" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The corrected name, open only while the Super Admin edits it; null is the row's plain buttons.
  const [editing, setEditing] = useState<DoctorNameParts | null>(null);

  if (saved) return <PlaceCheckSaved outcome={saved} />;

  const settle = (outcome: PlaceCheckOutcome) => {
    markSaved(outcome);
    placeCheckReread.ask(() => router.refresh());
  };

  async function decide(decision: "approve" | "reject", nameParts?: DoctorNameParts) {
    if (saving) return;
    if (nameParts) {
      const wrong = doctorFullNameProblem(nameParts);
      if (wrong) {
        setProblem(wrong);
        return;
      }
    }
    setSaving(nameParts ? "correct" : decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/full-names",
        nameParts ? { customerId: row.customerId, decision, nameParts } : { customerId: row.customerId, decision },
        "decided",
      );
      settle(decision === "approve" ? "approved" : "rejected");
      setSaving(null);
    } catch (error) {
      if (isAlreadyDecided(error)) {
        settle("already");
        setSaving(null);
        return;
      }
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  const problemLine = problem ? (
    <p className="break-words text-xs font-semibold text-rose-700" role="alert">
      {problem}
    </p>
  ) : null;

  if (editing) {
    return (
      <form
        className="min-w-0 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void decide("approve", editing);
        }}
      >
        <DoctorNameFields disabled={saving !== null} idPrefix={`full-name-${row.customerId}`} onChange={setEditing} stacked value={editing} />
        <div className="flex flex-wrap gap-2">
          <button className={phxButtonApproveClassName} disabled={saving !== null} type="submit">
            {saving === "correct" ? "Saving…" : "Save and approve"}
          </button>
          <button
            className={phxButtonGhostClassName}
            disabled={saving !== null}
            onClick={() => {
              setEditing(null);
              setProblem(null);
            }}
            type="button"
          >
            Cancel
          </button>
        </div>
        {problemLine}
      </form>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className={phxButtonApproveClassName} disabled={saving !== null} onClick={() => void decide("approve")} type="button">
          {saving === "approve" ? "Approving…" : "Approve name"}
        </button>
        <button className={phxButtonDangerClassName} disabled={saving !== null} onClick={() => void decide("reject")} type="button">
          {saving === "reject" ? "Rejecting…" : "Reject"}
        </button>
        {canCorrect ? (
          <button
            className={phxButtonGhostClassName}
            disabled={saving !== null}
            onClick={() => {
              setEditing(splitDoctorName(row.fullName));
              setProblem(null);
            }}
            type="button"
          >
            Edit name
          </button>
        ) : null}
      </div>
      {problemLine}
    </div>
  );
}
