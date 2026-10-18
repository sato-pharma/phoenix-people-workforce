"use client";

// Recruitment / ATS — "who this person is", in one block.
//
// Extracted from the profile drawer on 2026-08-24 so screening mode and the drawer show the SAME
// summary. It reads `candidateScreeningFacts`, so a confirmed column renders black and the CV
// reader's hedged answer renders grey italic with a "?" — one convention, one module, everywhere.

import { FileSearch } from "lucide-react";

import type { StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
import {
  candidateScreeningChecks,
  candidateScreeningFacts,
  FACT_NOT_ON_FILE,
  formatYearsOfExperience,
  UNCONFIRMED_FACT_TITLE,
  unconfirmedCvFactsFromExtraction,
} from "@/lib/recruitment/candidate-screening-facts";
import type { Candidate } from "@/lib/recruitment/types";
import { candidateWhatsAppAnswers, type ScreeningQuestionLabel } from "@/lib/recruitment/whatsapp-answers";
import { WhatsAppAnswersList } from "@/components/recruitment/whatsapp-answers-list";
import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type Cell = {
  hint?: string;
  label: string;
  /**
   * Nobody has ever answered this one. Rendered as the words "not on file" rather than as a blank
   * or a zero: a cell left empty reads as a rendering fault, and a 0 reads as an answer.
   */
  missing?: boolean;
  unconfirmed?: boolean;
  value: string;
};

/**
 * WHICH FRAME THIS BLOCK DRAWS AROUND ITSELF.
 *
 * `card` is what the two older screens have always had: a white card sitting on a page — square
 * since the 2026-10-19 premium sweep, lifted by the soft depth a box inside a panel takes. `flat`
 * draws nothing at all, because in the screening workstation and on the candidate's own page this
 * block is already inside a titled, square, bordered section — a second frame in there is a box in
 * the middle of a box, which is exactly the noise the owner objected to. The default is `card` so
 * nothing outside those two screens moves.
 */
type Frame = "card" | "flat";

/**
 * The heading over each block, and the one thing the two frames share: the module's orange tick in
 * front of a micro-caps label. It is what separates "Screening checks", "From the CV" and "Answers on
 * WhatsApp" at a glance — three different kinds of fact, three different sources.
 */
function BlockHeading({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-[11px] font-black uppercase leading-[1.45] tracking-[0.12em] text-slate-500">
      <span aria-hidden="true" className="h-3 w-0.5 bg-orange-500" />
      {children}
    </p>
  );
}

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
  frame = "card",
  screeningQuestions,
  showScreeningChecks = false,
  showWhatsAppAnswers = true,
}: {
  candidate: Candidate;
  className?: string;
  columns?: 1 | 2 | 3;
  extraction: StoredCvExtraction | null;
  frame?: Frame;
  /**
   * The wording of the admin-defined WhatsApp questions, from the profile route. Null when it could
   * not be read. REQUIRED, so a screen that forgets to pass it fails to compile instead of printing
   * every admin-defined answer under "could not be loaded".
   */
  screeningQuestions: readonly ScreeningQuestionLabel[] | null;
  /**
   * Print the four always-on screening checks — the degree rule, gender, age and military service.
   *
   * Off by default so the older screens are untouched. The screening workstation turns it on,
   * because those four are what the owner opened all 17 CVs to find on 2026-09-11, and unlike every
   * other cell here they are printed whether or not there is an answer: "not on file" is itself the
   * fact a screener needs, and a row that simply vanished when empty could not say it.
   */
  showScreeningChecks?: boolean;
  /**
   * False where the caller already shows the answers as a section of its own — the workstation puts
   * them first, above this block — so one panel does not print the same answers twice.
   */
  showWhatsAppAnswers?: boolean;
}) {
  const flat = frame === "flat";
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
      label: "Medical rep experience",
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
      // its own line in the WhatsApp answers rather than being repeated here as a footnote.
      hint: facts.region && !facts.region.value.declared ? `${facts.region.value.label} region` : undefined,
      label: "Governorate",
      unconfirmed: !facts.governorate.confirmed,
      value: facts.governorate.value,
    });
  }
  if (education) cells.push({ hint: graduated ?? undefined, label: "Education", value: education });
  if (!education && graduated) cells.push({ label: "Education", value: graduated });

  // ── What the applicant answered on WhatsApp ────────────────────────────────────────────────────
  //
  // A SECOND block, not more cells in the first one, because these are a different kind of fact.
  // Everything above was read off a document by a machine; everything here was typed or tapped by
  // the person themselves, and a screener deciding whether to call someone needs to know which of
  // the two they are looking at.
  //
  // Until 2026-09-02 none of the six built-in answers was displayed anywhere in screening. Until
  // 2026-09-11 the questions an admin adds on /admin/screening-questions — age, MS Office, start date
  // — were displayed on no screening screen at all, though 116 candidates had answered them, and the
  // six that were shown sat under field names ("Preferred area") rather than the questions they
  // answer. The owner asked to read EVERY answer beside the CV, so the list now comes from one
  // resolver and prints each answer under its question. It keeps the split this block always drew:
  // a typed region reads as their words here, and the experience band stays apart from the counted
  // "Experience" above — the two can disagree honestly.
  // The four checks, from the SHARED module — the degree half is `judgeBackground`, the very gate
  // that decides whether a CV may be auto-filed, so this panel can never tell a recruiter something
  // the rest of the system does not believe.
  const checks: Cell[] = showScreeningChecks
    ? candidateScreeningChecks(candidate).map((check) => ({
        hint: check.hint ?? undefined,
        label: check.label,
        missing: check.value === null,
        value: check.value ?? FACT_NOT_ON_FILE,
      }))
    : [];

  const answers = showWhatsAppAnswers ? candidateWhatsAppAnswers(candidate, screeningQuestions) : [];
  // A salary figure typed into the ATS by hand is not a WhatsApp answer, so that list does not carry
  // it — but it is still this record's expected salary, which this block used to show, and one
  // production row (2026-09-11) holds a figure and no WhatsApp answer. Dropping it would be a silent erase.
  const salaryOnFile =
    !candidate.declaredExpectedSalary?.trim() && facts.expectedSalary ? facts.expectedSalary.value : null;

  // Nothing known at all is itself worth saying out loud — silence reads as a rendering fault, and
  // the reader needs to know the CV is the only place left to look.
  if (
    cells.length === 0 &&
    checks.length === 0 &&
    answers.length === 0 &&
    !salaryOnFile &&
    !candidate.professionalSummary
  ) {
    return (
      <div
        className={
          frame === "flat"
            ? `bg-white px-3 py-2 ${className ?? ""}`
            : `flex items-start gap-2.5 border border-dashed border-slate-300 bg-slate-50/60 p-3 ${adminRecessedDepthClassName} ${className ?? ""}`
        }
      >
        {flat ? null : <FileSearch aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
        <p className="text-xs leading-5 text-slate-600">
          Nothing has been read off this CV yet — read the document itself, or use “Read the CV again”.
        </p>
      </div>
    );
  }

  const gridColumns =
    columns === 1 ? "grid-cols-1" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  // Unframed inside a titled section; or the white card the older screens draw, square and lifted.
  const frameClass = flat ? "bg-white" : `border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`;
  const ruleClass = flat ? "border-phx-line" : "border-slate-200/80";

  return (
    <div className={`${frameClass} ${className ?? ""}`}>
      {/* FIRST, because they are the first four questions asked of any CV and the only ones whose
          ANSWERLESSNESS is worth printing. */}
      {checks.length > 0 ? (
        <>
          <BlockHeading>Screening checks</BlockHeading>
          <dl className={`mt-2.5 grid gap-x-6 gap-y-3 ${gridColumns}`}>
            <FactCells cells={checks} flat={flat} />
          </dl>
        </>
      ) : null}
      {cells.length > 0 ? (
        <div className={checks.length > 0 ? `mt-4 border-t ${ruleClass} pt-3` : ""}>
          <BlockHeading>From the CV</BlockHeading>
          <dl className={`mt-2.5 grid gap-x-6 gap-y-3 ${gridColumns}`}>
            <FactCells cells={cells} flat={flat} />
          </dl>
        </div>
      ) : null}
      {/* Their own answers, under their own heading. The border is the whole point: it says "a
          person told us this" without needing a word of explanation on every line. */}
      {answers.length > 0 ? (
        <div className={cells.length > 0 || checks.length > 0 ? `mt-4 border-t ${ruleClass} pt-3` : ""}>
          <BlockHeading>Answers on WhatsApp</BlockHeading>
          <WhatsAppAnswersList answers={answers} className="mt-2.5" columns={columns} frame={frame} />
        </div>
      ) : null}
      {salaryOnFile ? (
        <div className={cells.length > 0 || checks.length > 0 || answers.length > 0 ? `mt-4 border-t ${ruleClass} pt-3` : ""}>
          <BlockHeading>On the record</BlockHeading>
          <dl className={`mt-2.5 grid gap-x-6 gap-y-3 ${gridColumns}`}>
            <FactCells cells={[{ label: "Expected salary", value: salaryOnFile }]} flat={flat} />
          </dl>
        </div>
      ) : null}
      {/* The candidate's own words about themselves. 201 CVs carry one and nothing displayed it
          until 2026-08-24 — it is the fastest read in the whole record and answers "is this person
          plausible" before any structured field does. Set as a quotation on an orange rule, because
          it is the one block here written by the person rather than read off them. */}
      {candidate.professionalSummary ? (
        <div className={`mt-4 border-t ${ruleClass} pt-3`}>
          <p
            className="border-l-2 border-orange-300 pl-3 text-[13px] leading-relaxed text-slate-700"
            dir="auto"
          >
            {candidate.professionalSummary}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** One run of label/value pairs. Extracted so the CV block and the declared block cannot drift. */
function FactCells({ cells, flat = false }: { cells: Cell[]; flat?: boolean }) {
  return (
    <>
      {cells.map((cell) => (
        <div key={cell.label}>
          <dt
            className={
              flat
                ? "text-[10px] font-bold uppercase leading-[1.5] tracking-[0.1em] text-phx-ink-faint"
                : "text-[10px] font-bold uppercase leading-[1.5] tracking-[0.1em] text-slate-400"
            }
          >
            {cell.label}
          </dt>
          <dd
            className={`mt-0.5 break-words text-sm leading-snug ${
              cell.missing
                ? // NOT italic: italic already means "the CV reader hedged this", which is a claim
                  // about confidence. This is a claim about existence, and conflating the two would
                  // make a hole look like a guess.
                  "text-phx-ink-faint"
                : cell.unconfirmed
                  ? "italic text-slate-500"
                  : "font-medium text-slate-900"
            }`}
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
          {cell.hint && !cell.unconfirmed ? <dd className="mt-0.5 text-phx-xs text-slate-500">{cell.hint}</dd> : null}
        </div>
      ))}
    </>
  );
}
