/**
 * THE HIRE HAND-OFF BOARD ROWS, AS A PURE FUNCTION (REC-027, 2026-11-13).
 *
 * Same split as `seat-drift-items.ts`: `sources.ts` reaches the database, so the rows are built here
 * from plain data the adapter hands in, and this file's only runtime imports are the import-free
 * `./types` and `./item-fields`. The step's sentence arrives already written (the adapter takes it
 * from `hireHandoffStepProblems` in `src/lib/employees/hire-handoff.ts`), so nothing here imports the
 * ledger module either.
 *
 * ONE ITEM PER PERSON, never one per step: a hire whose login and mailbox task both failed is one
 * person to look at, and two rows about one joiner would read as two problems.
 *
 * 🔴 IT NEVER ACTS. The row names the person, says in plain English which step did not finish and
 * whether the hourly retry is still trying or has given up, and links to that person's own record on
 * Employee Master — like every other row on this board. The retry itself is the hourly job's, or the
 * permission-checked retry route's; never a button here.
 */

import { ageDaysSince, plural } from "./item-fields";
import { needsYouDestinations, type NeedsYouItem } from "./types";

/** One unfinished step, as the adapter hands it in — the name already resolved, never an HR id shown. */
export type HireHandoffBoardStep = {
  attempts: number;
  createdAt: string;
  /** Travels in the link only. */
  hrId: string;
  lastError: string | null;
  /** The employee's name, or null when it could not be read. */
  name: string | null;
  /** The step in plain English: "the portal login was not created". */
  problem: string;
  status: "failed" | "gave_up";
};

const SOURCE = "hire-handoff-gaps" as const;

function sentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * One row per new employee with a hand-off step that failed or was given up. `count` is null — a
 * person is not a quantity. `oldestAt` is when the oldest unfinished step was first recorded: the
 * moment of the hire, which is the honest age of the gap.
 */
export function hireHandoffItems(
  steps: readonly HireHandoffBoardStep[],
  now: Date,
  maxAttempts: number,
): NeedsYouItem[] {
  const byPerson = new Map<string, HireHandoffBoardStep[]>();
  for (const step of steps) {
    const key = step.hrId.trim().toLowerCase();
    if (!key) continue;
    const bucket = byPerson.get(key);
    if (bucket) bucket.push(step);
    else byPerson.set(key, [step]);
  }

  const items: NeedsYouItem[] = [];
  for (const [key, bucket] of byPerson) {
    const name = bucket.find((step) => step.name)?.name ?? "A new employee";
    const oldestAt = bucket.map((step) => step.createdAt).filter(Boolean).sort((a, b) => a.localeCompare(b))[0] ?? null;
    const gaveUp = bucket.filter((step) => step.status === "gave_up");
    const retrying = bucket.filter((step) => step.status === "failed");

    const note: string[] = [];
    if (gaveUp.length > 0) {
      note.push(
        `The hourly retry gave up on ${plural(gaveUp.length, "this step", "these steps")} after ${maxAttempts} attempts: `
        + `${sentence(gaveUp.map((step) => step.lastError ? `${step.problem} (${step.lastError})` : step.problem))}.`,
      );
    }
    if (retrying.length > 0) {
      note.push(
        `The hourly retry is still trying ${sentence(retrying.map((step) => `${step.problem} (attempt ${step.attempts} of ${maxAttempts})`))}.`,
      );
    }
    note.push("Open the record on Employee Master to finish it by hand, or wait for the next retry.");

    items.push({
      key: `${SOURCE}:${key}`,
      sourceId: SOURCE,
      kind: "flag",
      lane: "yours",
      label: `${name}: ${sentence(bucket.map((step) => step.problem))}`,
      count: null,
      people: [name],
      href: `${needsYouDestinations[SOURCE].href}?edit=${encodeURIComponent(bucket[0].hrId)}`,
      externalUrl: null,
      oldestAt,
      ageDays: ageDaysSince(oldestAt, now),
      // No SLA exists upstream for a hand-off; none is invented here.
      overdue: false,
      note: note.join(" "),
    });
  }
  return items;
}
