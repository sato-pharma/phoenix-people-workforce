"use client";

import { Check } from "lucide-react";

import { dayLabel } from "@/components/phoenix-crm/format";
import type { CompanyPerson } from "@/components/phoenix-crm/visit-company-picker";
import { CrmChoice, CrmNote, type CrmChoiceOption } from "@/components/phoenix-crm/ui";
import { DOUBLE_VISIT_MAX_DAYS, toggleDoubleVisitDay, toggleDoubleVisitPerson } from "@/lib/phoenix-crm/double-visit-request-rules";
import { companionGroupTitle } from "@/lib/phoenix-crm/visit-ask-rules";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the LAST question of Add visit (owner, 2026-10-16): "Do you need a double visit with
 * this customer?"
 *
 * Asked of an AM or PM customer only, when the rep records his own visit. It starts on No, and a rep who
 * leaves it on No is asked nothing more (Golden Rule #1: the rep's app is easy). On Yes he sees the
 * people he may ask — his managers and his line's product managers, the very list "Who was on the visit"
 * offers — ticks any number of them, and chooses up to three DAYS (a day, never a clock time). The
 * people he ticks are each told, and each accepts one of his days or declines on the managers' report;
 * the answers come back to him on the customer's page, where he can change the days and never cancel.
 *
 * Nothing here is saved by itself: the answer rides in the visit's save as `doubleVisit`, and the server
 * raises the request after the visit is saved. The rules are `double-visit-request-rules.ts`.
 */

export type DoubleVisitAnswerDraft = { wanted: boolean; hrIds: string[]; days: string[] };

export const NO_DOUBLE_VISIT: DoubleVisitAnswerDraft = { wanted: false, hrIds: [], days: [] };

const CHOICES: ReadonlyArray<CrmChoiceOption<"no" | "yes">> = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes", note: "Ask a manager to join you" },
];

export function DoubleVisitQuestion({
  cairoToday,
  dayChoices,
  disabled,
  offers,
  onChange,
  value,
}: {
  cairoToday: string;
  dayChoices: ReadonlyArray<string>;
  disabled: boolean;
  offers: ReadonlyArray<CompanyPerson>;
  onChange: (next: DoubleVisitAnswerDraft) => void;
  value: DoubleVisitAnswerDraft;
}) {
  const managers = offers.filter((person) => person.role === "manager");
  const productManagers = offers.filter((person) => person.role === "product_manager");
  const namesPicked = value.hrIds.map((hrId) => offers.find((person) => person.hrId === hrId)?.name).filter(Boolean) as string[];
  const daysText = [...value.days].sort().map((day) => dayLabel(day)).join(" or ");
  const summary =
    namesPicked.length > 0 && value.days.length > 0
      ? `${namesPicked.join(", ")} will be asked for ${daysText}`
      : namesPicked.length > 0
        ? `${namesPicked.join(", ")} will be asked. Now choose at least one day`
        : value.days.length > 0
          ? `Choose at least one person for ${daysText}`
          : "Choose at least one person and at least one day";

  function person(entry: CompanyPerson) {
    const chosen = value.hrIds.includes(entry.hrId);
    return (
      <button
        aria-pressed={chosen}
        className={cn(
          "flex min-h-11 w-full min-w-0 items-start justify-between gap-2 rounded-none border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
          chosen ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
        )}
        disabled={disabled}
        key={entry.hrId}
        onClick={() => onChange({ ...value, hrIds: toggleDoubleVisitPerson(value.hrIds, entry.hrId) })}
        type="button"
      >
        <span className="min-w-0">
          <span className="block break-words text-sm font-black">{entry.name}</span>
          <span className={cn("block break-words text-xs font-semibold", chosen ? "text-orange-50" : "text-slate-500")}>{entry.title}</span>
        </span>
        {chosen ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : null}
      </button>
    );
  }

  return (
    <div className="grid min-w-0 gap-3" id="phoenix-crm-visit-double">
      <CrmChoice
        columns={2}
        label="Do you need a double visit with this customer?"
        onChange={(next) => onChange(next === "yes" ? { ...value, wanted: true } : NO_DOUBLE_VISIT)}
        options={CHOICES.map((option) => ({ ...option, disabled }))}
        value={value.wanted ? "yes" : "no"}
      />
      {value.wanted ? (
        <>
          <div className="grid min-w-0 gap-2">
            <p className="text-sm font-black text-slate-800">Who do you need? Tick as many as you want.</p>
            {managers.length > 0 ? (
              <div className="grid min-w-0 gap-1.5">
                <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">Managers</p>
                {managers.map(person)}
              </div>
            ) : null}
            {productManagers.length > 0 ? (
              <div className="grid min-w-0 gap-1.5">
                <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">{companionGroupTitle(productManagers)}</p>
                {productManagers.map(person)}
              </div>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-2">
            <p className="text-sm font-black text-slate-800">Which days suit you? Choose up to {DOUBLE_VISIT_MAX_DAYS}.</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {dayChoices.map((day) => {
                const chosen = value.days.includes(day);
                return (
                  <button
                    aria-pressed={chosen}
                    className={cn(
                      "flex min-h-11 min-w-0 items-start justify-between gap-2 rounded-none border px-3 py-2 text-left text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                      chosen ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                    )}
                    disabled={disabled || (!chosen && value.days.length >= DOUBLE_VISIT_MAX_DAYS)}
                    key={day}
                    onClick={() => onChange({ ...value, days: toggleDoubleVisitDay(value.days, day) })}
                    type="button"
                  >
                    <span className="min-w-0 break-words">{day === cairoToday ? `${dayLabel(day)} · today` : dayLabel(day)}</span>
                    {chosen ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <CrmNote tone="info">
            {summary}. Each person accepts one of your days or declines, and the answers show on this customer&apos;s page. You can change the days
            later.
          </CrmNote>
        </>
      ) : null}
    </div>
  );
}
