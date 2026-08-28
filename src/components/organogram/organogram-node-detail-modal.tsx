"use client";

import { Building2, Loader2, Lock, UserRound, X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { formatDateOnly } from "@/lib/date-only";
import type {
  OrganogramDetailSection,
  OrganogramEmployeeDetail,
} from "@/lib/reports/organogram-employee-detail";
import type { OrganogramRow } from "@/lib/reports/organogram-view-model";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

type Props = {
  row: OrganogramRow;
  onClose: () => void;
};

function initials(name: string | null | undefined) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

function formatHireDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

function SectionGrid({ section }: { section: OrganogramDetailSection }) {
  // A section with nothing but empty values would be a wall of "—"; skip it.
  const populated = section.items.filter((item) => item.value);
  if (populated.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">
        {section.title}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {section.items.map((item) => (
          <div className="flex flex-col gap-0.5" key={item.label}>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {item.label}
            </dt>
            <dd className="whitespace-normal break-words text-[13px] font-semibold text-slate-800">
              {item.value ?? "—"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Vacancy nodes carry no employee record — everything worth showing is already on
// the row, so this renders without a network round-trip.
function VacancyBody({ row }: { row: OrganogramRow }) {
  const items: Array<{ label: string; value: string | null }> = [
    { label: "Position", value: row.positionTitle ?? row.jobTitle ?? null },
    { label: "Line", value: row.lineName },
    { label: "Area", value: row.areaName },
    { label: "Region", value: row.regionName },
    { label: "Team", value: row.teamName },
    { label: "Reports to", value: row.managerName },
    { label: "Status", value: row.status },
  ];
  return (
    <SectionGrid section={{ title: "Open vacancy", items }} />
  );
}

// Shown from the row alone — before the fetch resolves, and as the permanent
// fallback if it fails — so the popup is never empty.
function RowSummary({ row }: { row: OrganogramRow }) {
  const items: Array<{ label: string; value: string | null }> = [
    { label: "HR ID", value: row.hrId },
    { label: "Job title", value: row.positionTitle ?? row.jobTitle ?? null },
    { label: "Line", value: row.lineName },
    { label: "Area", value: row.areaName },
    { label: "Region", value: row.regionName },
    { label: "Team", value: row.teamName },
    { label: "Reports to", value: row.managerName },
    { label: "Hire date", value: row.hireDate ? formatHireDate(row.hireDate) : null },
  ];
  return <SectionGrid section={{ title: "Summary", items }} />;
}

export function OrganogramNodeDetailModal({ row, onClose }: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });
  const isVacancy = row.type === "vacancy";

  const [detail, setDetail] = React.useState<OrganogramEmployeeDetail | null>(null);
  const [loading, setLoading] = React.useState(!isVacancy);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isVacancy) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      // Reset inside the async body, not synchronously in the effect: the repo
      // lint rule (react-hooks/set-state-in-effect) forbids a setState call
      // directly in an effect body. Clearing detail also drops the previous
      // person when the popup is reused for another node without closing.
      setLoading(true);
      setError(null);
      setDetail(null);
      try {
        const response = await fetch(
          `/api/reports/organogram/employee/${encodeURIComponent(row.hrId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = await response.json();
        if (!active) return;
        if (!response.ok) {
          setError(payload?.message ?? "Unable to load this person's details.");
          return;
        }
        setDetail(payload as OrganogramEmployeeDetail);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("Unable to load this person's details.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [isVacancy, row.hrId]);

  if (typeof document === "undefined") return null;

  const heading = isVacancy ? "Open Vacancy" : formatEmployeeDisplayName(row.displayName);
  const subtitle = row.positionTitle ?? row.jobTitle ?? (isVacancy ? "Vacant seat" : null);

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div
        aria-label={`Details — ${heading}`}
        aria-modal="true"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]"
        ref={dialogRef}
        role="dialog"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-phx-line bg-gradient-to-br from-slate-800 to-slate-950 px-5 py-4 text-white">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[13px] font-black",
                isVacancy
                  ? "border border-dashed border-orange-300 bg-white/10 text-orange-200"
                  : "bg-white/10 text-white ring-1 ring-white/20",
              )}
            >
              {isVacancy ? <Building2 className="h-5 w-5" /> : initials(row.displayName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight">{heading}</p>
              {subtitle ? (
                <p className="mt-0.5 truncate text-[11px] font-medium text-orange-200">{subtitle}</p>
              ) : null}
              {!isVacancy ? (
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-300">{row.hrId}</p>
              ) : null}
            </div>
          </div>
          <button
            aria-label="Close"
            className="rounded-md p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-auto px-5 py-4">
          {isVacancy ? (
            <VacancyBody row={row} />
          ) : detail ? (
            <>
              {detail.sections.map((section) => (
                <SectionGrid key={section.title} section={section} />
              ))}
              {!detail.canViewSensitive ? (
                <p className="flex items-center gap-1.5 border-t border-slate-100 pt-3 text-[11px] font-medium text-slate-400">
                  <Lock className="h-3 w-3" />
                  Compensation and personal details are limited to HR, Finance, and executive roles.
                </p>
              ) : null}
            </>
          ) : (
            <>
              {/* Row-only summary is always shown; it is the fallback when the fetch fails. */}
              <RowSummary row={row} />
              {loading ? (
                <p className="flex items-center gap-2 text-[12px] text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading full profile…
                </p>
              ) : null}
              {error ? (
                <p className="flex items-center gap-1.5 border-t border-slate-100 pt-3 text-[11px] font-medium text-rose-600">
                  <UserRound className="h-3 w-3" />
                  {error}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
