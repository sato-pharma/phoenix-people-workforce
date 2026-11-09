"use client";

import { Check } from "lucide-react";

import { canPick, companyHint, togglePick, type CompanyOffer, type VisitCompanyChoice } from "@/lib/phoenix-crm/visit-company";
import { companionGroupTitle } from "@/lib/phoenix-crm/visit-ask-rules";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — who was on a visit, picked from ONE list.
 *
 * Owner, 2026-10-06: under Double visit the rep's district manager, the product manager and the national
 * sales manager appear (and the regional manager where his line has one) and he chooses ONE; under Chain
 * visit the same list appears and he chooses TWO OR MORE, in any mix (2026-10-27: "Everything is
 * applicable"). The rule is `visit-company.ts`; this is only the
 * list, shared by the rep's visit form and the Super Admin's correction so the two can never offer
 * different people.
 *
 * Managers first, nearest to the territory first, each by their organogram title, then the line's
 * product side by their own job titles — a separate heading, because they sit on no rung of the chain. Every person is a full-width button that wraps
 * (`min-w-0 break-words`), never a column that scrolls sideways.
 */

export type CompanyPerson = CompanyOffer & { name: string; title: string };

export function CompanyPicker({
  choice,
  disabled,
  onChange,
  people,
  picked,
}: {
  choice: Exclude<VisitCompanyChoice, "single">;
  disabled: boolean;
  onChange: (next: string[]) => void;
  people: ReadonlyArray<CompanyPerson>;
  picked: ReadonlyArray<string>;
}) {
  const managers = people.filter((person) => person.role === "manager");
  const productManagers = people.filter((person) => person.role === "product_manager");

  function row(person: CompanyPerson) {
    const chosen = picked.includes(person.hrId);
    const open = canPick(choice, picked, person);
    return (
      <button
        aria-pressed={chosen}
        className={cn(
          "flex min-h-11 w-full min-w-0 items-start justify-between gap-2 rounded-none border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
          chosen ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
        )}
        disabled={disabled || !open}
        key={person.hrId}
        onClick={() => onChange(togglePick(choice, picked, person.hrId))}
        type="button"
      >
        <span className="min-w-0">
          <span className="block break-words text-sm font-black">
            <bdi>{person.name}</bdi>
          </span>
          <span className={cn("mt-0.5 block break-words text-xs font-semibold", chosen ? "text-orange-50" : "text-slate-500")}>{person.title}</span>
        </span>
        {chosen ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : null}
      </button>
    );
  }

  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-xs font-semibold text-slate-500">{companyHint(choice, picked.length)}</p>
      {managers.length > 0 ? (
        <div className="grid min-w-0 gap-1.5">
          <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">Managers</p>
          {managers.map(row)}
        </div>
      ) : null}
      {productManagers.length > 0 ? (
        <div className="grid min-w-0 gap-1.5">
          <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">{companionGroupTitle(productManagers)}</p>
          {productManagers.map(row)}
        </div>
      ) : null}
    </div>
  );
}
