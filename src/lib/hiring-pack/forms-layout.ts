// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHICH PAPERS EACH HR FORMS PACKAGE WALKS THROUGH, AND IN WHAT ORDER — chosen on the Control tab.
//
// The owner, 2026-11-27: "create a tab in HR Forms where I can rearrange the forms that appear,
// remove a form, add a form I want to appear — move it from another paper to new hire, or from new
// hire to another paper. Make a page of control in HR Forms."
//
// So the two packages (new hire, leaver) are an ordered list each, stored once for the company, and
// "Another paper" is simply every paper in neither list. Nothing stored → the standard order in
// `hr-forms-wizard.ts`, which is what the screen showed before the Control tab existed.
//
// A STORED LIST IS CLEANED, NEVER TRUSTED: an unknown key (a paper retired from the code), a paper
// twice in one list, the two exit forms on their own (they are ONE step, `exitForm`), and the exit
// form on the new-hire list (it needs the departure the leaver step asks for) are dropped. An empty
// list is a real answer — a package with no papers — and is kept.
//
// Pure and browser-safe: the screen, the store and the route all read it, and
// `tests/hr-forms-wizard.test.ts` pins it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  EXIT_FORM_STEP,
  LEAVER_PAPERS,
  NEW_HIRE_PAPERS,
  type LeaverStep,
} from "@/lib/hiring-pack/hr-forms-wizard";
import { HIRING_PACK_DOCUMENTS, type HiringPackDocument } from "@/lib/hiring-pack/types";

/** The two packages whose papers are arranged. "Another paper" is what is left. */
export type ArrangedPackage = "newHire" | "leaver";

export const ARRANGED_PACKAGES: readonly ArrangedPackage[] = ["newHire", "leaver"];

export type FormsLayout = Record<ArrangedPackage, LeaverStep[]>;

/** The standard order — the screen before the Control tab, and the answer when nothing is stored. */
export const DEFAULT_FORMS_LAYOUT: FormsLayout = {
  leaver: [...LEAVER_PAPERS],
  newHire: [...NEW_HIRE_PAPERS],
};

/** The two exit forms are one step on any list; they are never arranged one by one. */
const EXIT_FORM_PAPERS: readonly HiringPackDocument[] = ["resignation", "mutualTermination"];

/** Every step the Control tab can place: each built-in paper, with the two exit forms as one. */
export const ARRANGEABLE_STEPS: readonly LeaverStep[] = [
  ...HIRING_PACK_DOCUMENTS.filter((document) => !EXIT_FORM_PAPERS.includes(document)),
  EXIT_FORM_STEP,
];

const ARRANGEABLE = new Set<string>(ARRANGEABLE_STEPS);

/** Whether a step may sit on a package's list. The exit form belongs to the leaver only. */
export function mayArrange(step: LeaverStep, pack: ArrangedPackage): boolean {
  if (!ARRANGEABLE.has(step)) return false;
  return step !== EXIT_FORM_STEP || pack === "leaver";
}

/** The step a paper is arranged as: the two exit forms are the one exit-form step. */
export function stepOfDocument(document: string): string {
  return EXIT_FORM_PAPERS.includes(document as HiringPackDocument) ? EXIT_FORM_STEP : document;
}

/** One package's list, cleaned. Anything but an array of strings answers null (use the standard). */
export function cleanPackageSteps(raw: unknown, pack: ArrangedPackage): LeaverStep[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const steps: LeaverStep[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const step = stepOfDocument(value.trim()) as LeaverStep;
    if (!mayArrange(step, pack) || seen.has(step)) continue;
    seen.add(step);
    steps.push(step);
  }
  return steps;
}

/** A whole layout, cleaned; a package missing or unreadable keeps its standard order. */
export function normalizeFormsLayout(raw: unknown): FormsLayout {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const layout = { ...DEFAULT_FORMS_LAYOUT };
  for (const pack of ARRANGED_PACKAGES) {
    const cleaned = cleanPackageSteps(source[pack], pack);
    if (cleaned) layout[pack] = cleaned;
  }
  return layout;
}

/** Every step on either package's list — what "Another paper" leaves out. */
export function stepsInPackages(layout: FormsLayout): ReadonlySet<string> {
  return new Set<string>([...layout.newHire, ...layout.leaver]);
}

/** The steps on neither list, in the catalogue's order: what "Another paper" offers. */
export function stepsOutsidePackages(layout: FormsLayout): LeaverStep[] {
  const placed = stepsInPackages(layout);
  return ARRANGEABLE_STEPS.filter((step) => !placed.has(step));
}

/** Whether two layouts put the same papers in the same order. */
export function sameFormsLayout(a: FormsLayout, b: FormsLayout): boolean {
  return ARRANGED_PACKAGES.every(
    (pack) => a[pack].length === b[pack].length && a[pack].every((step, index) => step === b[pack][index]),
  );
}
