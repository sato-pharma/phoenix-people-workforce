// Recruitment / ATS — "does this CV fit the job we are hiring for?", shown as its working.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
//
// It is NOT an AI score, and there is no AI score in this system to show. Nothing in the pipeline
// produces a role-match percentage: the CV reader extracts FIELDS with a confidence per field, and
// `screening-order.ts` sorts candidates into six bands. A percentage invented here would be a
// number with no source — presented beside a real applicant's name, on a screen where somebody
// decides whether to interview them — and the standing rule in this module is that a hedged answer
// is shown AS hedged and an absent one is not filled in with a plausible substitute.
//
// So the number below is arithmetic a recruiter can check, not a judgement: how many of the
// dimensions that apply to THIS job are met by facts already on the record. Every dimension states
// which fact answered it, every unknown is shown as unknown rather than as a zero, and the whole
// thing degrades to "not enough on file to read" rather than to a low score — because "we know
// nothing about this person" and "this person is a poor fit" are opposite findings and a single
// percentage cannot tell them apart.
//
// ── WHY THE DIMENSIONS VARY BY ROLE ─────────────────────────────────────────────────────────────
//
// Pharma experience is the first question about a medical rep and irrelevant to an office
// coordinator; team leadership is the first question about a district manager and meaningless for a
// fresh graduate rep. A fixed set of dimensions applied to every vacancy would mark an excellent
// office coordinator down for never having sold a drug. The sets below are keyed on the role FAMILY
// the module already resolves — the same one the queue orders on — so there is one answer to "what
// job is this person for", not two.
//
// PURE, and it must stay pure: this renders inside a client component.

import {
  candidateRoleFamilyLabels,
  candidateRoleFamilyOrNull,
  type CandidateRoleFamily,
} from "@/lib/recruitment/candidate-role-family";
import type { CandidateScreeningFacts } from "@/lib/recruitment/candidate-screening-facts";

/**
 * How well one dimension is answered.
 *
 * `unknown` is a first-class state and the reason this is four values rather than a boolean: a CV
 * that never mentions a degree has not failed the education dimension, it has left it unanswered,
 * and the recruiter's next action is different in each case — ask, versus move on.
 */
export const roleFitStates = ["met", "partial", "missing", "unknown"] as const;

export type RoleFitState = (typeof roleFitStates)[number];

export type RoleFitDimension = {
  /** Stable key, for React and for tests. */
  key: string;
  label: string;
  state: RoleFitState;
  /** The fact that answered it, in plain words — "Glenmark, 2019 → now". Null when unanswered. */
  evidence: string | null;
  /** False when the fact came from the CV reader's hedged tier. Drives the "?" the module uses. */
  confirmed: boolean;
};

export type RoleFitRead = {
  /** The job this was read AGAINST — never the candidate's current title. */
  roleLabel: string;
  dimensions: RoleFitDimension[];
  /**
   * Met dimensions over ANSWERED dimensions, 0-100, or null when too little is on file.
   *
   * Unknowns are excluded from the denominator rather than counted as failures. A CV with one
   * answered dimension out of five does not get a 20% — it gets `null`, and the panel says so.
   */
  score: number | null;
  /** How many dimensions could not be read at all. Shown, so the score is never read as complete. */
  unknownCount: number;
};

/** Below this many answered dimensions there is nothing honest to average. */
const MIN_ANSWERED_FOR_SCORE = 3;

function fact<T>(value: { confirmed: boolean; value: T } | null): { confirmed: boolean; value: T } | null {
  return value ?? null;
}

/** A dimension answered by a yes/no fact — pharma experience and its like. */
function booleanDimension(
  key: string,
  label: string,
  source: { confirmed: boolean; value: boolean } | null,
  evidenceWhenTrue: string,
): RoleFitDimension {
  if (!source) return { confirmed: true, evidence: null, key, label, state: "unknown" };
  return {
    confirmed: source.confirmed,
    evidence: source.value ? evidenceWhenTrue : "Nothing on the CV says so",
    key,
    label,
    state: source.value ? "met" : "missing",
  };
}

/**
 * A dimension answered by years of experience, against the floor this job actually needs.
 *
 * `partial` rather than `missing` below the floor, because a rep with two years against a
 * three-year seat is a conversation, not a no — and a screen that renders that as a hard miss is a
 * screen that teaches a recruiter to stop reading the dimensions.
 */
