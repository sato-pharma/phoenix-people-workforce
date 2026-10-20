"use client";

import * as React from "react";

import {
  PortalRecordCard,
  PortalRecordFields,
} from "@/components/employee-portal/portal-primitives";
import {
  RgBadge,
  RgButton,
  RgDialog,
  RgEmpty,
  RgField,
  RgHero,
  RgInput,
  RgNotice,
  RgPager,
  RgPanel,
  RgPerson,
  RgSelect,
  RgSplit,
  RgTable,
  RgTabs,
  RgTd,
  RgTh,
  RgTile,
} from "@/components/resignations/resignations-ui";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import {
  ALL_RESIGNATION_FILTER,
  buildPayrollCandidateExportRows,
  buildResignationExportRows,
  candidateSearchText,
  filterByLine,
  formatEgp,
  formatPayoutMonth,
  formatPayrollCandidateSystemId,
  formatResignationDate,
  isDeclinedOfferResignation,
  isTerminatedResignation,
  payrollCandidateExportColumns,
  recordSearchText,
  resignationActorLabel,
  resignationExportColumns,
  resignationLineOptions,
  resignationStatusLabel,
  selectClosedResignations,
  selectOpenResignations,
  selectOverdueResignations,
  type ResignationTabId,
} from "@/lib/resignations/view-model";
import { reportClientError } from "@/lib/error-monitor/report-client-error";
import { downloadXlsxExport } from "@/lib/export/download-xlsx-client";
import type {
  CreateResignationInput,
  PayrollResignationCandidateRecord,
  ResignationDashboardData,
  ResignationRecord,
  ResignationWorkflowAction,
} from "@/lib/resignations/types";

type Props = {
  /**
   * resignations:export, resolved on the server by the page. It only decides whether the "Export full
   * history" button renders — /api/resignations/export asserts the same permission itself.
   */
  canExportHistory?: boolean;
  /**
   * Whether the per-tab "Export" renders. That export is built in the browser from rows already on
   * screen, so no route stands behind it — the page decides. False for the HR Operations Specialist,
   * who exports nothing from Resignations (owner, 2026-10-20).
   */
  canExportTab?: boolean;
  /**
   * resignations:create, resolved on the server by the page. It only decides whether "New
   * resignation" renders — the HR Operations Specialist follows resignations the owner submits and
   * never starts one; POST /api/resignations asserts the same permission itself.
   */
  canCreate?: boolean;
  /**
   * resignations:approve, resolved on the server by the page. It decides whether Approve, Complete
   * and Reject render — POST /api/resignations/[id]/workflow asserts that same permission for all
   * three. Completing a resignation is the Super Admin's, like approving and rejecting it (owner,
   * 2026-10-20: "You press Complete"), so the HR Operations Specialist, who follows it through, is
   * never offered any of them.
   */
  canDecide?: boolean;
  /**
   * canChangeResignationDates, resolved on the server by the page. It decides whether "Dates"
   * renders — re-dating writes the leaver's last working day, which his final pay is computed from,
   * so the salary-blind seat is never offered it; PATCH /api/resignations/[id]/dates refuses her
   * itself.
   */
  canEditDates?: boolean;
  initialData: ResignationDashboardData | null;
  initialError: string | null;
  /** The portal route supplies its own page header, so it suppresses the hero. */
  surface?: "admin" | "portal";
};

const PAGE_SIZE = 20;

function newForm(): CreateResignationInput {
  return {
    effectiveDate: "",
    employeeHrId: "",
    reason: "",
    // Cairo, never a UTC slice — between midnight and ~2am Cairo they disagree and the form would
    // silently default to yesterday.
    submittedDate: currentCairoDateOnlyIso(),
    workflowNotes: "",
  };
}

