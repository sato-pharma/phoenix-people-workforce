"use client";

import { AlertTriangle, Mail, Phone, RefreshCw } from "lucide-react";
import * as React from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { CheckTile, FieldLabel, FormError } from "@/components/ui/form-kit";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import {
  HIRING_JOINER_NOTES_MAX,
  joinerPapersProgress,
  type JoinerPapersProgress,
} from "@/lib/hiring-documents/joiners-logic";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringJoiner,
  HiringJoinersData,
} from "@/lib/hiring-documents/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { daysUntilLabel } from "@/lib/hr/talent-acquisition-logic";

type Draft = {
  attendanceDate: string;
  attendanceTime: string;
  notes: string;
  papersConfirmed: boolean;
};

type Props = {
  canManage: boolean;
  documents: HiringDocumentDefinition[];
  employees: HiringDocumentEmployeeRow[];
  onReceivePapers: (employeeHrId: string, documentId: string) => void;
};

type JoinersRead = { data: HiringJoinersData | null; error: string | null };

async function readJoiners(): Promise<JoinersRead> {
  const fallback = "The joiners list could not be read.";
  try {
    const response = await fetch("/api/hiring-documents/joiners", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as (HiringJoinersData & { message?: string }) | null;
    if (!response.ok || !body?.joiners) return { data: null, error: body?.message ?? fallback };
    return { data: body, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : fallback };
  }
}

function draftOf(joiner: HiringJoiner): Draft {
  return {
    attendanceDate: joiner.attendanceDate ?? "",
    attendanceTime: joiner.attendanceTime ?? "",
    notes: joiner.notes ?? "",
    papersConfirmed: joiner.papersConfirmed,
  };
}

function formatDay(key: string): string {
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return stableEnGbFormatter({
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

const headerClassName =
  "bg-phx-accent-soft px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft";
const cellClassName = "border-b border-phx-line px-3 py-4 align-top";

/**
 * WHO IS ARRIVING, AND WHAT WAS AGREED WITH THEM (owner, 2026-11-02: "Contact the joiner, confirm
 * papers and attendance time"). The accepted offers from today on, each with the joiner's mobile and
 * email, how far their papers have come, and the day and time HR agreed.
 *
 * It sends nothing: the mobile and the email are links that open the viewer's own phone and mail app.
 * A failed read says so and offers a retry, never "nobody is joining".
 */
export function HiringJoinersPanel({ canManage, documents, employees, onReceivePapers }: Props) {
  const [data, setData] = React.useState<HiringJoinersData | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<{ message: string; offerId: string } | null>(null);
  const [savedId, setSavedId] = React.useState<string | null>(null);

  const accept = React.useCallback((next: HiringJoinersData) => {
    setData(next);
    setDrafts(Object.fromEntries(next.joiners.map((joiner) => [joiner.offerId, draftOf(joiner)])));
  }, []);

  const applyRead = React.useCallback(
    (result: JoinersRead) => {
      if (result.data) accept(result.data);
      setLoadError(result.error);
      setIsLoading(false);
    },
    [accept],
  );

  React.useEffect(() => {
    void readJoiners().then(applyRead);
  }, [applyRead]);

  const employeeByKey = React.useMemo(
    () => new Map(employees.map((employee) => [canonicalHrIdKey(employee.hrId) ?? employee.hrId, employee])),
    [employees],
  );

  function setDraft(offerId: string, patch: Partial<Draft>) {
    setSavedId(null);
    setDrafts((current) => ({ ...current, [offerId]: { ...current[offerId]!, ...patch } }));
  }

  async function save(joiner: HiringJoiner) {
    const draft = drafts[joiner.offerId];
    if (!canManage || !draft) return;
    setBusyId(joiner.offerId);
    setRowError(null);
    setSavedId(null);
    try {
      const response = await fetch("/api/hiring-documents/joiners", {
        body: JSON.stringify({
          attendanceDate: draft.attendanceDate || null,
          attendanceTime: draft.attendanceTime || null,
          notes: draft.notes || null,
          offerId: joiner.offerId,
          papersConfirmed: draft.papersConfirmed,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const body = (await response.json().catch(() => null)) as (HiringJoinersData & { message?: string }) | null;
      if (!response.ok || !body?.joiners) throw new Error(body?.message ?? "That could not be saved. Try again.");
      accept(body);
      setSavedId(joiner.offerId);
    } catch (error) {
      setRowError({
        message: error instanceof Error ? error.message : "That could not be saved. Try again.",
        offerId: joiner.offerId,
      });
    } finally {
      setBusyId(null);
    }
  }

  function renderPeople(joiner: HiringJoiner) {
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink">{joiner.name}</p>
        {joiner.title ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{joiner.title}</p> : null}
        {joiner.territory ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">{joiner.territory}</p> : null}
      </>
    );
  }

  function renderContact(joiner: HiringJoiner) {
    return (
      <div className="space-y-1.5 text-phx-xs font-semibold">
        {joiner.mobile ? (
          <a className="flex items-center gap-1.5 text-phx-accent hover:underline" dir="ltr" href={`tel:${joiner.mobile}`}>
            <Phone className="h-3.5 w-3.5 shrink-0" />
            {joiner.mobile}
          </a>
        ) : (
          <p className="text-phx-ink-faint">No mobile on file</p>
        )}
        {joiner.email ? (
          <a className="flex items-start gap-1.5 break-all text-phx-accent hover:underline" href={`mailto:${joiner.email}`}>
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {joiner.email}
          </a>
        ) : (
          <p className="text-phx-ink-faint">No email on file</p>
        )}
      </div>
    );
  }

  function renderPapers(joiner: HiringJoiner) {
    if (!joiner.employeeHrId) {
      return <p className="text-phx-xs font-semibold text-phx-ink-soft">Papers can be received once the joining form creates the record.</p>;
    }
    const employee = employeeByKey.get(canonicalHrIdKey(joiner.employeeHrId) ?? joiner.employeeHrId);
    if (!employee) {
      return <p className="text-phx-xs font-semibold text-phx-ink-soft">Not on the checklist yet.</p>;
    }
    const progress: JoinerPapersProgress = joinerPapersProgress(documents, employee);
    return (
      <div className="space-y-2">
        <p className="text-sm font-black tabular-nums text-phx-ink">
          {progress.received} of {progress.total}
          <span className="ml-1 text-phx-xs font-semibold text-phx-ink-soft">received</span>
        </p>
        {canManage && progress.firstOutstandingId ? (
          <Button
            className="h-9"
            onClick={() => onReceivePapers(employee.hrId, progress.firstOutstandingId as string)}
            variant="secondary"
          >
            Receive papers
          </Button>
        ) : null}
      </div>
    );
  }

  function renderForm(joiner: HiringJoiner, draft: Draft, idPrefix: string) {
    const busy = busyId === joiner.offerId;
    return (
      <div className="space-y-3">
        <CheckTile
          checked={draft.papersConfirmed}
          onChange={(next) => {
            if (canManage) setDraft(joiner.offerId, { papersConfirmed: next });
          }}
        >
          Papers confirmed
        </CheckTile>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor={`${idPrefix}-date-${joiner.offerId}`}>Attendance date</FieldLabel>
            <Input
              disabled={!canManage || busy}
              id={`${idPrefix}-date-${joiner.offerId}`}
              onChange={(event) => setDraft(joiner.offerId, { attendanceDate: event.target.value })}
              type="date"
              value={draft.attendanceDate}
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${idPrefix}-time-${joiner.offerId}`}>Attendance time</FieldLabel>
            <Input
              disabled={!canManage || busy}
              id={`${idPrefix}-time-${joiner.offerId}`}
              onChange={(event) => setDraft(joiner.offerId, { attendanceTime: event.target.value })}
              type="time"
              value={draft.attendanceTime}
            />
          </div>
        </div>
        <div>
          <FieldLabel htmlFor={`${idPrefix}-note-${joiner.offerId}`}>Note</FieldLabel>
          <textarea
            className={phxTextareaClassName}
            disabled={!canManage || busy}
            id={`${idPrefix}-note-${joiner.offerId}`}
            maxLength={HIRING_JOINER_NOTES_MAX}
            onChange={(event) => setDraft(joiner.offerId, { notes: event.target.value })}
            rows={2}
            value={draft.notes}
          />
        </div>
        {rowError?.offerId === joiner.offerId ? <FormError>{rowError.message}</FormError> : null}
        <div className="flex flex-wrap items-center gap-3">
          {canManage ? (
            <Button className="h-10" disabled={busy} onClick={() => void save(joiner)}>
              {busy ? "Saving" : "Save"}
            </Button>
          ) : null}
          <p className="text-phx-xs font-semibold text-phx-ink-soft">
            {savedId === joiner.offerId ? "Saved. " : ""}
            {joiner.updatedAt
              ? `Last saved ${formatSavedAt(joiner.updatedAt)}${joiner.updatedByName ? ` by ${joiner.updatedByName}` : ""}`
              : "Nothing recorded yet"}
          </p>
        </div>
      </div>
    );
  }

  const joiners = data?.joiners ?? [];
  const todayKey = data?.todayKey ?? "";

  return (
    <AdminTableShell
      description="Everyone with an accepted offer who starts today or later. Contact them, confirm their papers and the time they attend."
      title="Joiners arriving"
    >
      {isLoading ? <p className="p-4 text-sm font-semibold text-phx-ink-soft">Loading the joiners.</p> : null}

      {!isLoading && loadError ? (
        <div className="p-4">
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
            <div>
              <h3 className="text-sm font-bold text-[#B91C1C]">The joiners list could not be read</h3>
              <p className="mt-1 text-sm text-[#991B1B]">{loadError}</p>
              <Button
                className="mt-3 h-9 gap-2"
                onClick={() => {
                  setIsLoading(true);
                  void readJoiners().then(applyRead);
                }}
                variant="secondary"
              >
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
            </div>
          </AdminCallout>
        </div>
      ) : null}

      {!isLoading && !loadError && joiners.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">Nobody with an accepted offer starts today or later.</p>
      ) : null}

      {!isLoading && !loadError && joiners.length > 0 ? (
        <>
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[22%]" />
                <col className="w-[11%]" />
                <col className="w-[13%]" />
                <col className="w-[34%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Joiner</th>
                  <th className={headerClassName}>Contact</th>
                  <th className={headerClassName}>Starts</th>
                  <th className={headerClassName}>Papers</th>
                  <th className={headerClassName}>Confirmed with them</th>
                </tr>
              </thead>
              <tbody>
                {joiners.map((joiner) => {
                  const draft = drafts[joiner.offerId];
                  return (
                    <tr key={joiner.offerId}>
                      <td className={cellClassName}>{renderPeople(joiner)}</td>
                      <td className={cellClassName}>{renderContact(joiner)}</td>
                      <td className={cellClassName}>
                        <p className="text-sm font-black text-phx-ink">{formatDay(joiner.startKey)}</p>
                        <p className="text-phx-xs font-semibold text-phx-ink-soft">{daysUntilLabel(todayKey, joiner.startKey)}</p>
                      </td>
                      <td className={cellClassName}>{renderPapers(joiner)}</td>
                      <td className={cellClassName}>{draft ? renderForm(joiner, draft, "joiner-desktop") : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 lg:hidden">
            {joiners.map((joiner) => {
              const draft = drafts[joiner.offerId];
              return (
                <div className="space-y-3 border border-phx-line bg-white p-4" key={joiner.offerId}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">{renderPeople(joiner)}</div>
                    <div className="text-right">
                      <p className="text-sm font-black text-phx-ink">{formatDay(joiner.startKey)}</p>
                      <p className="text-phx-xs font-semibold text-phx-ink-soft">{daysUntilLabel(todayKey, joiner.startKey)}</p>
                    </div>
                  </div>
                  {renderContact(joiner)}
                  {renderPapers(joiner)}
                  {draft ? renderForm(joiner, draft, "joiner-mobile") : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </AdminTableShell>
  );
}
