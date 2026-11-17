"use client";

import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { LIBANO_TABLE_OF_BENEFITS, TABLE_OF_BENEFITS_SOURCE, type BenefitLine, type BenefitText } from "@/lib/medical-insurance/benefits";
import { MEDICAL_INSURANCE_CATEGORIES, type MedicalInsuranceCategory } from "@/lib/medical-insurance/cost";
import type { MedicalInsuranceView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { cellClassName, headerClassName } from "./medical-insurance-parts";

const rightHeaderClassName = cn(headerClassName, "text-right");

/** English first, the signed Arabic beneath it. */
function Both({ strong = false, text }: { strong?: boolean; text: BenefitText }) {
  return (
    <>
      <span className={cn("block break-words text-phx-xs text-phx-ink", strong ? "font-black" : "font-bold")}>{text.en}</span>
      <span className="mt-0.5 block break-words text-phx-xs font-semibold text-phx-ink-soft" dir="rtl" lang="ar">{text.ar}</span>
    </>
  );
}

function BenefitName({ line }: { line: BenefitLine }) {
  return (
    <>
      <Both strong text={line.benefit} />
      {line.part ? (
        <span className="mt-1 block border-l-2 border-phx-line pl-2">
          <Both text={line.part} />
        </span>
      ) : null}
    </>
  );
}

/**
 * The table of benefits, one plan at a time: choose A, B or C and that plan's signed benefits appear, each
 * in English with the signed Arabic beneath. It carries no cost, so every seat that opens the page sees it.
 */
export function MedicalInsuranceBenefitsTab({ view }: { view: MedicalInsuranceView }) {
  const [plan, setPlan] = React.useState<MedicalInsuranceCategory>("A");
  const benefits = LIBANO_TABLE_OF_BENEFITS[plan];
  const peopleOn = (category: MedicalInsuranceCategory) => view.members.filter((member) => member.open && member.category === category).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-px border border-phx-line bg-phx-line" role="tablist" aria-label="Plan">
        {MEDICAL_INSURANCE_CATEGORIES.map((category) => {
          const people = peopleOn(category);
          return (
            <button
              aria-selected={plan === category}
              className={cn("border-b-2 border-transparent bg-white px-4 py-3 text-left hover:bg-phx-accent-soft", plan === category && "border-phx-accent bg-phx-accent-soft")}
              key={category}
              onClick={() => setPlan(category)}
              role="tab"
              type="button"
            >
              <span className="block break-words text-sm font-black text-phx-ink">Plan {category}</span>
              <span className="mt-1 block break-words text-phx-xs font-semibold text-phx-ink-soft">
                EGP {LIBANO_TABLE_OF_BENEFITS[category].annualLimit.toLocaleString("en-US")} a year, {people === 1 ? "1 person" : `${people} people`}
              </span>
            </button>
          );
        })}
      </div>

      <AdminTableShell description={TABLE_OF_BENEFITS_SOURCE} title={`Plan ${plan}: the table of benefits`}>
        <dl className="grid grid-cols-1 gap-px bg-phx-line sm:grid-cols-2 lg:grid-cols-5">
          {benefits.facts.map((fact) => (
            <div className="bg-white px-4 py-3" key={fact.label.en}>
              <dt className="text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{fact.label.en}</dt>
              <dd className="mt-0.5 break-words text-phx-2xs font-semibold text-phx-ink-faint" dir="rtl" lang="ar">{fact.label.ar}</dd>
              <dd className="mt-1 break-words text-sm font-black text-phx-ink">{fact.value.en}</dd>
              {fact.value.ar !== fact.value.en ? <dd className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="rtl" lang="ar">{fact.value.ar}</dd> : null}
            </div>
          ))}
        </dl>
      </AdminTableShell>

      {benefits.sections.map((section) => (
        <AdminTableShell description={section.title.ar} key={`${plan}:${section.key}`} title={section.title.en}>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[38%]" />
                <col className="w-[48%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Benefit</th>
                  <th className={headerClassName}>Cover</th>
                  <th className={rightHeaderClassName}>Member pays</th>
                </tr>
              </thead>
              <tbody>
                {section.lines.map((line) => (
                  <tr key={`${line.benefit.en}:${line.part?.en ?? ""}`}>
                    <td className={cellClassName}><BenefitName line={line} /></td>
                    <td className={cellClassName}><Both text={line.coverage} /></td>
                    <td className={cn(cellClassName, "break-words text-right text-sm font-black tabular-nums text-phx-ink")}>{line.memberShare ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 p-4 md:hidden">
            {section.lines.map((line) => (
              <div className="space-y-2 border border-phx-line bg-white p-3" key={`${line.benefit.en}:${line.part?.en ?? ""}`}>
                <BenefitName line={line} />
                <div className="border-t border-phx-line pt-2"><Both text={line.coverage} /></div>
                {line.memberShare ? <p className="break-words text-phx-xs font-black tabular-nums text-phx-ink">Member pays {line.memberShare}</p> : null}
              </div>
            ))}
          </div>
        </AdminTableShell>
      ))}
    </div>
  );
}