export function ResignationsWorkspace({
  canExportHistory = false,
  canExportTab = true,
  canCreate = false,
  canDecide = false,
  canEditDates = false,
  initialData,
  initialError,
  surface = "admin",
}: Props) {
  const [data, setData] = React.useState<ResignationDashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<ResignationTabId>("action");
  const [query, setQuery] = React.useState("");
  const [line, setLine] = React.useState(ALL_RESIGNATION_FILTER);
  const [page, setPage] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState<CreateResignationInput>(newForm);
  const [rejecting, setRejecting] = React.useState<ResignationRecord | null>(null);
  const [rejectReason, setRejectReason] = React.useState("");
  const [editing, setEditing] = React.useState<ResignationRecord | null>(null);
  const [editDates, setEditDates] = React.useState({ effectiveDate: "", submittedDate: "" });

  const records = React.useMemo(() => data?.records ?? [], [data]);
  const candidates = React.useMemo(() => data?.payrollCandidates ?? [], [data]);
  const employees = data?.employees ?? [];
  // The server withheld every settlement figure for this seat (isSalaryBlindRole). The money
  // columns go, and one plain line says why — never a 0 or a dash that reads like "nothing owed".
  const settlementWithheld = data?.settlementWithheld === true;

  const search = query.trim().toLowerCase();
  const matches = (text: string) => !search || text.toLowerCase().includes(search);

  const open = React.useMemo(
    () =>
      filterByLine(selectOpenResignations(records), line)
        .filter((r) => matches(recordSearchText(r)))
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, line, search],
  );
  const history = React.useMemo(
    () =>
      filterByLine(selectClosedResignations(records), line)
        .filter((r) => matches(recordSearchText(r)))
        .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, line, search],
  );
  /**
   * Leavers on this page who still hold company devices.
   *
   * SURFACED HERE BECAUSE THIS IS WHERE SETTLEMENTS ARE READ. The custody receipt's return protocol
   * states that final dues are not paid before it is completed — «ولا يجوز صرف المستحقات النهائية
   * قبل استيفائه» — and البند (7) has the device returned «قبل استلام مستحقاتي النهائية». So the one
   * screen showing a "Due this month" figure is the screen that has to show what is outstanding
   * against it.
   *
   * A BANNER RATHER THAN AN EIGHTH COLUMN. The table already carries seven, and the owner's
   * fits-the-screen golden rule is measured, not guessed — adding a column here without measuring
   * this table at 669px is how a horizontal scroll gets shipped. The banner also groups by person,
   * which is the shape the question is actually asked in.
   *
   * IT IS A FLAG, NOT A BLOCK. Nothing here changes a settlement figure or stops one being paid.
   */
  const leaversHoldingDevices = React.useMemo(
    () =>
      records
        .filter((record) => (record.outstandingDevices?.length ?? 0) > 0)
        // One row per PERSON: a resignation can be recorded more than once for the same employee
        // over a career, and the devices are attached to the person, not to the paperwork.
        .filter(
          (record, index, all) =>
            all.findIndex(
              (other) =>
                String(other.employeeHrId ?? "").toLowerCase() ===
                String(record.employeeHrId ?? "").toLowerCase(),
            ) === index,
        ),
    [records],
  );

  const candidateRows = React.useMemo(
    () =>
      filterByLine(candidates, line)
        .filter((c) => matches(candidateSearchText(c)))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, line, search],
  );

  const overdueCount = React.useMemo(() => selectOverdueResignations(records).length, [records]);
  const lineOptions = React.useMemo(
    () => resignationLineOptions(records, candidates),
    [records, candidates],
  );

  const activeRows: Array<ResignationRecord | PayrollResignationCandidateRecord> =
    tab === "action" ? open : tab === "history" ? history : candidateRows;
  const pages = Math.max(1, Math.ceil(activeRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const slice = <T,>(rows: readonly T[]) =>
    rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  function switchTab(next: ResignationTabId) {
    setTab(next);
    setPage(0);
  }

  async function reload() {
    setBusy("reload");
    setError(null);
    try {
      const response = await fetch("/api/resignations", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to load resignations.");
        return;
      }
      setData(payload);
      setNotice(null);
    } catch {
      setError("Unable to load resignations.");
    } finally {
      setBusy(null);
    }
  }

  async function runAction(
    record: ResignationRecord,
    action: ResignationWorkflowAction,
    rejectedReason?: string,
  ) {
    setBusy(record.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/resignations/${encodeURIComponent(record.id)}/workflow`, {
        body: JSON.stringify({ action, rejectedReason }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Workflow action failed.");
        return;
      }
      setData(payload.dashboard);
      setNotice(`${record.employeeName} — ${payload.data.status.replace(/_/g, " ")}.`);
    } catch {
      setError("Unable to update the resignation.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * The workflow controls, rendered by BOTH the desktop row and the mobile card.
   *
   * A plain function rather than a nested component on purpose: called as `recordControls(...)`
   * it is inlined JSX, so it neither trips react/no-unstable-nested-components nor remounts the
   * buttons on every parent render. Sharing it is the point — these buttons approve, complete and
   * reject a real person's resignation, and two copies of them is how the phone half quietly ends
   * up one action behind the desktop half.
   */
  function recordControls(record: ResignationRecord, rowBusy: boolean) {
    if (tab === "history") {
      return <span className="text-phx-xs text-slate-400">{resignationActorLabel(record)}</span>;
    }
    // A seat with neither control (the HR Operations Specialist follows the record; the HR Manager
    // re-dates and decides it) gets the same quiet dash an empty cell carries elsewhere on this page.
    if (!canEditDates && !canDecide) return <span className="text-slate-300">—</span>;
    return (
      <span className="inline-flex flex-wrap justify-end gap-1">
        {canEditDates ? (
          <RgButton
            disabled={rowBusy}
            onClick={() => {
              setEditing(record);
              setEditDates({
                effectiveDate: record.effectiveDate,
                submittedDate: record.submittedDate,
              });
            }}
          >
            Dates
          </RgButton>
        ) : null}
        {canDecide ? (
          <>
            {record.status === "approved" ? (
              <RgButton
                disabled={rowBusy}
                kind="primary"
                onClick={() => void runAction(record, "complete")}
              >
                Complete
              </RgButton>
            ) : (
              <RgButton
                disabled={rowBusy}
                kind="primary"
                onClick={() => void runAction(record, "approve")}
              >
                Approve
              </RgButton>
            )}
            <RgButton
              disabled={rowBusy}
              kind="danger"
              onClick={() => {
                setRejecting(record);
                setRejectReason(record.rejectedReason ?? "");
              }}
            >
              Reject
            </RgButton>
          </>
        ) : null}
      </span>
    );
  }

  async function createResignation() {
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/resignations", {
        body: JSON.stringify({ resignation: form }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to create the resignation.");
        return;
      }
      setData(payload);
      setForm(newForm());
      setCreating(false);
      setNotice("Resignation created.");
    } catch {
      setError("Unable to create the resignation.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDates() {
    if (!editing) return;
    setBusy(editing.id);
    setError(null);
    try {
      const response = await fetch(`/api/resignations/${encodeURIComponent(editing.id)}/dates`, {
        body: JSON.stringify({ dates: editDates }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to update the dates.");
        return;
      }
      setData(payload.dashboard);
      setEditing(null);
      setNotice("Dates updated.");
    } catch {
      setError("Unable to update the dates.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Busy while the rows upload, so a slow connection cannot stack one export per click (12 failed
   * together on 2026-09-14), and caught, so a failure says so instead of doing nothing. A caught error
   * never reaches the global unhandledrejection net, so it is reported to the error monitor here.
   */
  async function exportCurrentTab() {
    if (busy === "export-tab") return;
    setBusy("export-tab");
    setError(null);
    const rows =
      tab === "candidates"
        ? buildPayrollCandidateExportRows(candidateRows)
        : buildResignationExportRows(tab === "action" ? open : history);
    try {
      if (tab === "candidates") {
        await downloadXlsxExport({
          columns: payrollCandidateExportColumns,
          rows,
          sheetName: "Payroll Candidates",
          title: "Resignations — Payroll Candidates",
        });
        return;
      }
      await downloadXlsxExport({
        columns: resignationExportColumns,
        rows,
        sheetName: tab === "action" ? "Needs Action" : "History",
        title: `Resignations — ${tab === "action" ? "Needs Action" : "History"}`,
      });
    } catch (caught) {
      setError("Unable to export this tab. Check your connection and try again.");
      reportClientError({ context: `feature=resignations-tab-export tab=${tab} rows=${rows.length}`, error: caught });
    } finally {
      setBusy(null);
    }
  }

  /**
   * The whole history, every field — built on the server, so it ignores the tab, the line filter and
   * the search box on purpose (exportCurrentTab above is the one that follows them).
   */
  async function exportFullHistory() {
    setBusy("export-history");
    setError(null);
    try {
      const response = await fetch("/api/resignations/export", { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        setError(payload?.message ?? payload?.error ?? "Unable to export the resignation history.");
        return;
      }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-resignations-full-history.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Unable to export the resignation history.");
    } finally {
      setBusy(null);
    }
  }

  const toolbar = (
    <>
      {canCreate ? (
        <RgButton kind={surface === "admin" ? "onDark" : "quiet"} onClick={() => setCreating(true)}>
          New resignation
        </RgButton>
      ) : null}
      <RgButton
        disabled={busy === "reload"}
        kind={surface === "admin" ? "onDark" : "quiet"}
        onClick={() => void reload()}
      >
        {busy === "reload" ? "Refreshing…" : "Refresh"}
      </RgButton>
    </>
  );

  return (
    <div className="space-y-3">
      {surface === "admin" ? (
        <RgHero
          actions={toolbar}
          eyebrow="People Operations"
          subtitle="Open exits, payroll-only leavers, and closed history."
          title="Resignations"
        />
      ) : (
        <div className="flex flex-wrap justify-end gap-2">{toolbar}</div>
      )}

      {error ? <RgNotice tone="rose">{error}</RgNotice> : null}
      {notice ? <RgNotice tone="emerald">{notice}</RgNotice> : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <RgTile
          label="Needs action"
          sub="Open workflows"
          tone={open.length > 0 ? "orange" : "slate"}
          value={selectOpenResignations(records).length}
        />
        <RgTile
          label="Overdue"
          sub="Left, never completed"
          tone={overdueCount > 0 ? "rose" : "emerald"}
          value={overdueCount}
        />
        <RgTile label="Payroll candidates" sub="Missing from directory" value={candidates.length} />
        <RgTile
          label="History"
          sub="Closed records"
          tone="emerald"
          value={selectClosedResignations(records).length}
        />
      </div>

      <RgPanel
        action={
          <span className="inline-flex flex-wrap justify-end gap-1">
            {canExportTab ? (
              <RgButton disabled={busy === "export-tab"} kind="onDark" onClick={() => void exportCurrentTab()}>
                {busy === "export-tab" ? "Exporting…" : "Export"}
              </RgButton>
            ) : null}
            {canExportHistory ? (
              <RgButton
                disabled={busy === "export-history"}
                kind="onDark"
                onClick={() => void exportFullHistory()}
                title="Every resignation, open and closed, with all fields. Ignores the tab and filters."
              >
                {busy === "export-history" ? "Exporting…" : "Export full history"}
              </RgButton>
            ) : null}
          </span>
        }
        title="Resignations"
      >
        <RgTabs
          onChange={switchTab}
          tabs={[
            { count: open.length, id: "action" as const, label: "Needs action" },
            { count: candidateRows.length, id: "candidates" as const, label: "Payroll candidates" },
            { count: history.length, id: "history" as const, label: "History" },
          ]}
          value={tab}
        />

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
          <div className="min-w-[200px] flex-1">
            <RgInput onChange={setQuery} placeholder="Filter by name, HR ID, reason…" value={query} />
          </div>
          <div className="w-48">
            <RgSelect onChange={setLine} value={line}>
              <option value={ALL_RESIGNATION_FILTER}>All lines</option>
              {lineOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </RgSelect>
          </div>
        </div>

        {settlementWithheld && tab !== "candidates" ? (
          <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold leading-relaxed text-slate-600">
            Salary and settlement amounts are not shown for your seat.
          </p>
        ) : null}

        {leaversHoldingDevices.length > 0 ? (
          <div className="border-b border-rose-200 bg-rose-50 px-3 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-rose-800">
              {leaversHoldingDevices.length} leaver
              {leaversHoldingDevices.length === 1 ? "" : "s"} still holding company devices
            </p>
            <p className="mt-1.5 text-[11px] font-semibold leading-relaxed text-slate-700">
              The custody receipt is the only proof a device came back, and it states that final
              dues are not paid before the return is recorded. Record each return in Device Custody.
            </p>
            <ul className="mt-2 space-y-1">
              {leaversHoldingDevices.map((record) => (
                <li
                  className="min-w-0 break-words text-[11px] font-semibold text-slate-700"
                  key={record.employeeHrId}
                >
                  <span className="font-black text-slate-900">{record.employeeName}</span>
                  {" — "}
                  {record.outstandingDevices
                    .map((device) => `${device.assetTag} (${device.identifier})`)
                    .join(", ")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {tab === "candidates" ? (
          candidateRows.length === 0 ? (
            <RgEmpty>No payroll candidates match this filter.</RgEmpty>
          ) : (
            <RgTable
              cards={slice(candidateRows).map((candidate) => (
                <PortalRecordCard
                  key={candidate.id}
                  meta={
                    <span className="font-mono">
                      {candidate.hrId || "No HR ID"}
                    </span>
                  }
                  status={
                    <RgBadge
                      title={`System resignation candidate ID ${formatPayrollCandidateSystemId(candidate.id)} · ${candidate.sourceFileName ?? "unknown source"} row ${candidate.sourceRow ?? "-"} · no manual HR ID needed`}
                    >
                      {formatPayrollCandidateSystemId(candidate.id)}
                    </RgBadge>
                  }
                  title={candidate.employeeName}
                >
                  <PortalRecordFields
                    fields={[
                      { label: "Line", value: candidate.lineName ?? "-" },
                      { label: "Area", value: candidate.areaName ?? "-" },
                      {
                        label: "Last payout",
                        value: formatPayoutMonth(
                          candidate.lastPayoutMonth,
                          candidate.lastPayoutYear,
                        ),
                      },
                    ]}
                  />
                </PortalRecordCard>
              ))}
              head={
                <>
                  <RgTh>Employee</RgTh>
                  <RgTh>Line</RgTh>
                  <RgTh>Area</RgTh>
                  <RgTh>Last payout</RgTh>
                  <RgTh>Source</RgTh>
                </>
              }
            >
              {slice(candidateRows).map((candidate) => (
                <tr className="bg-white hover:bg-slate-50" key={candidate.id}>
                  <RgTd>
                    <RgPerson hrId={candidate.hrId} name={candidate.employeeName} />
                  </RgTd>
                  <RgTd className="text-slate-500">{candidate.lineName ?? "-"}</RgTd>
                  <RgTd className="text-slate-500">{candidate.areaName ?? "-"}</RgTd>
                  <RgTd className="text-slate-500">
                    {formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear)}
                  </RgTd>
                  <RgTd>
                    <RgBadge
                      title={`System resignation candidate ID ${formatPayrollCandidateSystemId(candidate.id)} · ${candidate.sourceFileName ?? "unknown source"} row ${candidate.sourceRow ?? "-"} · no manual HR ID needed`}
                    >
                      {formatPayrollCandidateSystemId(candidate.id)}
                    </RgBadge>
                  </RgTd>
                </tr>
              ))}
            </RgTable>
          )
        ) : activeRows.length === 0 ? (
          <RgEmpty>
            {tab === "action"
              ? "Nothing needs action. Every open resignation is on track."
              : "No closed records match this filter."}
          </RgEmpty>
        ) : (
          <RgTable
            cards={slice(tab === "action" ? open : history).map((record) => {
              const declinedOffer = isDeclinedOfferResignation(record);
              const terminated = isTerminatedResignation(record);
              return (
                <PortalRecordCard
                  accent={
                    declinedOffer
                      ? "amber"
                      : terminated || record.status === "rejected"
                        ? "rose"
                        : record.status === "approved"
                          ? "emerald"
                          : "slate"
                  }
                  actions={recordControls(record, busy === record.id)}
                  key={record.id}
                  meta={
                    <span>
                      <span className="font-mono">{record.employeeHrId || "No HR ID"}</span>
                      {record.lineName ? ` · ${record.lineName}` : ""}
                    </span>
                  }
                  status={
                    <RgBadge>
                      {declinedOffer ? "Declined Offer" : terminated ? "Terminated" : resignationStatusLabel(record.status)}
                    </RgBadge>
                  }
                  title={record.employeeName}
                >
                  <PortalRecordFields
                    fields={[
                      { label: "Effective", value: formatResignationDate(record.effectiveDate) },
                      ...(settlementWithheld
                        ? []
                        : [
                            { label: "Base salary", value: formatEgp(record.settlement?.baseSalary) },
                            {
                              label: "Days paid",
                              value: record.settlement ? record.settlement.daysWorked : "-",
                            },
                            { label: "Due this month", value: formatEgp(record.settlement?.total) },
                            {
                              label: "Split",
                              value: record.settlement ? (
                                <RgSplit
                                  covered={record.settlement.coveredByFirstPart}
                                  firstPart={formatEgp(record.settlement.firstPart)}
                                  secondPart={formatEgp(record.settlement.secondPart)}
                                />
                              ) : (
                                "—"
                              ),
                            },
                          ]),
                    ]}
                  />
                </PortalRecordCard>
              );
            })}
            head={
              <>
                <RgTh>Employee</RgTh>
                <RgTh>Effective</RgTh>
                {settlementWithheld ? null : (
                  <>
                    <RgTh align="right">Base salary</RgTh>
                    <RgTh align="right">Days paid</RgTh>
                    <RgTh align="right">Due this month</RgTh>
                    <RgTh>Split</RgTh>
                  </>
                )}
                <RgTh align="right">{tab === "action" ? "Actions" : "Closed by"}</RgTh>
              </>
            }
          >
            {slice(tab === "action" ? open : history).map((record) => {
              const declinedOffer = isDeclinedOfferResignation(record);
              const terminated = isTerminatedResignation(record);
              const rowBusy = busy === record.id;

              return (
                <tr
                  className={
                    declinedOffer
                      ? "bg-amber-50/60 hover:bg-amber-50"
                      : terminated
                        ? "bg-rose-50/60 hover:bg-rose-50"
                        : "bg-white hover:bg-slate-50"
                  }
                  key={record.id}
                >
                  {/* The status column is gone — the whole employee cell carries it: light green
                      when approved, light red when rejected, plain otherwise. */}
                  <RgTd
                    className={
                      record.status === "approved"
                        ? "bg-emerald-100"
                        : record.status === "rejected"
                          ? "bg-rose-100"
                          : ""
                    }
                  >
                    <RgPerson
                      hrId={record.employeeHrId}
                      meta={[
                        record.lineName,
                        record.hireDate ? `Hired ${formatResignationDate(record.hireDate)}` : null,
                        declinedOffer ? "Declined Offer" : terminated ? "Terminated" : resignationStatusLabel(record.status),
                      ]}
                      name={record.employeeName}
                    />
                  </RgTd>
                  <RgTd className="text-slate-500">{formatResignationDate(record.effectiveDate)}</RgTd>
                  {settlementWithheld ? null : (
                    <>
                      <RgTd className="text-right text-slate-500">
                        {formatEgp(record.settlement?.baseSalary)}
                      </RgTd>
                      <RgTd className="text-right text-slate-500">
                        {record.settlement ? record.settlement.daysWorked : "-"}
                      </RgTd>
                      <RgTd className="text-right font-bold text-slate-900">
                        {formatEgp(record.settlement?.total)}
                      </RgTd>
                      <RgTd>
                        {record.settlement ? (
                          <RgSplit
                            covered={record.settlement.coveredByFirstPart}
                            firstPart={formatEgp(record.settlement.firstPart)}
                            secondPart={formatEgp(record.settlement.secondPart)}
                          />
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </RgTd>
                    </>
                  )}
                  <RgTd className="text-right">{recordControls(record, rowBusy)}</RgTd>
                </tr>
              );
            })}
          </RgTable>
        )}

        <RgPager onPage={setPage} page={safePage} pageSize={PAGE_SIZE} total={activeRows.length} />
      </RgPanel>

      {creating ? (
        <RgDialog
          footer={
            <>
              <RgButton onClick={() => setCreating(false)}>Cancel</RgButton>
              <RgButton
                disabled={busy === "create" || !form.employeeHrId || !form.effectiveDate}
                kind="primary"
                onClick={() => void createResignation()}
              >
                Create
              </RgButton>
            </>
          }
          onClose={() => setCreating(false)}
          subtitle="Starts the exit workflow for one employee."
          title="New resignation"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <RgField label="Employee">
                <RgSelect
                  onChange={(value) => setForm((f) => ({ ...f, employeeHrId: value }))}
                  value={form.employeeHrId}
                >
                  <option value="">Select an employee</option>
                  {employees.map((employee) => (
                    <option key={employee.value} value={employee.value}>
                      {employee.label}
                    </option>
                  ))}
                </RgSelect>
              </RgField>
            </div>
            <RgField label="Submitted">
              <RgInput
                onChange={(value) => setForm((f) => ({ ...f, submittedDate: value }))}
                type="date"
                value={form.submittedDate}
              />
            </RgField>
            <RgField label="Effective (last working day)">
              <RgInput
                onChange={(value) => setForm((f) => ({ ...f, effectiveDate: value }))}
                type="date"
                value={form.effectiveDate}
              />
            </RgField>
            <div className="sm:col-span-2">
              <RgField label="Reason">
                <RgInput
                  onChange={(value) => setForm((f) => ({ ...f, reason: value }))}
                  placeholder="Personal, career move, redundancy…"
                  value={form.reason ?? ""}
                />
              </RgField>
            </div>
          </div>
        </RgDialog>
      ) : null}

      {rejecting ? (
        <RgDialog
          footer={
            <>
              <RgButton onClick={() => setRejecting(null)}>Cancel</RgButton>
              <RgButton
                disabled={rejectReason.trim().length === 0}
                kind="danger"
                onClick={() => {
                  const target = rejecting;
                  setRejecting(null);
                  void runAction(target, "reject", rejectReason.trim());
                }}
              >
                Reject
              </RgButton>
            </>
          }
          onClose={() => setRejecting(null)}
          subtitle={`${rejecting.employeeName} · ${rejecting.employeeHrId}`}
          title="Reject resignation"
        >
          <RgField label="Reason (required — stored on the record)">
            <RgInput onChange={setRejectReason} placeholder="Why is this being rejected?" value={rejectReason} />
          </RgField>
        </RgDialog>
      ) : null}

      {editing ? (
        <RgDialog
          footer={
            <>
              <RgButton onClick={() => setEditing(null)}>Cancel</RgButton>
              <RgButton
                disabled={!editDates.submittedDate || !editDates.effectiveDate}
                kind="primary"
                onClick={() => void saveDates()}
              >
                Save
              </RgButton>
            </>
          }
          onClose={() => setEditing(null)}
          subtitle={`${editing.employeeName} · ${editing.employeeHrId}`}
          title="Edit dates"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <RgField label="Submitted">
              <RgInput
                onChange={(value) => setEditDates((d) => ({ ...d, submittedDate: value }))}
                type="date"
                value={editDates.submittedDate}
              />
            </RgField>
            <RgField label="Effective">
              <RgInput
                onChange={(value) => setEditDates((d) => ({ ...d, effectiveDate: value }))}
                type="date"
                value={editDates.effectiveDate}
              />
            </RgField>
          </div>
        </RgDialog>
      ) : null}
    </div>
  );
}
