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
      // No employer hint here. It was `facts.employer.value`, and the Employer cell below is pushed
      // on exactly the same condition — so the hint was never anything but the next cell's value,
      // repeated one line above it in grey. It also rendered a HEDGED employer as though it were
      // confirmed, because a hint carries none of the unconfirmed styling.
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
      // No span hint either: the value already ends in `repSpan` whenever there is one, so the cell
      // read "Glenmark multinational · 2023 → now" with "2023 → now" repeated underneath it. On a
      // "No" the hint was worse than redundant — it dated a tenure the cell had just denied.
      label: "Medical rep before",
      unconfirmed: !facts.pharmaRep.confirmed,
      value: facts.pharmaRep.value
        ? [candidate.medicalRepEmployer, repSpan].filter(Boolean).join(" · ") || "Yes"
        : "No",
    });
  }
  if (facts.governorate) {
    cells.push({
      // The governorate is the answer; the region is the qualifier, and it belongs in the hint on
      // its own. Carrying it in BOTH printed "Qena · Upper Egypt" with "Upper Egypt region" beneath.
      // The hint keeps the word "region" because that is the load-bearing part: these are the
      // COMPANY's regions, not geography — Beni Suef is filed under Giza, Aswan under Others — so
      // "Upper Egypt" alone invites a reader to check it against a map and call it wrong.
      // Only when the region was DERIVED from this very governorate. A region the applicant
      // DECLARED is a different claim — where they want to work, not where they live — and it gets
      // its own cell in "In their own words" below rather than being repeated here as a footnote.
      hint: facts.region && !facts.region.value.declared ? `${facts.region.value.label} region` : undefined,
      label: "Lives in",
      unconfirmed: !facts.governorate.confirmed,
      value: facts.governorate.value,
    });
  }
  if (education) cells.push({ hint: graduated ?? undefined, label: "Studied", value: education });
  if (!education && graduated) cells.push({ label: "Studied", value: graduated });

  // ── What the applicant answered on WhatsApp ────────────────────────────────────────────────────
  //
  // A SECOND block, not five more cells in the first one, because these are a different kind of
  // fact. Everything above was read off a document by a machine; everything here was typed or
  // tapped by the person themselves, and a screener deciding whether to call someone needs to know
  // which of the two they are looking at. They are all black — a declared answer is settled, there
  // is nothing to hedge against — so the heading is the only thing carrying the distinction.
  //
  // Until 2026-09-02 not one of them was displayed anywhere in screening. The area was resolved by
  // `candidateScreeningFacts` and thrown away by every caller; the background and the salary were
  // stored and read by nothing; the experience band never even reached the Candidate type. The
  // owner's report was exactly right: he was answering questions on WhatsApp and screening a card
  // that showed him only the CV.
  const declared: Cell[] = [];
  if (facts.area) declared.push({ label: "Wants to work in", value: facts.area.value });
  if (facts.region?.value.declared) {
    // Their own region answer. Shown even when it duplicates the governorate's region, because
    // "they asked for Upper Egypt" and "their address is in Upper Egypt" are different facts that
    // happen to agree — and 20 candidates in production declared a region with no address at all,
    // whose answer had nowhere to appear while the region rode as a hint on "Lives in".
    declared.push({ label: "Region asked for", value: facts.region.value.label });
  }
  if (facts.background) declared.push({ label: "Studied (their answer)", value: facts.background.value });
  if (facts.declaredExperience) {
    declared.push({
      // "Says" is doing real work: this is a bracket the applicant picked, next to an "Experience"
      // cell above that is a number counted off their work history. The two can disagree honestly.
      label: "Says experience",
      value: facts.declaredExperience.value,
    });
  }
  if (facts.expectedSalary) declared.push({ label: "Expected salary", value: facts.expectedSalary.value });

  // Nothing known at all is itself worth saying out loud — silence reads as a rendering fault, and
  // the reader needs to know the CV is the only place left to look.
  if (cells.length === 0 && declared.length === 0 && !candidate.professionalSummary) {
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
      {cells.length > 0 ? (
        <>
          <p className="text-phx-xs font-semibold uppercase tracking-wide text-slate-500">Who this is</p>
          <dl className={`mt-2 grid gap-x-6 gap-y-2 ${gridColumns}`}>
            <FactCells cells={cells} />
          </dl>
        </>
      ) : null}
      {/* Their own answers, under their own heading. The border is the whole point: it says "a
          person told us this" without needing a word of explanation on every cell. */}
      {declared.length > 0 ? (
        <div className={cells.length > 0 ? "mt-3 border-t border-slate-100 pt-2" : ""}>
          <p className="text-phx-xs font-semibold uppercase tracking-wide text-slate-500">In their own words</p>
          <dl className={`mt-2 grid gap-x-6 gap-y-2 ${gridColumns}`}>
            <FactCells cells={declared} />
          </dl>
        </div>
      ) : null}
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

/** One run of label/value pairs. Extracted so the CV block and the declared block cannot drift. */
function FactCells({ cells }: { cells: Cell[] }) {
  return (
    <>
      {cells.map((cell) => (
        <div key={cell.label}>
          <dt className="text-phx-xs font-semibold uppercase tracking-wide text-slate-400">{cell.label}</dt>
          <dd
            className={`text-sm ${cell.unconfirmed ? "italic text-slate-500" : "font-medium text-slate-900"}`}
            // Every value here is free text somebody typed, and some of it is Arabic — the longest
            // expected-salary answer in production is a list of governorates in Arabic. House style
            // for SINGLE-language free text is block-level `dir="auto"`: it reads the first strong
            // character and lays the whole value out from there, which is what puts the commas and
            // brackets of an Arabic answer on the correct side. It is the right call here precisely
            // because each value is one language; a value MIXING the two needs direction per line
            // instead, and `auto` on the block would render the English half backwards.
            dir="auto"
            title={
              cell.unconfirmed ? [UNCONFIRMED_FACT_TITLE, cell.hint].filter(Boolean).join("\n\n") : (cell.hint ?? undefined)
            }
          >
            {cell.value}
            {cell.unconfirmed ? " ?" : ""}
          </dd>
          {cell.hint && !cell.unconfirmed ? <dd className="text-phx-xs text-slate-500">{cell.hint}</dd> : null}
        </div>
      ))}
    </>
  );
}
