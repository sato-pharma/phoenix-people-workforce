"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Plus, RefreshCw, Save } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AttendancePolicyDashboard,
  AttendancePolicyEventType,
  AttendancePolicyGroup,
  AttendancePolicyTargetType,
} from "@/lib/attendance/policies";

type Props = {
  canUpdate: boolean;
  initialData: AttendancePolicyDashboard | null;
  initialError: string | null;
};

type RuleForm = {
  deductionDays: string;
  deductionValue: string;
  eventType: AttendancePolicyEventType;
  fromMinutes: string;
  isActive: boolean;
  recommendedAction: string;
  toMinutes: string;
};

type PolicyForm = {
  effectiveFrom: string;
  effectiveTo: string;
  graceMinutes: string;
  id: number | null;
  isActive: boolean;
  policyName: string;
  rules: RuleForm[];
  scheduledEnd: string;
  scheduledStart: string;
  targetType: AttendancePolicyTargetType;
  targetValue: string;
};

const blankRule: RuleForm = {
  deductionDays: "",
  deductionValue: "",
  eventType: "late",
  fromMinutes: "",
  isActive: true,
  recommendedAction: "",
  toMinutes: "",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function blankPolicy(): PolicyForm {
  return {
    effectiveFrom: today(),
    effectiveTo: "",
    graceMinutes: "15",
    id: null,
    isActive: true,
    policyName: "Default Attendance Policy",
    rules: [
      { ...blankRule, fromMinutes: "15", recommendedAction: "Review late arrival", toMinutes: "30" },
    ],
    scheduledEnd: "17:30",
    scheduledStart: "09:30",
    targetType: "default",
    targetValue: "",
  };
}

function formFromPolicy(policy: AttendancePolicyGroup): PolicyForm {
  return {
    effectiveFrom: policy.effectiveFrom,
    effectiveTo: policy.effectiveTo,
    graceMinutes: String(policy.graceMinutes),
    id: policy.id,
    isActive: policy.isActive,
    policyName: policy.policyName,
    rules: policy.rules.length > 0
      ? policy.rules.map((rule) => ({
        deductionDays: rule.deductionDays,
        deductionValue: rule.deductionValue,
        eventType: rule.eventType,
        fromMinutes: rule.fromMinutes,
        isActive: rule.isActive,
        recommendedAction: rule.recommendedAction,
        toMinutes: rule.toMinutes,
      }))
      : [{ ...blankRule }],
    scheduledEnd: policy.scheduledEnd,
    scheduledStart: policy.scheduledStart,
    targetType: policy.targetType,
    targetValue: policy.targetType === "default" ? "" : policy.targetValue,
  };
}

function targetLabel(policy: Pick<AttendancePolicyGroup, "targetType" | "targetValue">) {
  if (policy.targetType === "default") return "Default company policy";
  if (policy.targetType === "job_title") return `Title: ${policy.targetValue}`;
  return `HR_ID: ${policy.targetValue}`;
}

function targetBadge(policy: Pick<AttendancePolicyGroup, "targetType" | "targetValue">) {
  if (policy.targetType === "default") return <Badge variant="neutral">Default</Badge>;
  if (policy.targetType === "job_title") return <Badge variant="warning">Job Title</Badge>;
  return <Badge variant="success">HR_ID</Badge>;
}

function eventLabel(value: AttendancePolicyEventType) {
  return value.replace("_", " ");
}

export function AttendancePoliciesManager({ canUpdate, initialData, initialError }: Props) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<PolicyForm>(() => blankPolicy());

  const targetOptions = useMemo(() => ({
    employees: data?.employees ?? [],
    jobTitles: data?.jobTitles ?? [],
  }), [data?.employees, data?.jobTitles]);

  async function load() {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/attendance/policies", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Attendance policies failed to load.");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Attendance policies failed to load.");
    } finally {
      setRefreshing(false);
    }
  }

  async function savePolicy() {
    setSaving(true);
    setError(null);
    setNotice(null);
    const policyPayload = form.targetType === "default" && form.targetValue
      ? { ...form, targetValue: "" }
      : form;
    try {
      const response = await fetch("/api/attendance/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policyPayload),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Attendance policy failed to save.");
      setData(payload);
      setNotice(`Saved ${form.policyName}.`);
      setForm(blankPolicy());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Attendance policy failed to save.");
    } finally {
      setSaving(false);
    }
  }

  function updateRule(index: number, patch: Partial<RuleForm>) {
    setForm((current) => ({
      ...current,
      rules: current.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule),
    }));
  }

  function removeRule(index: number) {
    setForm((current) => ({
      ...current,
      rules: current.rules.filter((_, ruleIndex) => ruleIndex !== index),
    }));
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{data?.summary.total ?? 0} policies</AdminInsightChip>
            <AdminInsightChip tone="slate">{data?.summary.jobTitlePolicies ?? 0} title policies</AdminInsightChip>
            <AdminInsightChip tone="orange">{data?.summary.employeePolicies ?? 0} HR_ID overrides</AdminInsightChip>
          </>
        )}
        description="Configure attendance policies by default, job title, or employee HR_ID. HR_ID policies override title policies later when report calculations are connected."
        eyebrow="Attendance"
        icon={<CalendarClock className="h-3.5 w-3.5" />}
        title="Attendance Policies"
        actions={(
          <Button disabled={refreshing} variant="secondary" type="button" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            {refreshing ? "Refreshing" : "Refresh"}
          </Button>
        )}
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}
      {!canUpdate ? <AdminCallout tone="warning">You can review policies, but this account cannot update them.</AdminCallout> : null}
      <AdminCallout tone="neutral">
        These policies are configuration only for now. They do not modify payroll until the deduction calculation and approval workflow are explicitly connected.
      </AdminCallout>

      <AdminTableShell
        description="Create a default policy, job-title policy, or HR_ID-specific override."
        title={form.id ? "Edit Policy" : "New Policy"}
      >
        <div className="grid gap-4 p-4 lg:grid-cols-4">
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Policy Name</span>
            <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" value={form.policyName} onChange={(event) => setForm({ ...form, policyName: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Target Type</span>
            <select className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" value={form.targetType} onChange={(event) => setForm({ ...form, targetType: event.target.value as AttendancePolicyTargetType, targetValue: "" })}>
              <option value="default">Default</option>
              <option value="job_title">Job Title</option>
              <option value="employee_hr_id">Employee HR_ID</option>
            </select>
          </label>
          {form.targetType === "job_title" ? (
            <label className="space-y-1">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Job Title</span>
              <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" list="attendance-job-title-options" value={form.targetValue} onChange={(event) => setForm({ ...form, targetValue: event.target.value })} />
              <datalist id="attendance-job-title-options">
                {targetOptions.jobTitles.map((title) => <option key={title} value={title} />)}
              </datalist>
            </label>
          ) : null}
          {form.targetType === "employee_hr_id" ? (
            <label className="space-y-1">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee HR_ID</span>
              <select className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" value={form.targetValue} onChange={(event) => setForm({ ...form, targetValue: event.target.value })}>
                <option value="">Select employee</option>
                {targetOptions.employees.map((employee) => (
                  <option key={employee.hrId} value={employee.hrId}>{employee.hrId} - {employee.fullName}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Scheduled Start</span>
            <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" type="time" value={form.scheduledStart} onChange={(event) => setForm({ ...form, scheduledStart: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Scheduled End</span>
            <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" type="time" value={form.scheduledEnd} onChange={(event) => setForm({ ...form, scheduledEnd: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Grace Minutes</span>
            <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" min="0" type="number" value={form.graceMinutes} onChange={(event) => setForm({ ...form, graceMinutes: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Effective From</span>
            <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" type="date" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Effective To</span>
            <input className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" type="date" value={form.effectiveTo} onChange={(event) => setForm({ ...form, effectiveTo: event.target.value })} />
          </label>
          <label className="flex items-end gap-2 text-sm font-semibold text-slate-700">
            <input checked={form.isActive} className="mb-3 h-4 w-4" type="checkbox" onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
            <span className="mb-2">Active</span>
          </label>
        </div>

        <div className="border-t border-slate-100 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-black text-slate-900">Rules</p>
            <Button variant="secondary" type="button" onClick={() => setForm({ ...form, rules: [...form.rules, { ...blankRule }] })}>
              <Plus className="h-4 w-4" />
              Add rule
            </Button>
          </div>
          <div className="space-y-3">
            {form.rules.map((rule, index) => (
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 lg:grid-cols-8" key={index}>
                <select className="h-10 rounded-lg border border-slate-200 px-3 text-sm" value={rule.eventType} onChange={(event) => updateRule(index, { eventType: event.target.value as AttendancePolicyEventType })}>
                  <option value="late">Late</option>
                  <option value="early_leave">Early leave</option>
                  <option value="single_punch">Single punch</option>
                  <option value="absence">Absence</option>
                </select>
                <input className="h-10 rounded-lg border border-slate-200 px-3 text-sm" placeholder="From min" type="number" value={rule.fromMinutes} onChange={(event) => updateRule(index, { fromMinutes: event.target.value })} />
                <input className="h-10 rounded-lg border border-slate-200 px-3 text-sm" placeholder="To min" type="number" value={rule.toMinutes} onChange={(event) => updateRule(index, { toMinutes: event.target.value })} />
                <input className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" placeholder="Recommended action" value={rule.recommendedAction} onChange={(event) => updateRule(index, { recommendedAction: event.target.value })} />
                <input className="h-10 rounded-lg border border-slate-200 px-3 text-sm" placeholder="Days" type="number" value={rule.deductionDays} onChange={(event) => updateRule(index, { deductionDays: event.target.value })} />
                <input className="h-10 rounded-lg border border-slate-200 px-3 text-sm" placeholder="Value" type="number" value={rule.deductionValue} onChange={(event) => updateRule(index, { deductionValue: event.target.value })} />
                <Button disabled={form.rules.length === 1} variant="secondary" type="button" onClick={() => removeRule(index)}>Remove</Button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 p-4">
          <Button variant="secondary" type="button" onClick={() => setForm(blankPolicy())}>New</Button>
          <Button disabled={!canUpdate || saving} type="button" onClick={savePolicy}>
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save policy"}
          </Button>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Priority is HR_ID policy, then job title policy, then default policy."
        title="Current Policies"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Policy</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Grace</th>
                <th className="px-4 py-3">Rules</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {(data?.policies ?? []).map((policy) => (
                <tr className="border-b border-slate-100 last:border-0" key={policy.id}>
                  <td className="px-4 py-3">
                    <p className="font-black text-slate-900">{policy.policyName}</p>
                    <p className="text-xs text-slate-500">{policy.effectiveFrom}{policy.effectiveTo ? ` to ${policy.effectiveTo}` : ""}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-1">
                      {targetBadge(policy)}
                      <p className="text-sm font-semibold text-slate-700">{targetLabel(policy)}</p>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">{policy.scheduledStart} - {policy.scheduledEnd}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">{policy.graceMinutes} min</td>
                  <td className="px-4 py-3 text-sm text-slate-700">
                    {policy.rules.length === 0 ? "No rules" : policy.rules.slice(0, 3).map((rule) => (
                      <div key={rule.id}>{eventLabel(rule.eventType)}: {rule.recommendedAction}</div>
                    ))}
                  </td>
                  <td className="px-4 py-3">{policy.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Inactive</Badge>}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="secondary" type="button" onClick={() => setForm(formFromPolicy(policy))}>Edit</Button>
                  </td>
                </tr>
              ))}
              {(data?.policies ?? []).length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>No attendance policies configured yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
    </div>
  );
}
