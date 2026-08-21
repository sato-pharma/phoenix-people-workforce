"use client";

import { useMemo, useState } from "react";

import type { ContactReviewRow } from "@/lib/recruitment/contact-review-service";

// Every moment this module shows a person is Cairo local time, never a raw UTC string. Written
// here, matching intake-health-view.tsx and recruitment-workspace.tsx, rather than imported across
// a domain boundary.
function cairoDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

function sourceLabel(source: string | null): string {
  if (source === "whatsapp") return "WhatsApp";
  if (source === "email") return "Email";
  return source ?? "—";
}

function StatTile({ hint, label, value }: { hint?: string; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** A proposed value with the AI's own hedge beside it, so "low" is never mistaken for a fact. */
function Proposed({ confidence, value }: { confidence: "high" | "low"; value: string | null }) {
  if (!value) return <span className="text-slate-300">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="font-medium text-slate-800">{value}</span>
      {confidence === "low" ? (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
          Check
        </span>
      ) : null}
    </span>
  );
}

/**
 * The unreachable pool, and what their own CVs say about how to reach them.
 *
 * The list is a queue only in the sense that it is derived: a candidate leaves it the moment their
 * column stops being blank, so accepting a row simply drops it. Nothing here is stored, so nothing
 * here can go stale.
 */
export function ContactReviewView({ rows: initialRows }: { rows: ContactReviewRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ applied: number; skipped: string[]; failed: string[] } | null>(null);

  const highConfidenceCount = useMemo(
    () =>
      rows.filter((row) => row.proposal.email?.confidence === "high" || row.proposal.phone?.confidence === "high")
        .length,
    [rows],
  );

  async function accept(candidateIds: string[], highConfidenceOnly: boolean, busyKey: string) {
    setBusy(busyKey);
    setError(null);
    setReport(null);
    try {
      const response = await fetch("/api/recruitment/candidates/contact-review", {
        body: JSON.stringify({ candidateIds, highConfidenceOnly }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        message?: string;
        result?: {
          applied: Array<{ candidateId: string }>;
          failed: Array<{ candidateId: string; reason: string }>;
          skipped: Array<{ candidateId: string; reason: string }>;
        };
      };
      if (!response.ok || !payload.result) {
        setError(payload.message ?? "Could not save those contact details.");
        return;
      }
      const result = payload.result;
      const appliedIds = new Set(result.applied.map((entry) => entry.candidateId));
      const nameFor = (id: string) => rows.find((row) => row.candidateId === id)?.name ?? id;
      // Everything not applied is reported with its reason. A count that quietly shrinks is how a
      // partial run gets read as a complete one.
      setReport({
        applied: result.applied.length,
        failed: result.failed.map((entry) => `${nameFor(entry.candidateId)} — ${entry.reason}`),
        skipped: result.skipped.map((entry) => `${nameFor(entry.candidateId)} — ${entry.reason}`),
      });
      setRows((previous) => previous.filter((row) => !appliedIds.has(row.candidateId)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save those contact details.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile hint="Their CV holds an email or a phone" label="Awaiting review" value={String(rows.length)} />
        <StatTile
          hint="Safe to accept without opening the CV"
          label="High confidence"
          value={String(highConfidenceCount)}
        />
        <StatTile
          hint="A reading the AI was unsure of"
          label="Needs a look"
          value={String(rows.length - highConfidenceCount)}
        />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Contact details found in CVs</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              These candidates have no email or phone on record, but their own CV does. Accepting fills only the blank
              column — nothing already on the record is ever overwritten.
            </p>
          </div>
          <button
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy !== null || highConfidenceCount === 0}
            onClick={() => accept(rows.map((row) => row.candidateId), true, "__bulk__")}
            type="button"
          >
            {busy === "__bulk__" ? "Accepting…" : `Accept ${highConfidenceCount} high-confidence`}
          </button>
        </div>

        {error ? (
          <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        ) : null}

        {report ? (
          <div className="mt-3 space-y-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
            <p className="font-medium text-slate-800">
              {report.applied} candidate{report.applied === 1 ? "" : "s"} updated.
            </p>
            {report.skipped.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Left for a human ({report.skipped.length})
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                  {report.skipped.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {report.failed.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">
                  Could not save ({report.failed.length})
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-rose-700">
                  {report.failed.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            Nothing waiting — every candidate whose CV carries contact details already has them on record.
          </p>
        ) : (
          <>
            {/* Phone: one card per candidate. Four columns of addresses and numbers cannot fit a
                375px screen without either wrapping or truncating, and both are forbidden here. */}
            <div className="mt-4 divide-y divide-slate-100 md:hidden">
              {rows.map((row) => (
                <div className="py-3 first:pt-0" key={row.candidateId}>
                  <p className="text-sm font-semibold text-slate-800">{row.name}</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {sourceLabel(row.source)} · {cairoDate(row.createdAt)}
                  </p>
                  <dl className="mt-2 space-y-1 text-xs">
                    {row.proposal.email ? (
                      <div className="flex items-baseline gap-2">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Email</dt>
                        <dd className="min-w-0 overflow-x-auto">
                          <Proposed confidence={row.proposal.email.confidence} value={row.proposal.email.value} />
                        </dd>
                      </div>
                    ) : null}
                    {row.proposal.phone ? (
                      <div className="flex items-baseline gap-2">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Phone</dt>
                        <dd className="min-w-0 overflow-x-auto">
                          <Proposed confidence={row.proposal.phone.confidence} value={row.proposal.phone.value} />
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  <button
                    className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={() => accept([row.candidateId], false, row.candidateId)}
                    type="button"
                  >
                    {busy === row.candidateId ? "Accepting…" : "Accept"}
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 hidden overflow-x-auto md:block">
              <table className="w-full text-sm" data-portal-desktop-table>
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 font-medium">Candidate</th>
                    <th className="pb-2 font-medium">Source</th>
                    <th className="pb-2 font-medium">Email found</th>
                    <th className="pb-2 font-medium">Phone found</th>
                    <th className="pb-2 font-medium">Received</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr className="border-t border-slate-100 align-top" key={row.candidateId}>
                      <td className="py-2 whitespace-nowrap font-medium text-slate-800">{row.name}</td>
                      <td className="py-2 whitespace-nowrap text-slate-500">{sourceLabel(row.source)}</td>
                      <td className="py-2">
                        <Proposed
                          confidence={row.proposal.email?.confidence ?? "high"}
                          value={row.proposal.email?.value ?? null}
                        />
                      </td>
                      <td className="py-2">
                        <Proposed
                          confidence={row.proposal.phone?.confidence ?? "high"}
                          value={row.proposal.phone?.value ?? null}
                        />
                      </td>
                      <td className="py-2 whitespace-nowrap text-slate-500">{cairoDate(row.createdAt)}</td>
                      <td className="py-2 text-right">
                        <button
                          className="whitespace-nowrap rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => accept([row.candidateId], false, row.candidateId)}
                          type="button"
                        >
                          {busy === row.candidateId ? "Accepting…" : "Accept"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
