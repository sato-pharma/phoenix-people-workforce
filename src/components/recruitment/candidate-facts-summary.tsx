"use client";

// Recruitment / ATS — "who this person is", in one block.
//
// Extracted from the profile drawer on 2026-08-24 so screening mode and the drawer show the SAME
// summary. It reads `candidateScreeningFacts`, so a confirmed column renders black and the CV
// reader's hedged answer renders grey italic with a "?" — one convention, one module, everywhere.

import type { StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
import {
  candidateScreeningFacts,
  formatYearsOfExperience,
  UNCONFIRMED_FACT_TITLE,
  unconfirmedCvFactsFromExtraction,
} from "@/lib/recruitment/candidate-screening-facts";
import type { Candidate } from "@/lib/recruitment/types";

type Cell = { hint?: string; label: string; unconfirmed?: boolean; value: string };

/**
 * The facts a screener needs, resolved once and laid out in a responsive grid.
 *
 * `columns` exists because the two callers have very different widths: the drawer runs the full
 * page and takes three, screening mode has a fixed side panel and takes one.
 */
export function CandidateFactsSummary({
  candidate,
  className,
  columns = 3,
  extraction,
}: {
  candidate: Candidate;
  className?: string;
  columns?: 1 | 2 | 3;
  extraction: StoredCvExtraction | null;
}) {
  const facts = candidateScreeningFacts({
    ...candidate,
    cvUnconfirmed: unconfirmedCvFactsFromExtraction(extraction?.fields),
  });

  const education = [candidate.degree, candidate.faculty, candidate.university].filter(Boolean).join(" · ");
  const graduated = candidate.graduationYear ? `Class of ${candidate.graduationYear}` : null;
  // The pharma tenure, when the CV gave dates for it. "2019 → 2024" beats a bare yes.
  const repFrom = candidate.medicalRepExperienceFrom?.slice(0, 4) ?? null;
  const repTo = candidate.medicalRepExperienceTo?.slice(0, 4) ?? null;
  const repSpan = repFrom ? `${repFrom} → ${repTo ?? "now"}` : null;

  const cells: Cell[] = [];
  if (facts.roleTitle) {
    cells.push({
      hint: facts.employer ? facts.employer.value : undefined,
      label: "Current role",
      unconfirmed: !facts.roleTitle.confirmed,
      value: facts.roleTitle.value,
    });
  }
  if (facts.employer) {
    cells.push({ label: "Employer", unconfirmed: !facts.employer.confirmed, value: facts.employer.value });
  }
  if (facts.years) {
    cells.push({
      label: "Experience",
      unconfirmed: !facts.years.confirmed,
      value: `${facts.years.confirmed ? "" : "~"}${formatYearsOfExperience(facts.years.value)}`,
    });
  }
  if (facts.pharmaRep) {
    cells.push({
      hint: repSpan ?? undefined,
      label: "Medical rep before",
      unconfirmed: !facts.pharmaRep.confirmed,
      value: facts.pharmaRep.value
        ? [candidate.medicalRepEmployer, repSpan].filter(Boolean).join(" · ") || "Yes"
        : "No",
    });
  }
  if (facts.governorate) {
    cells.push({
      hint: facts.region ? `${facts.region.value.label} region` : undefined,
      label: "Lives in",
      unconfirmed: !facts.governorate.confirmed,
      value: facts.region ? `${facts.governorate.value} · ${facts.region.value.label}` : facts.governorate.value,
    });
  }
  if (education) cells.push({ hint: graduated ?? undefined, label: "Studied", value: education });
  if (!education && graduated) cells.push({ label: "Studied", value: graduated });

  // Nothing known at all is itself worth saying out loud — silence reads as a rendering fault, and
  // the reader needs to know the CV is the only place left to look.
  if (cells.length === 0 && !candidate.professionalSummary) {
    return (
      <div className={`rounded-md border border-dashed border-slate-300 bg-slate-50/60 p-3 ${className ?? ""}`}>
        <p className="text-xs text-slate-600">
          Nothing has been read off this CV yet — read the document itself, or use “Read the CV again”.
        </p>
      </div>
    );
  }

  const gridColumns =
    columns === 1 ? "grid-cols-1" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div className={`rounded-md border border-slate-200 bg-white p-3 ${className ?? ""}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Who this is</p>
      <dl className={`mt-2 grid gap-x-6 gap-y-2 ${gridColumns}`}>
        {cells.map((cell) => (
          <div key={cell.label}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{cell.label}</dt>
            <dd
              className={`text-sm ${cell.unconfirmed ? "italic text-slate-500" : "font-medium text-slate-900"}`}
              title={
                cell.unconfirmed ? [UNCONFIRMED_FACT_TITLE, cell.hint].filter(Boolean).join("\n\n") : (cell.hint ?? undefined)
              }
            >
              {cell.value}
              {cell.unconfirmed ? " ?" : ""}
            </dd>
            {cell.hint && !cell.unconfirmed ? <dd className="text-[11px] text-slate-500">{cell.hint}</dd> : null}
          </div>
        ))}
      </dl>
      {/* The candidate's own words about themselves. 201 CVs carry one and nothing displayed it
          until 2026-08-24 — it is the fastest read in the whole record and answers "is this person
          plausible" before any structured field does. */}
      {candidate.professionalSummary ? (
        <p className="mt-3 border-t border-slate-100 pt-2 text-xs leading-relaxed text-slate-700">
          {candidate.professionalSummary}
        </p>
      ) : null}
    </div>
  );
}
