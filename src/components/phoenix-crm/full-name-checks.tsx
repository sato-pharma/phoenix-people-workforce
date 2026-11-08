"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { isAlreadyDecided, PlaceCheckSaved, useSavedOutcome, type PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { DoctorNameFields } from "@/components/phoenix-crm/pm-name-fields";
import { CrmCardsOnPhone, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { phxButtonApproveClassName, phxButtonDangerClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { doctorFullNameProblem, splitDoctorName, type DoctorNameParts, type HeldFullName } from "@/lib/phoenix-crm/pm-name-rules";

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
 */
export function FullNameChecks({ canCorrect = false, rows }: { canCorrect?: boolean; rows: HeldFullName[] }) {
  const shown = rows.filter((row) => !row.isTest);

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
            <tr key={row.customerId}>
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
              </td>
              <td className={crmTdClassName} dir="auto">
                {board(row)}
              </td>
              <td className={crmTdClassName}>{match(row)}</td>
              <td className={crmTdClassName}>{actions(row)}</td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </AdminTableShell>
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
