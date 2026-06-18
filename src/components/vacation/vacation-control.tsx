"use client";

import { AlertCircle, CalendarClock, Save } from "lucide-react";
import { useMemo, useState } from "react";

import { AdminCallout, AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/layout/page-container";
import type { VacationControlData, VacationWeeklyOffMode, VacationWeeklyOffPolicyRecord } from "@/lib/vacation/types";
import { VACATION_WEEKLY_OFF_MODES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type VacationControlProps = {
  initialData: VacationControlData | null;
  initialError: string | null;
};

type DraftPolicy = Pick<VacationWeeklyOffPolicyRecord, "friday" | "jobTitle" | "saturday" | "thursday">;

const dayFields = [
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
] as const;

function policyKey(policy: DraftPolicy) {
  return `${policy.thursday}|${policy.friday}|${policy.saturday}`;
}

export function VacationControl({ initialData, initialError }: VacationControlProps) {
  const [policies, setPolicies] = useState<VacationWeeklyOffPolicyRecord[]>(initialData?.policies ?? []);
  const [drafts, setDrafts] = useState<Record<string, DraftPolicy>>(() =>
    Object.fromEntries((initialData?.policies ?? []).map((policy) => [policy.jobTitle, {
      friday: policy.friday,
      jobTitle: policy.jobTitle,
      saturday: policy.saturday,
      thursday: policy.thursday,
    }])),
  );
  const [error, setError] = useState(initialError);
  const [savingTitle, setSavingTitle] = useState<string | null>(null);

  const policyMap = useMemo(() => new Map(policies.map((policy) => [policy.jobTitle, policy])), [policies]);

  function updateDraft(jobTitle: string, field: keyof Omit<DraftPolicy, "jobTitle">, value: VacationWeeklyOffMode) {
    setDrafts((current) => ({
      ...current,
      [jobTitle]: {
        ...(current[jobTitle] ?? {
          friday: "full_day",
          jobTitle,
          saturday: "working",
          thursday: "working",
        }),
        [field]: value,
      },
    }));
  }

  async function savePolicy(jobTitle: string) {
    const draft = drafts[jobTitle];
    if (!draft) return;

    setSavingTitle(jobTitle);
    setError(null);
    try {
      const response = await fetch("/api/vacations/control", {
        body: JSON.stringify(draft),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation control update failed.");
      }
      const policy = payload.policy as VacationWeeklyOffPolicyRecord;
      setPolicies((current) => {
        const next = current.filter((entry) => entry.jobTitle !== policy.jobTitle);
        return [...next, policy].sort((left, right) => left.jobTitle.localeCompare(right.jobTitle));
      });
      setDrafts((current) => ({
        ...current,
        [policy.jobTitle]: {
          friday: policy.friday,
          jobTitle: policy.jobTitle,
          saturday: policy.saturday,
          thursday: policy.thursday,
        },
      }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Vacation control update failed.");
    } finally {
      setSavingTitle(null);
    }
  }

  return (
    <PageContainer className="max-w-none">
      <AdminPageHero
        description="Control weekly off days by job title. Friday is default full off unless changed here."
        eyebrow="Leave Management"
        icon={<CalendarClock className="h-3.5 w-3.5" />}
        title="Vacation Control"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <div className="divide-y divide-slate-100 md:hidden">
          {policies.map((policy) => {
            const draft = drafts[policy.jobTitle] ?? policy;
            const dirty = policyKey(draft) !== policyKey(policyMap.get(policy.jobTitle) ?? policy);
            return (
              <div className="bg-white p-4" key={policy.jobTitle}>
                <div className="min-w-0">
                  <p className="break-words text-sm font-black text-slate-950">{policy.jobTitle}</p>
                  <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                    Used by vacation duration calculation.
                  </p>
                </div>
                <div className="mt-4 grid gap-3">
                  {dayFields.map((field) => (
                    <label className="grid gap-1.5" key={field.key}>
                      <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{field.label}</span>
                      <SearchableSelect
                        className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold"
                        value={draft[field.key]}
                        onChange={(event) => updateDraft(policy.jobTitle, field.key, event.target.value as VacationWeeklyOffMode)}
                      >
                        {VACATION_WEEKLY_OFF_MODES.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </SearchableSelect>
                    </label>
                  ))}
                </div>
                <Button
                  className="mt-4 w-full gap-2 rounded-lg bg-slate-950 font-black text-white hover:bg-slate-800"
                  disabled={!dirty || savingTitle === policy.jobTitle}
                  onClick={() => savePolicy(policy.jobTitle)}
                  type="button"
                >
                  <Save className="h-4 w-4" />
                  {savingTitle === policy.jobTitle ? "Saving..." : "Save"}
                </Button>
              </div>
            );
          })}
          {policies.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm font-semibold text-slate-500">
              No job titles found in the employee directory.
            </div>
          ) : null}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[980px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Job title</th>
                {dayFields.map((field) => (
                  <th className="px-4 py-3" key={field.key}>{field.label}</th>
                ))}
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {policies.map((policy) => {
                const draft = drafts[policy.jobTitle] ?? policy;
                const dirty = policyKey(draft) !== policyKey(policyMap.get(policy.jobTitle) ?? policy);
                return (
                  <tr className="bg-white align-middle" key={policy.jobTitle}>
                    <td className="px-4 py-4">
                      <p className="font-black text-slate-950">{policy.jobTitle}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        Used by vacation duration calculation for employees with this title.
                      </p>
                    </td>
                    {dayFields.map((field) => (
                      <td className="px-4 py-4" key={field.key}>
                        <SearchableSelect
                          className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold"
                          value={draft[field.key]}
                          onChange={(event) => updateDraft(policy.jobTitle, field.key, event.target.value as VacationWeeklyOffMode)}
                        >
                          {VACATION_WEEKLY_OFF_MODES.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </SearchableSelect>
                      </td>
                    ))}
                    <td className="px-4 py-4">
                      <Button
                        className="gap-2 rounded-xl bg-slate-950 font-black text-white hover:bg-slate-800"
                        disabled={!dirty || savingTitle === policy.jobTitle}
                        onClick={() => savePolicy(policy.jobTitle)}
                        type="button"
                      >
                        <Save className="h-4 w-4" />
                        {savingTitle === policy.jobTitle ? "Saving..." : "Save"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {policies.length === 0 ? (
                <tr>
                  <td className="px-4 py-10 text-center text-sm font-semibold text-slate-500" colSpan={5}>
                    No job titles found in the employee directory.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </PageContainer>
  );
}
