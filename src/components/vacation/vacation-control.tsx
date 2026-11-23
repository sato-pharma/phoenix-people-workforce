"use client";

import { CalendarClock, Save } from "lucide-react";
import { useMemo, useState } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_INK, LandingRailLine, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { phxLabelTextClassName } from "@/components/ui/form-tokens";
import { PageContainer } from "@/components/layout/page-container";
import type { VacationControlData, VacationWeeklyOffMode, VacationWeeklyOffPolicyRecord } from "@/lib/vacation/types";
import { VACATION_WEEKLY_OFF_MODES } from "@/lib/vacation/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


type VacationControlProps = {
  initialData: VacationControlData | null;
  initialError: string | null;
  /** The admin page shows its own title line; the portal page already has one and passes false. */
  showHero?: boolean;
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

export function VacationControl({ initialData, initialError, showHero = true }: VacationControlProps) {
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

  const saveButton = (jobTitle: string, dirty: boolean, className?: string) => (
    <button
      className={landingActionClassName("solid", className)}
      disabled={!dirty || savingTitle === jobTitle}
      onClick={() => savePolicy(jobTitle)}
      type="button"
    >
      <Save aria-hidden="true" className="h-3.5 w-3.5" />
      {savingTitle === jobTitle ? "Saving..." : "Save"}
    </button>
  );

  return (
    <PageContainer className="max-w-none">
      {/* The portal page draws its own title band, so it turns this one off — one title per page. */}
      {showHero ? (
        <AdminPageHero
          description="Control weekly off days by job title. Friday is default full off unless changed here."
          eyebrow="Leave Management"
          icon={<CalendarClock className="h-3.5 w-3.5" />}
          title="Vacation Control"
        />
      ) : null}

      {error ? (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`} role="alert">
          <LandingRailLine rail="bg-rose-500">{error}</LandingRailLine>
        </div>
      ) : null}

      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        {/* Phone: one ruled block per job title, its three days stacked, Save under them. */}
        <div className="divide-y divide-slate-200 md:hidden">
          {policies.map((policy) => {
            const draft = drafts[policy.jobTitle] ?? policy;
            const dirty = policyKey(draft) !== policyKey(policyMap.get(policy.jobTitle) ?? policy);
            return (
              <div className="px-3 py-4" key={policy.jobTitle}>
                <p className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{policy.jobTitle}</p>
                <div className="mt-3 grid gap-3">
                  {dayFields.map((field) => (
                    <label className="grid gap-1.5" key={field.key}>
                      <span className={phxLabelTextClassName}>{field.label}</span>
                      <SearchableSelect
                        className="w-full px-3"
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
                {saveButton(policy.jobTitle, dirty, "mt-4 w-full")}
              </div>
            );
          })}
          {policies.length === 0 ? (
            <p className="px-3 py-8 text-center text-phx-sm font-medium text-slate-500">
              No job titles found in the employee directory.
            </p>
          ) : null}
        </div>

        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-[25%]" />
              <col className="w-[20%]" />
              <col className="w-[20%]" />
              <col className="w-[20%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead className="bg-white text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2.5">Job title</th>
                {dayFields.map((field) => (
                  <th className="border-b border-slate-200 px-4 py-2.5" key={field.key}>{field.label}</th>
                ))}
                <th className="border-b border-slate-200 px-4 py-2.5">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {policies.map((policy) => {
                const draft = drafts[policy.jobTitle] ?? policy;
                const dirty = policyKey(draft) !== policyKey(policyMap.get(policy.jobTitle) ?? policy);
                return (
                  <tr className="bg-white align-middle" key={policy.jobTitle}>
                    <td className="px-4 py-3">
                      <p className={`break-words font-bold ${LANDING_INK}`} dir="auto">{policy.jobTitle}</p>
                    </td>
                    {dayFields.map((field) => (
                      <td className="px-4 py-3" key={field.key}>
                        <SearchableSelect
                          aria-label={`${field.label} for ${policy.jobTitle}`}
                          className="w-full px-3"
                          value={draft[field.key]}
                          onChange={(event) => updateDraft(policy.jobTitle, field.key, event.target.value as VacationWeeklyOffMode)}
                        >
                          {VACATION_WEEKLY_OFF_MODES.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </SearchableSelect>
                      </td>
                    ))}
                    <td className="px-4 py-3">{saveButton(policy.jobTitle, dirty)}</td>
                  </tr>
                );
              })}
              {policies.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-phx-sm font-medium text-slate-500" colSpan={5}>
                    No job titles found in the employee directory.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </PageContainer>
  );
}
