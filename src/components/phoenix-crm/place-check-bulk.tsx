"use client";

/**
 * Phoenix CRM — Place checks: ticking several rows and answering them in one go.
 *
 * Owner, 2026-10-15: "also make me able to multiple select and response". Every section of the page
 * was one row at a time — a reason, a note and a button per place — and the queue is worked through in
 * sittings of dozens.
 *
 * 🔴 A BULK ANSWER IS THE SAME ANSWER, N TIMES — never a second decision path. Each action runs the
 * per-row request the page already makes, one after another, and the reason and note are typed ONCE and
 * sent with each: so the rep is told exactly what a one-row refusal tells him, the audit rows are the
 * same rows, and nothing new reaches the database. They run SEQUENTIALLY on purpose — every rejection
 * retires a place and re-measures that customer's visits, and firing twenty of those at once is how one
 * of them comes back a timeout with no way to say which.
 *
 * 🔴 A ROW THAT FALLS OUT OF THE LIST FALLS OUT OF THE SELECTION. `useRowPicks` intersects what is
 * ticked with what is on screen at every render, so changing a filter — or a row settling under you —
 * can never decide a place you cannot see.
 *
 * 🔴 AND IT IS THE SUPER ADMIN'S ALONE, like every control it repeats: a district manager's board
 * passes `mode === "team"` and renders none of this (his screen says nothing about who decides).
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { messageOf } from "@/components/phoenix-crm/api";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { CrmButton, CrmCheck, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import type { PlaceCheckAdviceKind } from "@/lib/phoenix-crm/place-check-advice";
import {
  VALIDATION_NOTE_LABEL,
  VALIDATION_REASON_REQUIRED,
  type ValidationPickKind,
  type ValidationRefusalReason,
} from "@/lib/phoenix-crm/validation-feedback";

/** What a bulk action is given for each row it runs on. The reason and the note are typed once. */
export type BulkAnswer = { note: string; reason: ValidationRefusalReason | "" };

export type BulkAction<Row> = {
  /** Stable key, so a run can say which action is in flight. */
  key: string;
  /** The button, which carries the count it will act on: "Reject (4)". */
  label: string;
  busyLabel: string;
  variant: "primary" | "danger";
  /** Whether the closed pick-list must be answered before this one may run. */
  needsReason: boolean;
  /** What it costs, said before it runs. A destructive action arms on the first press. */
  warning?: (count: number) => string;
  /** Which of the ticked rows this action can actually answer. */
  takes: (row: Row) => boolean;
  /**
   * The ONE row request the page already makes. It answers `unknown` because that is what `crmPost`
   * hands back (`body[key]`, the value) and the bar never reads it — only whether it threw.
   */
  run: (row: Row, answer: BulkAnswer) => Promise<unknown>;
};

/** What one section's tick boxes hand its bar. Written out, so the bar takes it as a plain prop. */
export type RowPicks<Row> = {
  /** Every ticked row still on screen — the set every action is filtered from. */
  picked: readonly Row[];
  /** How many rows could be ticked at all, for the "Pick all" line. */
  selectable: number;
  isPicked: (row: Row) => boolean;
  toggle: (row: Row, next: boolean) => void;
  pickAll: () => void;
  /** Tick exactly the rows on screen that pass `test` — what the system's recommendation picks. */
  pickWhere: (test: (row: Row) => boolean) => void;
  /** The rows on screen that could be ticked, for counting what `pickWhere` would take. */
  rows: readonly Row[];
  clear: () => void;
};

/**
 * What is ticked, intersected with what is on screen.
 *
 * The ids live in state and the rows are the authority: `picked` is derived at every render, so a row
 * the filters removed is simply not in it and no action can reach it.
 */
export function useRowPicks<Row>(
  rows: readonly Row[],
  idOf: (row: Row) => string,
  selectable: (row: Row) => boolean = () => true,
): RowPicks<Row> {
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const onScreen = useMemo(() => {
    const map = new Map<string, Row>();
    for (const row of rows) if (selectable(row)) map.set(idOf(row), row);
    return map;
  }, [idOf, rows, selectable]);
  const picked = useMemo(() => ticked.map((id) => onScreen.get(id)).filter((row): row is Row => row !== undefined), [onScreen, ticked]);

  return {
    picked,
    selectable: onScreen.size,
    isPicked: (row: Row) => ticked.includes(idOf(row)),
    toggle: (row: Row, next: boolean) => {
      const id = idOf(row);
      setTicked((current) => (next ? [...current.filter((each) => each !== id), id] : current.filter((each) => each !== id)));
    },
    pickAll: () => setTicked([...onScreen.keys()]),
    pickWhere: (test) => setTicked([...onScreen.entries()].filter(([, row]) => test(row)).map(([id]) => id)),
    rows: [...onScreen.values()],
    clear: () => setTicked([]),
  };
}

/** The tick box on one row — the same control in the cards and in the table. */
export function BulkPick<Row>({ picks, row }: { picks: RowPicks<Row>; row: Row }) {
  return (
    <CrmCheck checked={picks.isPicked(row)} onChange={(next) => picks.toggle(row, next)}>
      <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">Pick</span>
    </CrmCheck>
  );
}

/**
 * The bar above a section: how many are ticked, the reason and note for all of them, and one button
 * per action carrying the number it will answer.
 */
