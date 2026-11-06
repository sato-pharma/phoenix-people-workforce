"use client";

import { Building2, Download, FileText, Loader2, Lock, Pencil, UserMinus, UserPlus, UserRound, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { formatDateOnly } from "@/lib/date-only";
// employee-cv-limits, NOT employee-cv: the server module pulls in node:crypto and the
// service-role client, and importing either into this client bundle is a webpack build error.
import {
  CV_EMPTY_NOTICE,
  type CvNoticeState,
  employeeCvHref,
  resolveCvNoticeState,
} from "@/lib/employees/employee-cv-limits";
import { buildEmployeeMasterHref, employeeMasterBasePath } from "@/lib/employees/employee-master-link";
import { buildSeatHireHref } from "@/lib/employees/vacancy-hire-link";
import type {
  OrganogramDetailSection,
  OrganogramEmployeeDetail,
} from "@/lib/reports/organogram-employee-detail";
import type { OrganogramRow } from "@/lib/reports/organogram-view-model";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

type Props = {
  row: OrganogramRow;
  onClose: () => void;
  /**
   * Whether this viewer may create an employee — the same `employees:update` that POST
   * /api/employees asserts and that the Add Employee form's Save needs. Resolved
   * server-side on the page and threaded down: offering the button to a viewer the API
   * would refuse is a dead end, and the organogram is readable by roles that cannot hire.
   *
   * It also decides the Edit and Resign buttons on a PERSON's popup — the same two the tile
   * carries — since changing a record is that same `employees:update`. The chart passes false for
   * a past-month picture, which takes all three away at once.
   */
  canAddEmployee?: boolean;
  /**
   * Whether this viewer may read anybody's CV — `canDownloadEmployeeCv`, resolved server-side on the
   * page. False skips the person popup's `?meta=1` CV probe altogether: the CV route refuses every
   * other role, so the probe answered a 403 for each person a Training Manager opened (18 refusals in
   * the 31 Oct 2026 System Audit digest) and the popup showed nothing either way. Absent means "ask
   * the route", the behaviour before this prop.
   */
  canReadEmployeeCv?: boolean;
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
      <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-600">
        {section.title}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {section.items.map((item) => (
          <div className="flex flex-col gap-0.5" key={item.label}>
            <dt className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">
              {item.label}
            </dt>
            <dd className="whitespace-normal break-words text-phx-md font-semibold text-slate-800">
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
    // employeeTeamName resolves from the employee's team LINK; row.teamName is the SEAT's team,
    // which the seat path leaves null on purpose because it feeds chart classification.
    { label: "Team", value: row.employeeTeamName ?? row.teamName },
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
    // employeeTeamName resolves from the employee's team LINK; row.teamName is the SEAT's team,
    // which the seat path leaves null on purpose because it feeds chart classification.
    { label: "Team", value: row.employeeTeamName ?? row.teamName },
    { label: "Reports to", value: row.managerName },
    { label: "Hire date", value: row.hireDate ? formatHireDate(row.hireDate) : null },
  ];
  return <SectionGrid section={{ title: "Summary", items }} />;
}

export function OrganogramNodeDetailModal({ row, onClose, canAddEmployee = false, canReadEmployeeCv = true }: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });
  const pathname = usePathname();
  const isVacancy = row.type === "vacancy";

  // Derived from where we already are rather than passed down as another prop — the chart
  // renders in both shells and each has its own Employees route (the same trick the
  // recruitment hub uses for its own way out to Add Employee).
  //
  // When this seat already has an ACCEPTED offer out against it (the "Offer accepted — …" label
  // the vacancy body shows), the hire routes to that offer's prefill so the candidate's name,
  // salary and Employee ID arrive filled — rather than the seat-only prefill, which left those
  // blank and made the form refuse to save.
  const masterBasePath = employeeMasterBasePath(pathname);
  const hireHref = buildSeatHireHref(masterBasePath, row, row.pendingOffer);

  const [detail, setDetail] = React.useState<OrganogramEmployeeDetail | null>(null);
  const [loading, setLoading] = React.useState(!isVacancy);
  const [error, setError] = React.useState<string | null>(null);
  // What this viewer is told about the person's CV. The ?meta=1 probe answers two questions at
  // once — may this viewer read a CV at all (the CV route gates on the named
  // employeeCvReaderRoles set: Super Admin, SFE Manager, the two HR seats, and 401/403s everyone
  // else — a viewer the page already knows is outside it never sends the probe), and is there a file on this person's master record — so the three
  // answers are three different things to show, NOT one boolean:
  //
  //   "probing"  the answer has not come back yet, or the probe failed/aborted — show nothing.
  //              Never "No CV on file": that is a claim about the record, and a network failure
  //              is not evidence for it.
  //   "ready"    a file is on record and this viewer may have it — show the CV download.
  //   "empty"    this viewer may read CVs and there is NOTHING on record — show the greyed
  //              "No CV on file" notice. Owner's decision, 2026-09-29: a seat that simply
  //              rendered no control read as "the feature isn't there", and only 9 of 198 people
  //              on production carry a CV, so the silent state was the one almost everybody saw.
  //   "forbidden" this viewer may not read anybody's CV — show nothing at all. He is not missing
  //              a file, so telling him a record is empty would be noise about a door that is
  //              shut to him either way.
  const [cvState, setCvState] = React.useState<CvNoticeState>(canReadEmployeeCv ? "probing" : "forbidden");

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

  // Separate, lightweight probe for the CV. The reset lives inside the async body, not
  // directly in the effect (react-hooks/set-state-in-effect forbids a synchronous setState
  // there — the same reason the detail effect above resets inside its own async body). The
  // reset also drops the previous person's answer when the popup is reused for another node
  // without closing.
  React.useEffect(() => {
    if (isVacancy || !canReadEmployeeCv) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      setCvState("probing");
      try {
        const response = await fetch(`${employeeCvHref(row.hrId)}?meta=1`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = response.ok
          ? ((await response.json().catch(() => ({}))) as { cv?: unknown })
          : {};
        if (!active) return;
        // The whole decision lives in resolveCvNoticeState, beside the wording it selects and
        // under test — not inline here, where the rule "only a 200 may claim the record is
        // empty" would be one edit away from becoming `!cv` again.
        setCvState(
          resolveCvNoticeState({
            hasCv: Boolean(payload?.cv),
            ok: response.ok,
            status: response.status,
          }),
        );
      } catch {
        // Aborted or offline — stay in "probing", which shows nothing.
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [canReadEmployeeCv, isVacancy, row.hrId]);

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
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-phx-md font-black",
                isVacancy
                  ? "border border-dashed border-orange-300 bg-white/10 text-orange-200"
                  : "bg-white/10 text-white ring-1 ring-white/20",
              )}
            >
              {isVacancy ? <Building2 className="h-5 w-5" /> : initials(row.displayName)}
            </span>
            <div className="min-w-0">
              <p className="break-words text-sm font-bold leading-tight">{heading}</p>
              {subtitle ? (
                <p className="mt-0.5 break-words text-phx-xs font-medium text-orange-200">{subtitle}</p>
              ) : null}
              {!isVacancy ? (
                <p className="mt-0.5 break-words font-mono text-phx-2xs text-slate-300">{row.hrId}</p>
              ) : null}
            </div>
          </div>
          {/* NO shrink-0 on this cluster, and min-w-0 on it: "No CV on file" is far wider than the
              icon-plus-word controls beside it, and a shrink-0 parent makes an inner flex-wrap
              INERT (it never shrinks below max-content, so nothing ever needs to wrap) — which at
              375px squeezed the person's own name into the gap that was left. Shrinkable + wrap
              lets the controls drop to a second row instead, which is what the fits-the-screen
              golden rule asks for: fit by wrapping, never a horizontal scroll. The close button
              keeps its own shrink-0 so it stays put on the first row. */}
          <div className="flex min-w-0 items-start gap-1">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
              {/* Employees only — a vacancy carries no record to file. The link goes to the PDF
                  route, which re-derives this viewer's exact sections server-side, so the download
                  can never reveal a field the popup itself withheld. `download` keeps the browser
                  on this page. */}
              {!isVacancy ? (
                <a
                  aria-label={`Download ${heading}'s record as PDF`}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-phx-xs font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
                  download
                  href={`/api/reports/organogram/employee/${encodeURIComponent(row.hrId)}/pdf`}
                >
                  <Download className="h-4 w-4" />
                  PDF
                </a>
              ) : null}
              {/* The person's actual CV, from their master record. Shown only once the probe
                  confirms a file is on record AND this viewer may read it (the SFE Manager is
                  the whole reason this control exists — see the CV route). `download` keeps the
                  browser on this page; the route streams the file as an attachment. */}
              {!isVacancy && cvState === "ready" ? (
                <a
                  aria-label={`Download ${heading}'s CV`}
                  // No radius class: this modal portals to document.body, outside the shell sweeps
                  // that would square a rounded corner, so a `rounded-*` here renders genuinely
                  // rounded and breaks the square-edge golden rule
                  // (tests/square-edge-portal-ratchet).
                  className="flex items-center gap-1.5 px-2 py-1 text-phx-xs font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
                  download
                  href={employeeCvHref(row.hrId)}
                >
                  <FileText className="h-4 w-4" />
                  CV
                </a>
              ) : null}
              {/* The same slot, greyed, when this viewer MAY read a CV and the record holds none —
                  so an SFE opening a seat learns the file is missing instead of finding a header
                  that looks exactly like one with the feature switched off. Not a button: there is
                  nothing to press. No radius class, for the portal reason above. */}
              {!isVacancy && cvState === "empty" ? (
                <span className="flex items-center gap-1.5 px-2 py-1 text-phx-xs font-semibold text-white/50">
                  <FileText className="h-4 w-4" />
                  {CV_EMPTY_NOTICE}
                </span>
              ) : null}
            </div>
            <button
              aria-label="Close"
              className="shrink-0 rounded-md p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
              onClick={onClose}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-auto px-5 py-4">
          {isVacancy ? (
            <>
              <VacancyBody row={row} />
              {/* The one thing anybody wants to do with an open seat. It carries the line,
                  area, department, position and manager this popup is already showing into
                  the Add Employee form, so nobody retypes what the box just told them.
                  It is a PRE-FILL: the employee is still created by that form, and the seat
                  itself is still matched server-side by the vacancy-autofill chain. */}
              {canAddEmployee ? (
                <a
                  className="flex w-full items-center justify-center gap-2 border border-orange-500 bg-orange-500 px-4 py-2.5 text-phx-sm font-bold text-white transition hover:bg-orange-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
                  href={hireHref}
                >
                  <UserPlus className="h-4 w-4" />
                  Add employee to this seat
                </a>
              ) : null}
            </>
          ) : detail ? (
            <>
              {detail.sections.map((section) => (
                <SectionGrid key={section.title} section={section} />
              ))}
              {!detail.canViewSensitive ? (
                <p className="flex items-center gap-1.5 border-t border-slate-100 pt-3 text-phx-xs font-medium text-slate-400">
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
                <p className="flex items-center gap-2 text-phx-sm text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading full profile…
                </p>
              ) : null}
              {error ? (
                <p className="flex items-center gap-1.5 border-t border-slate-100 pt-3 text-phx-xs font-medium text-rose-600">
                  <UserRound className="h-3 w-3" />
                  {error}
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* The same two ways into Employee Master as the buttons on the person's tile, kept outside
            the scrolling body so they stay reachable however long the profile runs. Plain links:
            Employee Master owns both forms, and the resignation still goes through the one
            endpoint that checks this viewer's scope and opens the vacancy. No radius class — this
            modal portals to document.body, outside the shell's square-edge sweep. */}
        {!isVacancy && canAddEmployee && row.hrId ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-phx-line bg-slate-50 px-5 py-3">
            <Link
              className="inline-flex items-center gap-2 border border-orange-500 bg-orange-500 px-4 py-2 text-phx-sm font-bold text-white transition hover:bg-orange-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
              href={buildEmployeeMasterHref(masterBasePath, "edit", row.hrId)}
            >
              <Pencil className="h-4 w-4" />
              Edit in Employee Master
            </Link>
            <Link
              className="inline-flex items-center gap-2 border border-rose-300 bg-white px-4 py-2 text-phx-sm font-bold text-rose-600 transition hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
              href={buildEmployeeMasterHref(masterBasePath, "resign", row.hrId)}
            >
              <UserMinus className="h-4 w-4" />
              Resign
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
