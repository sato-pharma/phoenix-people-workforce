"use client";

import { useEffect, useState } from "react";

import type { ChangeHistoryEntry, ChangeHistoryField, ChangeHistoryPayload } from "@/lib/employees/change-history";

/**
 * One employee's change history, on their details panel: what changed, from what to what, who did
 * it, how it reached the database, and when (Cairo time).
 *
 * IT RENDERS NOTHING WITHOUT THE RIGHT TO SEE THIS PERSON, the same way the CV and hiring-document
 * cards do: the route answers 401/403 and this card draws no heading, so a refused reader learns
 * nothing about what exists. Pay is decided on the server (`changeHistoryIncludesMoney`); this card
 * never filters money itself, it only shows what it was sent.
 *
 * IT IS READ-ONLY. Both logs are append-only and written by database triggers alone.
 *
 * A LIST THAT WRAPS, NOT A TABLE: the panel is 680px at its widest and narrower on a phone, and the
 * fits-the-screen rule forbids buying room with a horizontal scroll.
 */

type Props = { hrId: string };

/** Entries shown before "Show all": the panel is one of several cards, not a log viewer. */
const FIRST_PAGE = 10;
/** A new record lists every field it was born with; past this many they fold away. */
const FIELDS_SHOWN_OPEN = 6;

function ValueText({ value }: { value: string | null }) {
  if (value === null) return <span className="italic text-phx-ink-faint">empty</span>;
  return (
    <span className="break-words" dir="auto">
      {value}
    </span>
  );
}

function FieldLine({ field, created }: { field: ChangeHistoryField; created: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-1 sm:grid-cols-[140px_1fr]">
      <dt className="text-xs font-medium text-phx-ink-faint">{field.label}</dt>
      <dd className="min-w-0 text-sm text-phx-ink">
        {!field.kept ? (
          <span className="text-phx-ink-soft">Changed, value not kept</span>
        ) : created ? (
          <ValueText value={field.after} />
        ) : (
          <>
            <ValueText value={field.before} />
            <span aria-hidden="true" className="px-1.5 text-phx-ink-faint">
              →
            </span>
            <span className="sr-only"> changed to </span>
            <span className="font-semibold">
              <ValueText value={field.after} />
            </span>
          </>
        )}
      </dd>
    </div>
  );
}

function EntryItem({ entry }: { entry: ChangeHistoryEntry }) {
  const created = entry.kind === "created";
  const open = entry.fields.slice(0, created ? FIELDS_SHOWN_OPEN : entry.fields.length);
  const folded = entry.fields.slice(open.length);
  return (
    <li className="border-b border-phx-line/60 py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-phx-ink">{entry.atLabel}</span>
        {entry.log === "salary" ? (
          <span className="border border-[#0EA5E9]/40 px-1.5 text-phx-xs font-semibold uppercase tracking-wider text-[#0369A1]">
            Salary
          </span>
        ) : null}
        {created ? (
          <span className="border border-phx-line px-1.5 text-phx-xs font-semibold uppercase tracking-wider text-phx-ink-2">
            Record created
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 break-words text-xs text-phx-ink-soft">
        <span className="font-medium text-phx-ink-2" dir="auto">
          {entry.who}
        </span>
        {" · "}
        {entry.how}
      </p>
      <dl className="mt-2">
        {open.map((field) => (
          <FieldLine created={created} field={field} key={field.field} />
        ))}
      </dl>
      {folded.length ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-semibold text-phx-ink-2">
            {folded.length} more field{folded.length === 1 ? "" : "s"}
          </summary>
          <dl className="mt-1">
            {folded.map((field) => (
              <FieldLine created={created} field={field} key={field.field} />
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

export function EmployeeChangeHistoryCard({ hrId }: Props) {
  const [payload, setPayload] = useState<ChangeHistoryPayload | null>(null);
  const [permitted, setPermitted] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  // A promise chain, not `void load()`, and nothing resets `loading` in the effect body: both are the
  // react-hooks/set-state-in-effect rule, and the panel mounts this with `key={history-<hrId>}`, so a
  // different employee starts fresh anyway. Same shape as EmployeeHiringDocumentsCard.
  useEffect(() => {
    let active = true;

    fetch(`/api/employees/${encodeURIComponent(hrId)}/change-history`, { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401 || response.status === 403) {
          setPermitted(false);
          return;
        }
        if (!response.ok) {
          setFailed(true);
          return;
        }
        const body = (await response.json().catch(() => null)) as ChangeHistoryPayload | null;
        if (!active) return;
        if (!body || !Array.isArray(body.entries)) {
          setFailed(true);
          return;
        }
        setPayload(body);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hrId]);

  if (!permitted || loading) return null;

  const entries = payload?.entries ?? [];
  const shown = showAll ? entries : entries.slice(0, FIRST_PAGE);

  return (
    <section className="border border-phx-line bg-white p-4 shadow-sm" data-testid="employee-change-history">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="h-1.5 w-1.5 bg-[#475569]" />
        <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Change History</h3>
        {payload ? (
          <span className="text-phx-xs font-semibold text-phx-ink-soft">
            {payload.truncated
              ? `the newest ${entries.length} changes`
              : `${entries.length} change${entries.length === 1 ? "" : "s"}`}
          </span>
        ) : null}
      </div>
      {failed ? (
        // A failed read says so in amber; it is never drawn as "no changes".
        <p className="text-sm font-medium text-[#B45309]">The change history could not be read. Try again later.</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-phx-ink-soft">No changes recorded since the history began on 13 Nov 2026.</p>
      ) : (
        <>
          <ol>
            {shown.map((entry) => (
              <EntryItem entry={entry} key={entry.id} />
            ))}
          </ol>
          {entries.length > FIRST_PAGE ? (
            <button
              className="mt-3 text-xs font-semibold text-phx-ink-2 underline underline-offset-2 hover:text-phx-ink"
              onClick={() => setShowAll((value) => !value)}
              type="button"
            >
              {showAll ? "Show the newest 10" : `Show all ${entries.length}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