function yearsDimension(
  label: string,
  years: { confirmed: boolean; value: number } | null,
  floorYears: number,
): RoleFitDimension {
  if (!years) return { confirmed: true, evidence: null, key: "experience", label, state: "unknown" };
  const rounded = Math.round(years.value * 10) / 10;
  return {
    confirmed: years.confirmed,
    evidence: `${rounded} ${rounded === 1 ? "year" : "years"} on the CV`,
    key: "experience",
    label,
    state: years.value >= floorYears ? "met" : years.value >= floorYears / 2 ? "partial" : "missing",
  };
}

/** A dimension answered by whether we know where they are and whether they told us. */
function placeDimension(facts: CandidateScreeningFacts): RoleFitDimension {
  const area = fact(facts.area);
  if (area) {
    return {
      confirmed: area.confirmed,
      evidence: `Asked for ${area.value}`,
      key: "location",
      label: "Location fit",
      state: "met",
    };
  }
  const region = fact(facts.region);
  if (region) {
    return {
      confirmed: region.confirmed,
      // A declared region is the applicant's own answer; a derived one was read off their address.
      // The difference decides whether a recruiter may act on it, so it is said rather than implied.
      evidence: region.value.declared ? `Asked for ${region.value.label}` : `Address reads ${region.value.label}`,
      key: "location",
      label: "Location fit",
      state: region.value.declared ? "met" : "partial",
    };
  }
  return { confirmed: true, evidence: null, key: "location", label: "Location fit", state: "unknown" };
}

/** A dimension answered by what they studied. Science disciplines are the field-force gate. */
function backgroundDimension(facts: CandidateScreeningFacts, label: string): RoleFitDimension {
  const background = fact(facts.background);
  if (!background) return { confirmed: true, evidence: null, key: "background", label, state: "unknown" };
  return { confirmed: background.confirmed, evidence: background.value, key: "background", label, state: "met" };
}

/** A dimension answered by holding a job title at all — "does the CV say what they do". */
function currentRoleDimension(facts: CandidateScreeningFacts, label: string): RoleFitDimension {
  const role = fact(facts.roleTitle);
  const employer = fact(facts.employer);
  if (!role) return { confirmed: true, evidence: null, key: "current_role", label, state: "unknown" };
  return {
    confirmed: role.confirmed && (employer?.confirmed ?? true),
    evidence: [role.value, employer?.value].filter(Boolean).join(" · "),
    key: "current_role",
    label,
    state: "met",
  };
}

/**
 * Team leadership, read off the title the candidate currently holds.
 *
 * A keyword read, and it is stated as one: the CV reader stores no "manages N people" field, so the
 * only evidence available is whether their own title says manager, supervisor, lead or head. That
 * is weak evidence and the dimension says which title it read, so a recruiter can disagree with it
 * in one glance rather than trusting a bar.
 */
const LEADERSHIP_TITLE = /\b(manager|supervisor|team\s*lead|lead|head|director|chief)\b/i;

function leadershipDimension(facts: CandidateScreeningFacts): RoleFitDimension {
  const role = fact(facts.roleTitle);
  if (!role) return { confirmed: true, evidence: null, key: "leadership", label: "Leadership", state: "unknown" };
  const leads = LEADERSHIP_TITLE.test(role.value);
  return {
    confirmed: role.confirmed,
    evidence: leads ? `Title reads "${role.value}"` : `Current title is "${role.value}"`,
    key: "leadership",
    label: "Leadership",
    state: leads ? "met" : "missing",
  };
}

/**
 * Which dimensions apply to which job, and the years floor each is read against.
 *
 * The floors are the ones the module's own bands already imply and are deliberately low: this is a
 * CV screen, not a shortlist gate, and a floor set high enough to be interesting is a floor that
 * marks down half the pool on a number the CV reader derived by counting dates.
 */
