"use client";

import { useMemo, useRef, useState } from "react";
import { BadgeCheck, CalendarClock, Clock3, FileWarning, Layers3, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalDesktopTable,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AttendanceJudgmentMode,
  AttendancePolicyDashboard,
  AttendancePolicyEventType,
  AttendancePolicyGroup,
  AttendancePolicyTargetType,
} from "@/lib/attendance/policies";
import { resolvePolicyAttendanceStatus } from "@/lib/attendance/metrics";
import {
  attendanceWeekdayOptions,
  formatAttendanceWorkingWeekdays,
  type AttendanceWorkingWeekday,
} from "@/lib/attendance/work-schedule";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxFieldClassName,
  phxLabelTextClassName,
} from "@/components/ui/form-tokens";


const fieldClassName  = phxFieldClassName;
const labelClassName = phxLabelTextClassName;
const mutedPanelClassName = "rounded-xl border border-slate-200/90 bg-gradient-to-br from-white via-slate-50/70 to-white shadow-[0_12px_28px_rgba(15,23,42,0.06)]";
const sectionTitleClassName = "text-sm font-black tracking-tight text-slate-950";

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
  workingWeekdays: string[];
  /** Flexible-hours fields — empty flexMinutes/requiredMinutes = not enrolled. */
  flexMinutes: string;
  requiredMinutes: string;
  halfDaySplitMinutes: string;
  judgmentMode: AttendanceJudgmentMode;
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

