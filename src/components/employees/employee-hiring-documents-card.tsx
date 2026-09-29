"use client";

import { useEffect, useState } from "react";

import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentStatus,
} from "@/lib/hiring-documents/types";

/**
 * One employee's hiring-document checklist, on their details panel.
 *
 * WHY IT IS HERE AT ALL. The Employee Master workbook already puts the checklist beside everything
 * else known about a person, so one row holds the lot (the owner's ask, 2026-09-29). This is the
 * same join on the screen somebody is actually looking at when they ask "is this person's file
 * complete?" — rather than making them download a spreadsheet to find out.
 *
 * IT RENDERS NOTHING WITHOUT THE GRANT, the same way `EmployeeCvManager` does. `employee_documents`
 * is a separate permission from `employees`, and plenty of people who may open this panel may not
 * see somebody's papers. A reader without it sees no heading, no empty state and no hint that a
 * section exists — an empty box would leak the fact that there is something here to be denied.
 *
 * IT IS READ-ONLY. Filing a document is done on the Hiring Documents screen, which owns the upload,
 * the scan pipeline and the audit row. Offering a tick-box here would be a second writer for the
 * same fact, and the sheet deliberately does not offer one either.
 */

type Props = { hrId: string };

type Payload = {
  documents?: HiringDocumentDefinition[];
  employee?: HiringDocumentEmployeeRow | null;
};

/** The words the checklist itself uses — never invent a third vocabulary for the same three states. */
const STATUS_LABEL: Record<HiringDocumentStatus, string> = {
  missing: "Missing",
  pending: "Pending",
  submitted: "Submitted",
};

const STATUS_TONE: Record<HiringDocumentStatus, string> = {
  missing: "text-[#B91C1C]",
  pending: "text-phx-ink-soft",
  submitted: "text-[#15803D]",
};

function fileCountLabel(count: number) {
  if (count === 0) return "no file";
  return `${count} file${count === 1 ? "" : "s"}`;
}

export function EmployeeHiringDocumentsCard({ hrId }: Props) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [permitted, setPermitted] = useState(true);
  const [loading, setLoading] = useState(true);

  // A promise chain rather than `void load()`: calling an async loader straight from an effect body
  // trips react-hooks/set-state-in-effect, which is an ERROR in this repo. Same shape as
  // EmployeeCvManager.
  useEffect(() => {
    let active = true;
    setLoading(true);

    fetch(`/api/hiring-documents?hrId=${encodeURIComponent(hrId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401 || response.status === 403) {
          setPermitted(false);
          return;
        }
        // 409 is the documented "schema is not ready" answer. It is not an error worth showing on
        // somebody's profile: the section simply is not there yet.
        if (!response.ok) return;
        const body = (await response.json().catch(() => ({}))) as Payload;
        if (active) setPayload(body);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hrId]);

  if (!permitted || loading) return null;

  const documents = payload?.documents ?? [];
  const employee = payload?.employee ?? null;
  // The checklist tracks the people Phoenix currently employs, so a leaver has no row. Rendering
  // "Missing" against every document for somebody nobody is chasing papers from would be a wall of
  // red that means nothing — the same reason the workbook leaves those cells blank.
  if (!employee || documents.length === 0) return null;

  const submitted = documents.filter(
    (document) => employee.documents[document.id]?.status === "submitted",
  ).length;

  return (
    <section className="rounded-2xl border border-phx-line bg-white p-4 shadow-sm transition-all hover:shadow-md hover:border-phx-line/80">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">
          Hiring Documents
        </h3>
        <span className="text-phx-xs font-semibold text-phx-ink-soft">
          {submitted} of {documents.length} submitted
        </span>
      </div>
      {/* A definition list that WRAPS, not a table: this panel is 680px at its widest and narrower
          on a phone, and the fits-the-screen rule forbids buying room with a horizontal scroll. */}
      <dl className="space-y-2">
        {documents.map((document) => {
          const entry = employee.documents[document.id];
          const status: HiringDocumentStatus = entry?.status ?? "pending";
          return (
            <div
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-phx-line/60 pb-2 last:border-0 last:pb-0"
              key={document.id}
            >
              <dt className="min-w-0 break-words text-sm text-phx-ink">{document.name}</dt>
              <dd className={`text-sm font-semibold ${STATUS_TONE[status]}`}>
                {STATUS_LABEL[status]}
                {/* The one combination worth a second look: the box is ticked and nothing is
                    attached, which means somebody filed it from memory. Said on submitted rows
                    only — "Pending · no file" would be noise on every untouched row. */}
                {status === "submitted" ? (
                  <span className="font-normal text-phx-ink-soft"> · {fileCountLabel(entry?.fileCount ?? 0)}</span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