function dimensionsFor(family: CandidateRoleFamily | null, facts: CandidateScreeningFacts): RoleFitDimension[] {
  const pharma = booleanDimension(
    "pharma",
    "Pharma experience",
    fact(facts.pharmaRep),
    "Has worked as a medical rep",
  );

  switch (family) {
    case "medical_rep":
      return [
        pharma,
        yearsDimension("Relevant experience", fact(facts.years), 1),
        backgroundDimension(facts, "Science background"),
        currentRoleDimension(facts, "Current role"),
        placeDimension(facts),
      ];
    case "district_manager":
    case "area_regional_manager":
    case "national_sales_manager":
      return [
        leadershipDimension(facts),
        pharma,
        yearsDimension("Field experience", fact(facts.years), 5),
        currentRoleDimension(facts, "Current role"),
        placeDimension(facts),
      ];
    case "pharmacist":
    case "product_manager":
      return [
        backgroundDimension(facts, "Pharmacy / science background"),
        pharma,
        yearsDimension("Relevant experience", fact(facts.years), 2),
        currentRoleDimension(facts, "Current role"),
        placeDimension(facts),
      ];
    case "hr_section_head":
      // A section head LEADS people, so leadership is read here as it is for the field managers, with
      // a higher years floor than the office seats below.
      return [
        currentRoleDimension(facts, "HR role"),
        yearsDimension("HR experience", fact(facts.years), 5),
        leadershipDimension(facts),
        backgroundDimension(facts, "Education"),
        placeDimension(facts),
      ];
    case "personnel":
      // Personnel administration is learned on the job — insurance forms, payroll inputs, the labour
      // office — so its years floor sits between the office seats and the section head.
      return [
        currentRoleDimension(facts, "Personnel / HR role"),
        yearsDimension("Personnel experience", fact(facts.years), 2),
        backgroundDimension(facts, "Education"),
        placeDimension(facts),
      ];
    case "office_coordinator":
    case "human_resources":
    case "talent_acquisition":
    case "finance":
      return [
        currentRoleDimension(facts, "Office / admin role"),
        yearsDimension("Relevant experience", fact(facts.years), 1),
        backgroundDimension(facts, "Education"),
        placeDimension(facts),
      ];
    case "sales":
      return [
        currentRoleDimension(facts, "Sales role"),
        yearsDimension("Selling experience", fact(facts.years), 1),
        pharma,
        placeDimension(facts),
      ];
    default:
      // No family could be read. The generic set answers "what do we actually know", which is the
      // useful question about a CV nobody can categorise — never a fit verdict against a job we
      // have not identified.
      return [
        currentRoleDimension(facts, "Current role"),
        yearsDimension("Experience", fact(facts.years), 1),
        backgroundDimension(facts, "Education"),
        placeDimension(facts),
      ];
  }
}

/**
 * The fit read for one candidate against one job.
 *
 * `family` is the job being hired for — resolved from the vacancy the CV is filed against, or from
 * what the candidate applied for. It is NOT their current job title: reading a district manager's
 * CV against "district manager" because that is what they currently are would score every candidate
 * against themselves and always come back excellent.
 */
export function readRoleFit(
  facts: CandidateScreeningFacts,
  family: CandidateRoleFamily | null,
  roleLabelOverride?: string | null,
): RoleFitRead {
  const dimensions = dimensionsFor(family, facts);
  const answered = dimensions.filter((dimension) => dimension.state !== "unknown");
  const unknownCount = dimensions.length - answered.length;

  // `partial` counts as half. It is a real middle state — two years against a four-year floor — and
  // rounding it to either end would make the number disagree with the bars printed beside it.
  const met = answered.reduce(
    (total, dimension) => total + (dimension.state === "met" ? 1 : dimension.state === "partial" ? 0.5 : 0),
    0,
  );

  return {
    dimensions,
    roleLabel:
      roleLabelOverride?.trim() ||
      (family ? candidateRoleFamilyLabels[family] : "No job title on file"),
    score: answered.length >= MIN_ANSWERED_FOR_SCORE ? Math.round((met / answered.length) * 100) : null,
    unknownCount,
  };
}

/**
 * The family of the job being HIRED FOR — the only family a fit read may be taken against.
 *
 * THE ORDER IS THE WHOLE POINT, and it is the opposite of `candidateScreeningRoleFamily`, which
 * answers a different question ("what kind of person is this") and therefore reads the candidate's
 * own current title first. Reading a fit against that title scores every candidate against
 * themselves: a district manager measured as a district manager is always an excellent district
 * manager, and the number stops meaning anything on precisely the CVs a recruiter most needs it for.
 *
 * So the applied-for text wins. The current title is the FALLBACK, used only when nobody ever said
 * what the person applied for — in which case reading them against what they already do is the
 * least wrong thing available, and the dimensions on screen say which job they were read against.
 */
export function hiringTargetFamily(
  appliedForText: string | null | undefined,
  facts: CandidateScreeningFacts,
): CandidateRoleFamily | null {
  return candidateRoleFamilyOrNull(appliedForText) ?? candidateRoleFamilyOrNull(facts.roleTitle?.value ?? null);
}

/** The one-word verdict beside the number, so a bare percentage never has to carry the meaning. */
export type RoleFitVerdict = "strong" | "possible" | "weak" | "unread";

export function roleFitVerdict(score: number | null): RoleFitVerdict {
  if (score === null) return "unread";
  if (score >= 75) return "strong";
  if (score >= 45) return "possible";
  return "weak";
}

export const roleFitVerdictLabels: Record<RoleFitVerdict, string> = {
  possible: "Possible fit",
  strong: "Strong fit",
  unread: "Not enough on file",
  weak: "Weak fit",
};