export function BulkDecideBar<Row>({
  actions,
  adviceOf,
  kind = "signboard",
  nameOf,
  picks,
}: {
  actions: ReadonlyArray<BulkAction<Row>>;
  /**
   * The system's recommendation per row (owner, 2026-10-17), so the bar can tick every row it
   * recommends approving, or rejecting, in one press. Ticking decides nothing: the answer is still his
   * own press of an action button, with the reason he picks.
   */
  adviceOf?: (row: Row) => PlaceCheckAdviceKind | null;
  /** Which photo the selection is about, so the pick-list offers only reasons true of it. */
  kind?: ValidationPickKind;
  /** How a row names itself, so a failure says which place it was. */
  nameOf: (row: Row) => string;
  picks: RowPicks<Row>;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">("");
  const [armed, setArmed] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<ReadonlyArray<{ name: string; problem: string }>>([]);

  const picked = picks.picked;
  const needsReason = actions.some((action) => action.needsReason);

  async function run(action: BulkAction<Row>) {
    const targets = picked.filter(action.takes);
    if (running || targets.length === 0) return;
    if (action.warning && armed !== action.key) {
      setArmed(action.key);
      return;
    }
    setArmed(null);
    setRunning(action.key);
    setDone(0);
    setFailures([]);
    const failed: Array<{ name: string; problem: string }> = [];
    for (const row of targets) {
      try {
        await action.run(row, { note, reason });
      } catch (error) {
        failed.push({ name: nameOf(row), problem: messageOf(error) });
      }
      setDone((current) => current + 1);
    }
    setFailures(failed);
    setRunning(null);
    // Whatever landed, the page is re-read: the rows that settled leave their section, and the ones
    // that failed stay where they are with their reason beside them.
    if (failed.length < targets.length) picks.clear();
    router.refresh();
  }

  if (picks.selectable === 0) return null;

  // How many rows on screen the system recommends each way — the counts on the two quick picks.
  const recommended = (want: PlaceCheckAdviceKind) => (adviceOf ? picks.rows.filter((row) => adviceOf(row) === want).length : 0);
  const toApprove = recommended("approve");
  const toReject = recommended("reject");

  return (
    <div className="min-w-0 space-y-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
          {picked.length === 0 ? `Pick rows to answer together (${picks.selectable} here)` : `${picked.length} picked`}
        </p>
        <CrmButton disabled={running !== null} onClick={() => picks.pickAll()} size="sm" variant="ghost">
          Pick all {picks.selectable}
        </CrmButton>
        {adviceOf && toApprove > 0 ? (
          <CrmButton disabled={running !== null} onClick={() => picks.pickWhere((row) => adviceOf(row) === "approve")} size="sm" variant="ghost">
            Pick the {toApprove} the system recommends approving
          </CrmButton>
        ) : null}
        {adviceOf && toReject > 0 ? (
          <CrmButton disabled={running !== null} onClick={() => picks.pickWhere((row) => adviceOf(row) === "reject")} size="sm" variant="ghost">
            Pick the {toReject} the system recommends rejecting
          </CrmButton>
        ) : null}
        {picked.length > 0 ? (
          <CrmButton disabled={running !== null} onClick={() => picks.clear()} size="sm" variant="ghost">
            Clear
          </CrmButton>
        ) : null}
      </div>

      {picked.length > 0 ? (
        <>
          {needsReason ? (
            <RefusalReasonField
              disabled={running !== null}
              id="place-check-bulk-reason"
              kind={kind}
              onChange={(next) => {
                setReason(next);
                setArmed(null);
              }}
              value={reason}
            />
          ) : null}
          <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor="place-check-bulk-note">
            {VALIDATION_NOTE_LABEL}
          </label>
          <textarea
            className={crmTextareaClassName}
            disabled={running !== null}
            id="place-check-bulk-note"
            maxLength={500}
            onChange={(event) => {
              setNote(event.target.value);
              setArmed(null);
            }}
            rows={2}
            value={note}
          />
          <RefusalNoteHint />
          <div className="grid gap-2 sm:grid-cols-2">
            {actions.map((action) => {
              const targets = picked.filter(action.takes);
              const held = action.needsReason && reason === "";
              return (
                <CrmButton
                  disabled={running !== null || targets.length === 0 || held}
                  key={action.key}
                  onClick={() => void run(action)}
                  variant={action.variant}
                >
                  {running === action.key
                    ? `${action.busyLabel} ${done} of ${targets.length}…`
                    : armed === action.key
                      ? `Yes, ${action.label.toLowerCase()} ${targets.length}`
                      : `${action.label} (${targets.length})`}
                </CrmButton>
              );
            })}
          </div>
          {actions.map((action) =>
            armed === action.key && action.warning ? (
              <CrmNote key={action.key} tone="warn">
                {action.warning(picked.filter(action.takes).length)}
              </CrmNote>
            ) : null,
          )}
          {needsReason && reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED}</p> : null}
          {failures.length > 0 ? (
            <CrmNote tone="bad">
              <span className="break-words">
                {failures.length === 1 ? "One was not answered" : `${failures.length} were not answered`}:{" "}
                {failures.map((failure) => `${failure.name} — ${failure.problem}`).join(" · ")}
              </span>
            </CrmNote>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
