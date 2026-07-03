"use client";

import { useState } from "react";
import { AlarmClockCheck, Settings2 } from "lucide-react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { DigestSettings } from "@/lib/attendance/digest-recipients";

const fieldClassName =
  "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 shadow-inner shadow-slate-100/60 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100";
const labelClassName = "text-[11px] font-black uppercase tracking-[0.16em] text-slate-500";

type Props = {
  canUpdate: boolean;
  initialSettings: DigestSettings | null;
  employees: Array<{ fullName: string; hrId: string }>;
};

export function DigestSettingsPanel({ canUpdate, initialSettings, employees }: Props) {
  const [settings, setSettings] = useState<DigestSettings>(
    initialSettings ?? {
      approverHrIds: [],
      autoConfirmHours: 48,
      ccCeo: true,
      ccManager: true,
      cycleAnchorDay: 24,
      dryRun: true,
      missingPunchVerifierHrId: null,
    },
  );
  const [pendingApprover, setPendingApprover] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function labelFor(hrId: string) {
    return employees.find((employee) => employee.hrId === hrId)?.fullName ?? hrId;
  }

  function addApprover() {
    if (!pendingApprover || settings.approverHrIds.includes(pendingApprover)) return;
    setSettings({ ...settings, approverHrIds: [...settings.approverHrIds, pendingApprover] });
    setPendingApprover("");
  }

  function removeApprover(hrId: string) {
    setSettings({ ...settings, approverHrIds: settings.approverHrIds.filter((id) => id !== hrId) });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/attendance/digest-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Digest settings failed to save.");
      setSettings(payload);
      setNotice("Digest settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Digest settings failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminTableShell
      description="Approvers, dispute routing, timing, and the dry-run switch for the weekly attendance digest."
      title="Digest Settings"
    >
      <div className="space-y-5 p-4">
        {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
        {notice ? <AdminCallout tone="neutral">{notice}</AdminCallout> : null}
        {settings.dryRun ? (
          <AdminCallout tone="warning">
            Dry-run is ON — digests and notifications send for real, but no payroll deduction candidate is ever created. Turn
            this off only once you have confirmed a full cycle looks accurate.
          </AdminCallout>
        ) : null}

        <div className="space-y-2">
          <span className={labelClassName}>Dispute Approvers (HR Manager / System Admin)</span>
          <div className="flex flex-wrap gap-2">
            {settings.approverHrIds.length === 0 ? (
              <p className="text-sm font-semibold text-slate-500">No approvers configured yet — disputes will fall back to the CEO.</p>
            ) : null}
            {settings.approverHrIds.map((hrId) => (
              <span
                className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-black text-orange-700"
                key={hrId}
              >
                {labelFor(hrId)}
                {canUpdate ? (
                  <button aria-label={`Remove ${labelFor(hrId)}`} className="text-orange-500 hover:text-orange-800" type="button" onClick={() => removeApprover(hrId)}>
                    &times;
                  </button>
                ) : null}
              </span>
            ))}
          </div>
          {canUpdate ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-64 flex-1 space-y-1.5">
                <span className={labelClassName}>Add approver</span>
                <SearchableSelect className={fieldClassName} value={pendingApprover} onChange={(event) => setPendingApprover(event.target.value)}>
                  <option value="">Select employee</option>
                  {employees.map((employee) => (
                    <option key={employee.hrId} value={employee.hrId}>{employee.hrId} - {employee.fullName}</option>
                  ))}
                </SearchableSelect>
              </label>
              <Button disabled={!pendingApprover} type="button" onClick={addApprover}>Add</Button>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="flex h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-inner shadow-slate-100/60">
            <span>Cc direct manager</span>
            <input
              checked={settings.ccManager}
              className="h-4 w-4 accent-orange-600"
              disabled={!canUpdate}
              type="checkbox"
              onChange={(event) => setSettings({ ...settings, ccManager: event.target.checked })}
            />
          </label>
          <label className="flex h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-inner shadow-slate-100/60">
            <span>Cc CEO</span>
            <input
              checked={settings.ccCeo}
              className="h-4 w-4 accent-orange-600"
              disabled={!canUpdate}
              type="checkbox"
              onChange={(event) => setSettings({ ...settings, ccCeo: event.target.checked })}
            />
          </label>
          <label className="flex h-11 items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-black text-amber-800 shadow-inner shadow-amber-100/60">
            <span>Dry-run (no real deductions)</span>
            <input
              checked={settings.dryRun}
              className="h-4 w-4 accent-amber-600"
              disabled={!canUpdate}
              type="checkbox"
              onChange={(event) => setSettings({ ...settings, dryRun: event.target.checked })}
            />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1.5">
            <span className={labelClassName}>Missing-Punch Verifier</span>
            <SearchableSelect
              className={fieldClassName}
              value={settings.missingPunchVerifierHrId ?? ""}
              onChange={(event) => setSettings({ ...settings, missingPunchVerifierHrId: event.target.value || null })}
            >
              <option value="">Not set</option>
              {employees.map((employee) => (
                <option key={employee.hrId} value={employee.hrId}>{employee.hrId} - {employee.fullName}</option>
              ))}
            </SearchableSelect>
            <p className="text-[11px] font-semibold text-slate-500">First-line verifier in the A-13 → HR → CEO missing-punch chain.</p>
          </label>
          <label className="space-y-1.5">
            <span className={labelClassName}>Auto-Confirm Window (hours)</span>
            <input
              className={fieldClassName}
              disabled={!canUpdate}
              max="168"
              min="1"
              type="number"
              value={settings.autoConfirmHours}
              onChange={(event) => setSettings({ ...settings, autoConfirmHours: Number(event.target.value) })}
            />
            <p className="text-[11px] font-semibold text-slate-500">Silence beyond this window auto-confirms to salary. No reminder is sent.</p>
          </label>
          <label className="space-y-1.5">
            <span className={labelClassName}>Cycle Anchor Day</span>
            <input
              className={fieldClassName}
              disabled={!canUpdate}
              max="28"
              min="1"
              type="number"
              value={settings.cycleAnchorDay}
              onChange={(event) => setSettings({ ...settings, cycleAnchorDay: Number(event.target.value) })}
            />
            <p className="text-[11px] font-semibold text-slate-500">Payroll cycle runs anchor-day → anchor-day (24 = 24th to 24th).</p>
          </label>
        </div>

        {canUpdate ? (
          <div className="flex justify-end">
            <Button disabled={saving} type="button" onClick={save}>
              {saving ? <AlarmClockCheck className="h-4 w-4 animate-pulse" /> : <Settings2 className="h-4 w-4" />}
              {saving ? "Saving…" : "Save Digest Settings"}
            </Button>
          </div>
        ) : null}
      </div>
    </AdminTableShell>
  );
}