const standardLateRules: RuleForm[] = [
  { ...blankRule, deductionDays: "0.125", eventType: "late", fromMinutes: "16", recommendedAction: "Deduct eighth day", toMinutes: "30" },
  { ...blankRule, deductionDays: "0.25", eventType: "late", fromMinutes: "31", recommendedAction: "Deduct quarter day", toMinutes: "45" },
  { ...blankRule, deductionDays: "0.5", eventType: "late", fromMinutes: "46", recommendedAction: "Deduct half day", toMinutes: "" },
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function blankPolicy(): PolicyForm {
  return {
    effectiveFrom: today(),
    effectiveTo: "",
    graceMinutes: "10",
    id: null,
    isActive: true,
    policyName: "Default Attendance Policy",
    rules: standardLateRules.map((rule) => ({ ...rule })),
    scheduledEnd: "17:00",
    scheduledStart: "09:00",
    targetType: "default",
    targetValue: "",
    workingWeekdays: [],
    flexMinutes: "",
    requiredMinutes: "",
    halfDaySplitMinutes: "780",
    judgmentMode: "every_working_day",
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
    rules: policy.rules.map((rule) => ({
      deductionDays: rule.deductionDays,
      deductionValue: rule.deductionValue,
      eventType: rule.eventType,
      fromMinutes: rule.fromMinutes,
      isActive: rule.isActive,
      recommendedAction: rule.recommendedAction,
      toMinutes: rule.toMinutes,
    })),
    scheduledEnd: policy.scheduledEnd,
    scheduledStart: policy.scheduledStart,
    targetType: policy.targetType,
    targetValue: policy.targetType === "default" ? "" : policy.targetValue,
    workingWeekdays: policy.workingWeekdays.map(String),
    flexMinutes: policy.flexMinutes == null ? "" : String(policy.flexMinutes),
    requiredMinutes: policy.requiredMinutes == null ? "" : String(policy.requiredMinutes),
    halfDaySplitMinutes: String(policy.halfDaySplitMinutes),
    judgmentMode: policy.judgmentMode,
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
  if (value === "exception") return "Exception";
  return value.replace("_", " ");
}

function ruleSummary(rule: AttendancePolicyGroup["rules"][number]) {
  const range = rule.fromMinutes || rule.toMinutes
    ? `${rule.fromMinutes || "0"}-${rule.toMinutes || "open"} min`
    : "any duration";
  const deduction = rule.deductionDays ? ` -> ${rule.deductionDays} day` : "";
  return `${eventLabel(rule.eventType)} ${range}${deduction}: ${rule.recommendedAction}`;
}

function formatTargetType(value: AttendancePolicyTargetType) {
  if (value === "employee_hr_id") return "Employee HR_ID";
  if (value === "job_title") return "Job title";
  return "Default";
}

function policyScopeDetail(form: PolicyForm) {
  if (form.targetType === "default") return "Applies when no title or HR_ID override is active.";
  if (form.targetType === "job_title") return form.targetValue || "Select or type the job title for this rule set.";
  return form.targetValue || "Select the employee HR_ID for a direct override.";
}

function previewToneClasses(status: string) {
  if (status === "Complete") {
    return {
      accent: "bg-emerald-500",
      badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
      surface: "border-emerald-200/80 bg-gradient-to-br from-emerald-50 via-white to-white",
    };
  }
  if (status === "Late" || status === "Short day") {
    return {
      accent: "bg-orange-500",
      badge: "border-orange-200 bg-orange-50 text-orange-700",
      surface: "border-orange-200/80 bg-gradient-to-br from-orange-50 via-white to-white",
    };
  }
  return {
    accent: "bg-slate-500",
    badge: "border-slate-200 bg-slate-50 text-slate-700",
    surface: "border-slate-200 bg-white",
  };
}

function numberOrNull(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesFromTime(value: string) {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

function validateRuleDrafts(rules: RuleForm[]) {
  const issues: string[] = [];
  const activeRules = rules
    .map((rule, index) => ({ ...rule, index }))
    .filter((rule) => rule.isActive);

  for (const rule of activeRules) {
    const from = numberOrNull(rule.fromMinutes);
    const to = numberOrNull(rule.toMinutes);
    if (!rule.recommendedAction.trim()) issues.push(`Rule ${rule.index + 1}: recommended action is required.`);
    if (from != null && to != null && to < from) issues.push(`Rule ${rule.index + 1}: To minutes cannot be before From minutes.`);
    if (numberOrNull(rule.deductionDays) == null && rule.eventType !== "exception") {
      issues.push(`Rule ${rule.index + 1}: deduction day fraction is missing.`);
    }
  }

  for (let leftIndex = 0; leftIndex < activeRules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeRules.length; rightIndex += 1) {
      const left = activeRules[leftIndex];
      const right = activeRules[rightIndex];
      if (left.eventType !== right.eventType) continue;
      const leftFrom = numberOrNull(left.fromMinutes) ?? 0;
      const leftTo = numberOrNull(left.toMinutes) ?? Number.POSITIVE_INFINITY;
      const rightFrom = numberOrNull(right.fromMinutes) ?? 0;
      const rightTo = numberOrNull(right.toMinutes) ?? Number.POSITIVE_INFINITY;
      if (leftFrom <= rightTo && rightFrom <= leftTo) {
        issues.push(`Rules ${left.index + 1} and ${right.index + 1} overlap for ${eventLabel(left.eventType)}.`);
      }
    }
  }

  return issues;
}

function previewRows(form: PolicyForm) {
  const startMinutes = minutesFromTime(form.scheduledStart) ?? 9 * 60;
  const endMinutes = minutesFromTime(form.scheduledEnd) ?? 17 * 60;
  const dailyMinutes = endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
  const policy = {
    effective_from: form.effectiveFrom,
    effective_to: form.effectiveTo || null,
    grace_minutes: numberOrNull(form.graceMinutes) ?? 0,
    is_active: form.isActive,
    scheduled_end: form.scheduledEnd,
    scheduled_start: form.scheduledStart,
    target_type: form.targetType,
    target_value: form.targetValue || null,
    working_weekdays: form.workingWeekdays.map(Number),
  };
  const rules = form.rules.map((rule, index) => ({
    deduction_days: numberOrNull(rule.deductionDays) == null ? null : rule.deductionDays,
    deduction_value: null,
    event_type: rule.eventType,
    from_minutes: numberOrNull(rule.fromMinutes),
    is_active: rule.isActive,
    recommended_action: rule.recommendedAction,
    sort_order: index + 1,
    to_minutes: numberOrNull(rule.toMinutes),
  }));
  const samples = [
    { label: "On time, leaves 10 min early", first: startMinutes, last: endMinutes - 10 },
    { label: "Uses 10 min morning grace", first: startMinutes + 10, last: endMinutes },
    { label: "Uses 20 min total", first: startMinutes + 10, last: endMinutes - 10 },
    { label: "Late 35 min", first: startMinutes + 35, last: endMinutes },
  ];

  return samples.map((sample) => {
    const status = resolvePolicyAttendanceStatus({
      baseSalary: 15000,
      durationMinutes: Math.max(0, sample.last - sample.first),
      firstPunchMinutes: sample.first,
      lastPunchMinutes: sample.last,
      policy,
      // Illustrative preview only — alongside the fixed 15,000 sample salary, this
      // just picks a 30-day month so the worked example stays stable. Real
      // deductions divide by the actual calendar days of the day being charged.
      reportDate: "2026-09-15",
      rules,
      visiblePunchCount: 2,
    });
    return {
      ...sample,
      amount: status.deductionValue,
      deductionDays: status.deductionDays,
      result: status.recommendedAction,
      status: status.status,
      time: `${Math.floor(sample.first / 60).toString().padStart(2, "0")}:${(sample.first % 60).toString().padStart(2, "0")} - ${Math.floor(sample.last / 60).toString().padStart(2, "0")}:${(sample.last % 60).toString().padStart(2, "0")}`,
      worked: dailyMinutes,
    };
  });
}

export function AttendancePoliciesManager({ canUpdate, initialData, initialError }: Props) {
  const formRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingPolicyId, setDeletingPolicyId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<PolicyForm>(() => blankPolicy());

  const targetOptions = useMemo(() => ({
    employees: data?.employees ?? [],
    jobTitles: data?.jobTitles ?? [],
  }), [data?.employees, data?.jobTitles]);
  const ruleIssues = useMemo(() => validateRuleDrafts(form.rules), [form.rules]);
  const previews = useMemo(() => previewRows(form), [form]);

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
    if (ruleIssues.length > 0) {
      setError(`Fix rule validation first: ${ruleIssues[0]}`);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const isEditing = form.id !== null;
    const policyName = form.policyName;
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
      setNotice(`${isEditing ? "Updated" : "Created"} ${policyName}.`);
      setForm(blankPolicy());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Attendance policy failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function deletePolicy(policy: AttendancePolicyGroup) {
    if (!canUpdate || deletingPolicyId !== null) return;
    const confirmed = window.confirm(`Delete "${policy.policyName}" and all its rules? This cannot be undone.`);
    if (!confirmed) return;

    setDeletingPolicyId(policy.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/policies?id=${encodeURIComponent(String(policy.id))}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Attendance policy failed to delete.");
      setData(payload);
      if (form.id === policy.id) setForm(blankPolicy());
      setNotice(`Deleted ${policy.policyName}.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Attendance policy failed to delete.");
    } finally {
      setDeletingPolicyId(null);
    }
  }

  function editPolicy(policy: AttendancePolicyGroup) {
    setForm(formFromPolicy(policy));
    setError(null);
    setNotice(`Editing ${policy.policyName}. Make changes above, then save.`);
    window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function addRule(patch: Partial<RuleForm> = {}) {
    setForm((current) => ({
      ...current,
      rules: [...current.rules, { ...blankRule, ...patch }],
    }));
  }

  function applyStandardSchedule() {
    setForm((current) => ({
      ...current,
      graceMinutes: "10",
      scheduledEnd: "17:00",
      scheduledStart: "09:00",
    }));
  }

  function applyStandardLateRules() {
    setForm((current) => ({
      ...current,
      rules: standardLateRules.map((rule) => ({ ...rule })),
    }));
  }

  function addNoDeductionWindow() {
    setForm((current) => ({
      ...current,
      rules: [
        ...current.rules,
        { ...blankRule, deductionDays: "0", eventType: "late", fromMinutes: "11", recommendedAction: "No deduction, HR visibility only", toMinutes: "15" },
      ],
    }));
  }

  function applyShortSchedule() {
    setForm((current) => ({
      ...current,
      graceMinutes: "0",
      scheduledEnd: "16:00",
      scheduledStart: "10:00",
    }));
  }

  function toggleWorkingWeekday(day: AttendanceWorkingWeekday) {
    setForm((current) => {
      const value = String(day);
      const workingWeekdays = current.workingWeekdays.includes(value)
        ? current.workingWeekdays.filter((entry) => entry !== value)
        : [...current.workingWeekdays, value];
      return {
        ...current,
        workingWeekdays: workingWeekdays.sort((left, right) => Number(left) - Number(right)),
      };
    });
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
    setNotice("Rule removed from the draft. Save policy to apply this change.");
  }

  /** Rendered by both the desktop row and the phone card, so the two cannot drift apart. */
  function policyActions(policy: AttendancePolicyGroup) {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" type="button" onClick={() => editPolicy(policy)}>
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
        <Button
          disabled={!canUpdate || deletingPolicyId !== null}
          variant="destructive"
          type="button"
          onClick={() => deletePolicy(policy)}
        >
          <Trash2 className="h-4 w-4" />
          {deletingPolicyId === policy.id ? "Deleting" : "Delete"}
        </Button>
      </div>
    );
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
        Grace minutes are a daily budget shared between late arrival and early leave. Deduction rules store day fractions, and reports estimate the amount from base salary.
      </AdminCallout>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className={mutedPanelClassName}>
          <div className="flex items-start gap-3 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-orange-100 shadow-[0_12px_24px_rgba(15,23,42,0.18)]">
              <Layers3 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className={labelClassName}>Policy Priority</p>
              <p className="mt-1 text-sm font-black text-slate-950">HR_ID override, job title, then default</p>
            </div>
          </div>
        </div>
        <div className={mutedPanelClassName}>
          <div className="flex items-start gap-3 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-600 text-white shadow-[0_12px_24px_rgba(234,88,12,0.22)]">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className={labelClassName}>Active Policies</p>
              <p className="mt-1 text-sm font-black text-slate-950">{data?.summary.active ?? 0} active of {data?.summary.total ?? 0}</p>
            </div>
          </div>
        </div>
        <div className={mutedPanelClassName}>
          <div className="flex items-start gap-3 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-slate-700 ring-1 ring-slate-200 shadow-[0_12px_24px_rgba(15,23,42,0.08)]">
              <Clock3 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className={labelClassName}>Draft Schedule</p>
              <p className="mt-1 text-sm font-black text-slate-950">{form.scheduledStart} - {form.scheduledEnd} / {form.graceMinutes || 0} min grace</p>
            </div>
          </div>
        </div>
      </div>

      <div ref={formRef}>
        <AdminTableShell
          description="Create a default policy, job-title policy, HR_ID-specific override, or exception review rule."
          title={form.id ? "Edit Policy" : "New Policy"}
        >
          {form.id ? (
            <div className="border-b border-slate-100 px-5 py-4">
              <AdminCallout tone="warning">Editing policy #{form.id}. Save to apply changes, or choose New to cancel editing.</AdminCallout>
            </div>
          ) : null}
          <div className="grid xl:grid-cols-[minmax(0,1fr)_330px]">
            <div className="space-y-5 p-5">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <label className="space-y-1.5 md:col-span-2">
                  <span className={labelClassName}>Policy Name</span>
                  <input className={fieldClassName} value={form.policyName} onChange={(event) => setForm({ ...form, policyName: event.target.value })} />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClassName}>Target Type</span>
                  <SearchableSelect className={fieldClassName} value={form.targetType} onChange={(event) => setForm({ ...form, targetType: event.target.value as AttendancePolicyTargetType, targetValue: "" })}>
                    <option value="default">Default</option>
                    <option value="job_title">Job Title</option>
                    <option value="employee_hr_id">Employee HR_ID</option>
                  </SearchableSelect>
                </label>
                {form.targetType === "job_title" ? (
                  <label className="space-y-1.5 md:col-span-2 xl:col-span-3">
                    <span className={labelClassName}>Job Title</span>
                    <input className={fieldClassName} list="attendance-job-title-options" value={form.targetValue} onChange={(event) => setForm({ ...form, targetValue: event.target.value })} />
                    <datalist id="attendance-job-title-options">
                      {targetOptions.jobTitles.map((title) => <option key={title} value={title} />)}
                    </datalist>
                  </label>
                ) : null}
                {form.targetType === "employee_hr_id" ? (
                  <label className="space-y-1.5 md:col-span-2 xl:col-span-3">
                    <span className={labelClassName}>Employee HR_ID</span>
                    <SearchableSelect className={fieldClassName} value={form.targetValue} onChange={(event) => setForm({ ...form, targetValue: event.target.value })}>
                      <option value="">Select employee</option>
                      {targetOptions.employees.map((employee) => (
                        <option key={employee.hrId} value={employee.hrId}>{employee.fullName}</option>
                      ))}
                    </SearchableSelect>
                  </label>
                ) : null}
                <label className="space-y-1.5">
                  <span className={labelClassName}>Scheduled Start</span>
                  <input className={fieldClassName} type="time" value={form.scheduledStart} onChange={(event) => setForm({ ...form, scheduledStart: event.target.value })} />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClassName}>Scheduled End</span>
                  <input className={fieldClassName} type="time" value={form.scheduledEnd} onChange={(event) => setForm({ ...form, scheduledEnd: event.target.value })} />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClassName}>Daily Grace</span>
                  <input className={fieldClassName} min="0" type="number" value={form.graceMinutes} onChange={(event) => setForm({ ...form, graceMinutes: event.target.value })} />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClassName}>Effective From</span>
                  <input className={fieldClassName} type="date" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClassName}>Effective To</span>
                  <input className={fieldClassName} type="date" value={form.effectiveTo} onChange={(event) => setForm({ ...form, effectiveTo: event.target.value })} />
                </label>
                <label className="flex h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-inner shadow-slate-100/60">
                  <span>Active</span>
                  <input checked={form.isActive} className="h-4 w-4 accent-orange-600" type="checkbox" onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
                </label>
                <div className="space-y-2 md:col-span-2 xl:col-span-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className={labelClassName}>Custom Workdays</span>
                    {form.workingWeekdays.length > 0 ? (
                      <Button variant="secondary" type="button" onClick={() => setForm({ ...form, workingWeekdays: [] })}>
                        Use standard weekend policy
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {attendanceWeekdayOptions.map((day) => {
                      const selected = form.workingWeekdays.includes(String(day.value));
                      return (
                        <button
                          className={`h-9 rounded-lg border px-3 text-xs font-black transition ${
                            selected
                              ? "border-orange-400 bg-orange-50 text-orange-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                          }`}
                          key={day.value}
                          type="button"
                          onClick={() => toggleWorkingWeekday(day.value)}
                        >
                          {day.shortLabel}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs font-semibold text-slate-500">
                    Empty uses the standard company weekend rules. Selected days become the only expected attendance days.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <Button variant="secondary" type="button" onClick={applyStandardSchedule}>
                  <Clock3 className="h-4 w-4" />
                  9-5 + 10 min grace
                </Button>
                <Button variant="secondary" type="button" onClick={applyShortSchedule}>10-4 special</Button>
              </div>

              <div className="space-y-4 rounded-xl border border-orange-200 bg-orange-50/50 p-4">
                <div>
                  <p className={sectionTitleClassName}>Flexible Hours</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Optional. Set Required Minutes to enroll this policy&apos;s employees in the flexible-hours evaluation
                    used by the Fingerprint Report and Payroll Copilot&apos;s attendance-deduction tab. Leave both blank
                    to keep this policy on the legacy fixed-schedule engine.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <label className="space-y-1.5">
                    <span className={labelClassName}>Flex Minutes</span>
                    <input
                      className={fieldClassName}
                      min="0"
                      placeholder="e.g. 30"
                      type="number"
                      value={form.flexMinutes}
                      onChange={(event) => setForm({ ...form, flexMinutes: event.target.value })}
                    />
                    <p className="text-phx-xs font-semibold text-slate-500">Arrival free past Scheduled Start (30 = free until 09:30).</p>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClassName}>Required Minutes</span>
                    <input
                      className={fieldClassName}
                      min="0"
                      placeholder="e.g. 470"
                      type="number"
                      value={form.requiredMinutes}
                      onChange={(event) => setForm({ ...form, requiredMinutes: event.target.value })}
                    />
                    <p className="text-phx-xs font-semibold text-slate-500">Minimum required presence (470 = 7h50m).</p>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClassName}>Half-Day Split</span>
                    <input
                      className={fieldClassName}
                      min="0"
                      placeholder="780"
                      type="number"
                      value={form.halfDaySplitMinutes}
                      onChange={(event) => setForm({ ...form, halfDaySplitMinutes: event.target.value })}
                    />
                    <p className="text-phx-xs font-semibold text-slate-500">Minute-of-day boundary for AM/PM half-day leave (780 = 13:00).</p>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClassName}>Judged</span>
                    <SearchableSelect
                      className={fieldClassName}
                      value={form.judgmentMode}
                      onChange={(event) => setForm({ ...form, judgmentMode: event.target.value as AttendanceJudgmentMode })}
                    >
                      <option value="every_working_day">Every working day</option>
                      <option value="office_days_only">Office days only (NSM/GPM/PM)</option>
                    </SearchableSelect>
                    <p className="text-phx-xs font-semibold text-slate-500">Office-days-only requires the plan to say office AND a punch that day.</p>
                  </label>
                </div>
              </div>
            </div>

            <aside className="border-t border-slate-100 bg-gradient-to-br from-slate-950 via-slate-900 to-black p-5 text-white xl:border-l xl:border-t-0">
              <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.18em] text-orange-200">
                <BadgeCheck className="h-4 w-4" />
                Draft Snapshot
              </div>
              <div className="mt-5 space-y-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Scope</p>
                  <p className="mt-1 text-lg font-black text-white">{formatTargetType(form.targetType)}</p>
                  <p className="mt-1 text-sm leading-5 text-slate-300">{policyScopeDetail(form)}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-white/10 bg-white/[0.06] p-3">
                    <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Shift</p>
                    <p className="mt-1 text-sm font-black text-white">{form.scheduledStart} - {form.scheduledEnd}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-white/[0.06] p-3">
                    <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Grace</p>
                    <p className="mt-1 text-sm font-black text-white">{form.graceMinutes || 0} minutes</p>
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.06] p-3">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Workdays</p>
                  <p className="mt-1 text-sm font-black text-white">{formatAttendanceWorkingWeekdays(form.workingWeekdays)}</p>
                </div>
                <div className="rounded-lg border border-orange-400/25 bg-orange-500/10 p-3">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-200">Rules Drafted</p>
                  <p className="mt-1 text-2xl font-black text-white">{form.rules.length}</p>
                </div>
              </div>
            </aside>
          </div>

          <div className="border-t border-slate-100 bg-white p-5">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className={sectionTitleClassName}>Rules</p>
                <p className="mt-1 text-sm text-slate-500">Late, early-leave, absence, single-punch, and exception brackets.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" onClick={() => addRule()}>
                  <Plus className="h-4 w-4" />
                  Add rule
                </Button>
                <Button variant="secondary" type="button" onClick={applyStandardLateRules}>
                  Late brackets
                </Button>
                <Button variant="secondary" type="button" onClick={addNoDeductionWindow}>
                  11-15 no deduction
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => addRule({ eventType: "exception", recommendedAction: "Manual exception review" })}
                >
                  <Plus className="h-4 w-4" />
                  Add exception
                </Button>
              </div>
            </div>
            {form.rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-semibold text-slate-600">
                No rules in this policy. Add a rule above, or save the policy with no rule brackets.
              </div>
            ) : null}
            {ruleIssues.length > 0 ? (
              <div className="mb-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
                <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em]">
                  <FileWarning className="h-4 w-4" />
                  Validation
                </div>
                {ruleIssues.slice(0, 4).map((issue) => <p key={issue}>{issue}</p>)}
              </div>
            ) : null}
            <div className="space-y-3">
              {form.rules.map((rule, index) => (
                <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)]" key={index}>
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-xs font-black text-white">{index + 1}</span>
                      <div>
                        <p className={labelClassName}>Rule Type</p>
                        <p className="text-sm font-black text-slate-950">{eventLabel(rule.eventType)}</p>
                      </div>
                    </div>
                    <Button variant="destructive" type="button" onClick={() => removeRule(index)}>
                      <Trash2 className="h-4 w-4" />
                      Delete rule
                    </Button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                    <label className="space-y-1.5">
                      <span className={labelClassName}>Event</span>
                      <SearchableSelect className={fieldClassName} value={rule.eventType} onChange={(event) => updateRule(index, { eventType: event.target.value as AttendancePolicyEventType })}>
                        <option value="late">Late</option>
                        <option value="early_leave">Early leave</option>
                        <option value="single_punch">Single punch</option>
                        <option value="absence">Absence</option>
                        <option value="exception">Exception</option>
                      </SearchableSelect>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClassName}>From min</span>
                      <input className={fieldClassName} placeholder="From min" type="number" value={rule.fromMinutes} onChange={(event) => updateRule(index, { fromMinutes: event.target.value })} />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClassName}>To min</span>
                      <input className={fieldClassName} placeholder="To min" type="number" value={rule.toMinutes} onChange={(event) => updateRule(index, { toMinutes: event.target.value })} />
                    </label>
                    <label className="space-y-1.5 md:col-span-2 xl:col-span-2">
                      <span className={labelClassName}>Recommended Action</span>
                      <input className={fieldClassName} placeholder="Recommended action" value={rule.recommendedAction} onChange={(event) => updateRule(index, { recommendedAction: event.target.value })} />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClassName}>Day fraction</span>
                      <input className={fieldClassName} list="attendance-deduction-day-options" placeholder="Day fraction" step="0.125" type="number" value={rule.deductionDays} onChange={(event) => updateRule(index, { deductionDays: event.target.value, deductionValue: "" })} />
                    </label>
                    <label className="flex h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-inner shadow-slate-100/60 md:col-span-2 xl:col-span-1">
                      <span>Active</span>
                      <input checked={rule.isActive} className="h-4 w-4 accent-orange-600" type="checkbox" onChange={(event) => updateRule(index, { isActive: event.target.checked })} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <datalist id="attendance-deduction-day-options">
              <option value="0" />
              <option value="0.125" />
              <option value="0.25" />
              <option value="0.5" />
              <option value="1" />
            </datalist>
          </div>

          <div className="border-t border-slate-100 bg-slate-50/70 p-5">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className={sectionTitleClassName}>Rule Preview</p>
                <p className="mt-1 text-sm text-slate-500">Example base salary: 15,000</p>
              </div>
              <Badge variant={ruleIssues.length > 0 ? "warning" : "success"}>
                {ruleIssues.length > 0 ? `${ruleIssues.length} draft issue${ruleIssues.length > 1 ? "s" : ""}` : "Ready to save"}
              </Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {previews.map((preview) => {
                const tone = previewToneClasses(preview.status);
                return (
                  <div className={`relative overflow-hidden rounded-xl border p-4 shadow-[0_12px_26px_rgba(15,23,42,0.06)] ${tone.surface}`} key={preview.label}>
                    <span className={`absolute inset-y-0 left-0 w-1 ${tone.accent}`} />
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{preview.label}</p>
                      <span className={`rounded-full border px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.12em] ${tone.badge}`}>{preview.status}</span>
                    </div>
                    <p className="mt-3 text-base font-black text-slate-950">{preview.time}</p>
                    <p className="mt-2 min-h-10 text-sm font-semibold leading-5 text-slate-700">{preview.result}</p>
                    <p className="mt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                      {preview.deductionDays || "0"} day / {preview.amount || "0"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-white p-5">
            <Button variant="secondary" type="button" onClick={() => setForm(blankPolicy())}>New</Button>
            <Button disabled={!canUpdate || saving} type="button" onClick={savePolicy}>
              <Save className="h-4 w-4" />
              {saving ? "Saving" : "Save policy"}
            </Button>
          </div>
        </AdminTableShell>
      </div>

      <AdminTableShell
        description="Priority is HR_ID policy, then job title policy, then default policy."
        title="Configured Policies"
      >
        {/* Seven columns, three of which carry stacked sub-content. Unlike the device-mapping
            table above, nothing here holds an unsaved draft — Edit and Delete both act on parent
            state — so a separate card list is safe. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No attendance policies configured yet."
              title="No policies"
            />
          }
          getKey={(policy) => String(policy.id)}
          items={data?.policies ?? []}
          renderCard={(policy) => (
            <PortalRecordCard
              accent={policy.isActive ? "emerald" : "slate"}
              actions={policyActions(policy)}
              meta={
                <span>
                  {policy.effectiveFrom}
                  {policy.effectiveTo ? ` to ${policy.effectiveTo}` : ""}
                </span>
              }
              status={
                policy.isActive ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="neutral">Inactive</Badge>
                )
              }
              title={policy.policyName}
            >
              <PortalRecordFields
                fields={[
                  {
                    label: "Target",
                    value: (
                      <span className="space-y-1">
                        {targetBadge(policy)}
                        <span className="block font-semibold">{targetLabel(policy)}</span>
                      </span>
                    ),
                  },
                  {
                    label: "Schedule",
                    value: `${policy.scheduledStart} - ${policy.scheduledEnd} · ${formatAttendanceWorkingWeekdays(policy.workingWeekdays)}`,
                  },
                  { label: "Grace", value: `${policy.graceMinutes} min daily` },
                  {
                    label: "Rules",
                    value:
                      policy.rules.length === 0
                        ? "No rules"
                        : policy.rules.map((rule) => ruleSummary(rule)).join(" · "),
                  },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[18%]" />
                  <col className="w-[20%]" />
                  <col className="w-[22%]" />
                  <col className="w-[8%]" />
                  <col className="w-[14%]" />
                </colgroup>
              }
            >
              <thead className="bg-slate-950 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-200">
                <tr>
                  <th className="px-3 py-3">Policy</th>
                  <th className="px-3 py-3">Target</th>
                  <th className="px-3 py-3">Schedule</th>
                  <th className="px-3 py-3">Rules</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {(data?.policies ?? []).map((policy) => (
                  <tr className="border-b border-slate-100 bg-white transition hover:bg-orange-50/40 last:border-0" key={policy.id}>
                    <td className="break-words px-3 py-3">
                      <p className="font-black text-slate-950">{policy.policyName}</p>
                      <p className="text-xs text-slate-500">{policy.effectiveFrom}{policy.effectiveTo ? ` to ${policy.effectiveTo}` : ""}</p>
                    </td>
                    <td className="break-words px-3 py-3">
                      <div className="space-y-1">
                        {targetBadge(policy)}
                        <p className="text-sm font-semibold text-slate-700">{targetLabel(policy)}</p>
                      </div>
                    </td>
                    <td className="break-words px-3 py-3">
                      <span className="block text-sm font-black text-slate-800">{policy.scheduledStart} - {policy.scheduledEnd}</span>
                      <span className="block text-xs font-semibold text-slate-500">{formatAttendanceWorkingWeekdays(policy.workingWeekdays)}</span>
                      <span className="block text-xs font-semibold text-slate-500">{policy.graceMinutes} min grace daily</span>
                    </td>
                    <td className="break-words px-3 py-3 text-sm text-slate-700">
                      {policy.rules.length === 0 ? (
                        <span className="font-semibold text-slate-400">No rules</span>
                      ) : (
                        <div className="space-y-1.5">
                          {policy.rules.slice(0, 2).map((rule) => (
                            <div className="bg-slate-50 px-3 py-2 font-semibold" key={rule.id}>{ruleSummary(rule)}</div>
                          ))}
                          {policy.rules.length > 2 ? <p className="text-xs font-black uppercase tracking-[0.12em] text-orange-700">+{policy.rules.length - 2} more</p> : null}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">{policy.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Inactive</Badge>}</td>
                    <td className="px-3 py-3 text-right">{policyActions(policy)}</td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </AdminTableShell>
    </div>
  );
}
