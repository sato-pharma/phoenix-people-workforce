/**
 * THE OBJECTIVE REASONS a post may lawfully be filled on a fixed term.
 *
 * Article 87 of Labour Law 14/2025 allows a fixed-term contract only «إذا اقتضت طبيعة العمل ذلك» —
 * if the nature of the work requires it. The renewal annex therefore states a reason on its face,
 * and that reason is the thing that makes the fixed term lawful rather than a formality. Until
 * 2026-09-05 it printed as a blank rule for somebody to fill by hand; the owner asked for a dropdown
 * of standard reasons instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A CATALOGUE AND NOT A TEXT BOX. Two reasons, and the second is the one that matters.
 *
 *   1. Handwriting the justification on seventy annexes produces seventy wordings, and the weakest
 *      of them is the one that gets read out.
 *   2. TWO PEOPLE IN THE SAME JOB MUST NOT BE GIVEN DIFFERENT REASONS. The reason describes the
 *      POST, not the person — "the nature of THIS WORK requires a term" — so two medical reps on
 *      the same line whose annexes state different grounds have produced a contradiction that the
 *      other side gets to pick from. A closed list makes that visible; free text hides it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE WORDING IS APPEND-ONLY. NEVER REWORD A CLAUSE THAT HAS BEEN PRINTED.
 *
 * The profile stores the CODE, not the sentence, and the sentence is resolved at print time — which
 * is what lets the list be extended without a migration, and is also the trap. Rewording a clause
 * silently changes what a signed annex reproduces when it is reprinted, on every annex that ever
 * used it, with nothing on the page to say so. That is the same failure the contract archive exists
 * to prevent (`template-registry.ts`), and it is worse here because there is no version id on the
 * reason to notice by.
 *
 * So: to change a reason, ADD a new code and leave the old one in place. `tests/hr-forms-renewal.test.ts`
 * pins every clause verbatim, so a reword turns the build red instead of rewriting history.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOT LEGAL ADVICE, AND THE OWNER HAS BEEN TOLD SO. These eight are drafted from Article 87's own
 * standard and from what this company actually does — a pharmaceutical field force on annual
 * promotional cycles — but which grounds hold up is a question for the company's lawyer, and the
 * answer decides whether a term is enforceable. The list is built so that adding, removing or
 * re-wording on his advice is one edit to this file.
 *
 * THE SHORT LABEL IS FOR THE DROPDOWN; THE CLAUSE IS WHAT PRINTS. Deliberately separate: a native
 * `<select>` is the one control the fits-the-screen rule cannot narrow, so its options have to stay
 * short, while the annex needs the full sentence. Putting the sentence in the menu would either
 * overflow the field or clip it, and clipped legal text on a chooser is how the wrong ground gets
 * picked.
 */

/** One standard ground for keeping a post on a fixed term. */
export type RenewalObjectiveReason = {
  /**
   * Stable identity, stored on the employee's hiring profile.
   *
   * NEVER RENAME OR REUSE ONE. A stored code resolves to a clause at print time, so a code that
   * changes meaning reprints somebody's annex with a legal ground they never agreed — the same rule
   * that governs a template version id.
   */
  code: string;
  /** Short enough for a dropdown. Two to four words. */
  labelAr: string;
  labelEn: string;
  /** The sentence the annex prints, in the preamble's own voice. */
  clauseAr: string;
};

export const RENEWAL_OBJECTIVE_REASONS: readonly RenewalObjectiveReason[] = [
  {
    code: "annual_promotional_plan",
    labelAr: "خطة الترويج السنوية",
    labelEn: "Annual promotional plan",
    clauseAr:
      "ارتباط الوظيفة بخطة الترويج السنوية المعتمدة، التي يُعاد وضع مستهدفاتها وخطوط منتجاتها ونطاقاتها الجغرافية في مطلع كل سنة",
  },
  {
    code: "territory_coverage_cycle",
    labelAr: "دورة تغطية النطاق",
    labelEn: "Territory coverage cycle",
    clauseAr:
      "ارتباط الوظيفة بتغطية نطاق جغرافي محدد ضمن دورة تغطية سنوية يُعاد في نهايتها تقسيم النطاقات وتوزيع العملاء",
  },
  {
    code: "product_line_term",
    labelAr: "خط منتجات محدد المدة",
    labelEn: "Product line with a defined term",
    clauseAr:
      "ارتباط الوظيفة بخط منتجات أو مجموعة أصناف يقوم تسويقها على تسجيل أو اتفاق توزيع محدد المدة، فتتحدد مدة العمل بمدته",
  },
  {
    code: "defined_project",
    labelAr: "مشروع أو حملة محددة",
    labelEn: "Defined project or campaign",
    clauseAr:
      "ارتباط الوظيفة بمشروع أو حملة محددة المدة والنطاق، تنتهي الحاجة إلى العمل بانتهائها",
  },
  {
    code: "third_party_contract",
    labelAr: "عقد مبرم مع الغير",
    labelEn: "Contract with a third party",
    clauseAr:
      "ارتباط الوظيفة بتنفيذ عقد أو اتفاق محدد المدة مبرم مع الغير، فتتحدد مدة العمل بمدة ذلك العقد",
  },
  {
    code: "temporary_cover",
    labelAr: "تغطية مؤقتة",
    labelEn: "Temporary cover",
    clauseAr:
      "تغطية مؤقتة لوظيفة شاغرة أو لغياب مؤقت لأحد العاملين، وتنتهي الحاجة إلى العمل بزوال سببها",
  },
  {
    code: "seasonal_demand",
    labelAr: "زيادة موسمية في العمل",
    labelEn: "Seasonal increase in workload",
    clauseAr:
      "مواجهة زيادة مؤقتة أو موسمية في حجم العمل لا تستلزم شغل الوظيفة بصفة دائمة",
  },
  {
    code: "new_structure_under_review",
    labelAr: "هيكل تنظيمي قيد التقييم",
    labelEn: "Structure still under review",
    clauseAr:
      "ارتباط الوظيفة بوحدة تنظيمية مستحدثة ما زالت قيد التقييم ولم يستقر بعد إدراجها بالهيكل التنظيمي الدائم",
  },
];

/** Whether a stored string is one of the standard grounds. */
export function isRenewalObjectiveReasonCode(value: string | null | undefined): boolean {
  if (!value) return false;
  return RENEWAL_OBJECTIVE_REASONS.some((reason) => reason.code === value);
}

/**
 * The sentence to print for a stored code, or null.
 *
 * NULL FOR AN UNKNOWN CODE, never the code itself and never a guess. A code this build does not
 * recognise means the row was written by a newer build, or by hand — and printing `annual_promotional_plan`
 * onto an Arabic legal instrument is worse than printing the dotted rule that says a human still has
 * to fill this in. The renderer treats null exactly as it treats "nothing chosen".
 */
export function renewalObjectiveReasonClause(code: string | null | undefined): string | null {
  if (!code) return null;
  return RENEWAL_OBJECTIVE_REASONS.find((reason) => reason.code === code)?.clauseAr ?? null;
}

/** The dropdown's options, in the order they are offered. */
export function renewalObjectiveReasonOptions(): ReadonlyArray<{
  value: string;
  labelEn: string;
  labelAr: string;
}> {
  return RENEWAL_OBJECTIVE_REASONS.map((reason) => ({
    value: reason.code,
    labelEn: reason.labelEn,
    labelAr: reason.labelAr,
  }));
}
