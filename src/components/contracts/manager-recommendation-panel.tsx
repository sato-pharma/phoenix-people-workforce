"use client";

import Link from "next/link";
import { useState } from "react";

import { CheckTile, FormActions, FormBlock, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFormPanelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { Badge } from "@/components/ui/badge";
import {
  CONTRACT_RECOMMENDATION_NOTE_MAX,
  contractRecommendationLabels,
  type ManagerRecommendationContext,
} from "@/lib/contracts/manager-recommendation-labels";
import type { ContractManagerRecommendationValue } from "@/lib/contracts/types";
import { formatDateOnly } from "@/lib/date-only";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

type ReadyContext = Extract<ManagerRecommendationContext, { state: "ready" }>;

function formatRenewalDate(value: string) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "long", year: "numeric" });
}

function dueText(daysUntil: number | null) {
  if (daysUntil === null) return null;
  if (daysUntil < 0) return `${Math.abs(daysUntil)} days ago`;
  if (daysUntil === 0) return "today";
  return `in ${daysUntil} days`;
}

/**
 * The manager's answer to a contract renewal reminder. HR and the Super Admin reach the same page
 * from the same email and read every answer here, with the way to the Contract Renewal board.
 */
export function ManagerRecommendationPanel({
  boardHref,
  initialContext,
}: {
  boardHref: string;
  initialContext: ReadyContext;
}) {
  const [context, setContext] = useState<ReadyContext>(initialContext);
  const [choice, setChoice] = useState<ContractManagerRecommendationValue | null>(initialContext.mine?.recommendation ?? null);
  const [note, setNote] = useState(initialContext.mine?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function submit() {
    if (!choice) {
      setError("Choose Renew or Do not renew.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/contract-recommendations", {
        body: JSON.stringify({ employeeHrId: context.employee.hrId, note, recommendation: choice }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { success: true; context: ManagerRecommendationContext }
        | { success: false; error?: string }
        | null;
      if (!response.ok || !payload || !payload.success) {
        setError((payload && !payload.success && payload.error) || "The recommendation could not be saved.");
        return;
      }
      if (payload.context.state === "ready") setContext(payload.context);
      setSavedAt(new Date().toISOString());
    } catch {
      setError("The recommendation could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const { employee } = context;
  const due = dueText(context.daysUntil);

  return (
    <div className="space-y-4">
      <div className={phxFormPanelClassName}>
        <div className="space-y-1 border-b border-slate-200 px-4 py-3">
          <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Contract renewal</p>
          <h2 className="break-words text-lg font-black text-slate-900">{employee.name}</h2>
          <p className="break-words text-sm text-slate-600">{employee.jobTitle}</p>
        </div>
        <dl className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          {[
            { label: "Renewal date", value: `${formatRenewalDate(context.renewalDate)}${due ? ` (${due})` : ""}` },
            { label: "Reports to", value: employee.managerName ?? "—" },
            { label: "Line", value: employee.line || "—" },
            { label: "Area", value: employee.area || "—" },
          ].map((field) => (
            <div className="bg-white px-4 py-2.5" key={field.label}>
              <dt className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">{field.label}</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-slate-900">{field.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {context.canRecommend ? (
        <FormBlock label="Your recommendation">
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(["renew", "do_not_renew"] as const).map((value) => (
                <CheckTile
                  checked={choice === value}
                  key={value}
                  name="recommendation"
                  onChange={(checked) => checked && setChoice(value)}
                  type="radio"
                >
                  <span className="text-sm font-bold text-slate-900">{contractRecommendationLabels[value]}</span>
                </CheckTile>
              ))}
            </div>
            <FormField
              hint="HR reads this on the Contract Renewal board."
              htmlFor="contract-recommendation-note"
              label="Note (optional)"
            >
              <textarea
                className={phxTextareaClassName}
                id="contract-recommendation-note"
                maxLength={CONTRACT_RECOMMENDATION_NOTE_MAX}
                onChange={(event) => setNote(event.target.value)}
                rows={4}
                value={note}
              />
            </FormField>
            <FormError>{error}</FormError>
            {savedAt ? (
              <p className="text-sm font-semibold text-emerald-700" role="status">
                Saved. HR can see your recommendation now.
              </p>
            ) : null}
            <FormActions
              right={
                <button className={phxButtonAccentClassName} disabled={saving} onClick={submit} type="button">
                  {saving ? "Saving…" : context.mine ? "Update recommendation" : "Send recommendation"}
                </button>
              }
            />
          </div>
        </FormBlock>
      ) : null}

      <FormBlock
        action={context.canOpenBoard ? <Link className={phxButtonGhostClassName} href={boardHref}>Open Contract Renewal</Link> : undefined}
        label="Recommendations"
      >
        {context.recommendations.length === 0 ? (
          <p className="text-sm text-slate-600">No manager has recommended on this renewal yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {context.recommendations.map((item) => (
              <li className="space-y-1 py-2.5 first:pt-0 last:pb-0" key={`${item.recommenderHrId}-${item.updatedAt}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-900">{item.recommenderName ?? "A manager"}</span>
                  <Badge tone={item.recommendation === "renew" ? "ok" : "danger"}>
                    {contractRecommendationLabels[item.recommendation]}
                  </Badge>
                  <span className="text-xs text-slate-500">{cairoDateTime(item.updatedAt)}</span>
                </div>
                {item.note ? <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{item.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </FormBlock>
    </div>
  );
}
