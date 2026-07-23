// Pure email-template render core, extracted from service.ts so it can be unit-tested WITHOUT pulling
// in the JSX layout (@/emails/phoenix-email-layout.tsx), which the type-stripping test runner can't
// execute. This module has ZERO non-type imports — the token substitution engine + the render-variable
// map live here and are exercised by tests/email-render-harness.test.ts.
//
// The map below (contextVariables) is the authoritative render whitelist: interpolate() resolves a
// {{token}} ONLY from these keys, so a token declared on EmailTemplateContext + used in a template body
// but MISSING here renders EMPTY. That gap shipped the blank probation emails (2026-07-14). The harness
// test guards against it recurring for every module.

import type { EmailTemplateContext } from "./service";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Tokens whose values are trusted pre-rendered HTML blocks (system-built, e.g. the submitted-plan
 * table). They bypass per-value escaping in bodyHtml; the whole interpolated body still goes through
 * sanitizeEmailTemplateHtml afterwards. In text fields these tokens resolve to their text projection.
 */
export const htmlBlockTokens: ReadonlySet<string> = new Set(["planTable", "productsTable", "returnCallout", "scoreTable", "digestTable", "detailsTable"]);

export function interpolate(
  template: string,
  variables: Record<string, string>,
  escapeValues: boolean,
  rawHtmlTokens?: ReadonlySet<string>,
) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? "";
    return escapeValues && !rawHtmlTokens?.has(key) ? escapeHtml(value) : value;
  });
}

export function contextVariables(input: Partial<EmailTemplateContext>, recipientName: string) {
  return {
    amount: text(input.amount),
    area: text(input.area),
    approvalFlow: text(input.approvalFlow),
    candidateName: text(input.candidateName),
    ctaLabel: text(input.ctaLabel || "Open in Phoenix Workforce"),
    ctaUrl: text(input.ctaUrl),
    date: text(input.date || new Date().toISOString().slice(0, 10)),
    detailsTable: text(input.detailsTable),
    detailsTableText: text(input.detailsTableText),
    destination: text(input.destination),
    duration: text(input.duration),
    excuseType: text(input.excuseType),
    excuseDate: text(input.excuseDate),
    endDate: text(input.endDate),
    employeeHrId: text(input.employeeHrId),
    employeeName: text(input.employeeName),
    expiryText: text(input.expiryText),
    feedback: text(input.feedback),
    hireDate: text(input.hireDate),
    honorific: text(input.honorific),
    interviewDate: text(input.interviewDate),
    interviewLocation: text(input.interviewLocation),
    interviewerName: text(input.interviewerName),
    interviewTime: text(input.interviewTime),
    jobTitle: text(input.jobTitle),
    line: text(input.line),
    managerName: text(input.managerName),
    meetingUrl: text(input.meetingUrl),
    nextStep: text(input.nextStep),
    planTable: text(input.planTable),
    planTableText: text(input.planTableText),
    digestTable: text(input.digestTable),
    digestTableText: text(input.digestTableText),
    weekLabel: text(input.weekLabel),
    scoreTable: text(input.scoreTable),
    scoreTableText: text(input.scoreTableText),
    recipientName,
    startDate: text(input.startDate),
    status: text(input.status),
    subject: text(input.subject),
    summary: text(input.summary),
    vacationBalance: text(input.vacationBalance),
    vacationType: text(input.vacationType),
    // Marketing-request tokens.
    currentStep: text(input.currentStep),
    customerName: text(input.customerName),
    estimatedCost: text(input.estimatedCost),
    payDate: text(input.payDate),
    productsTable: text(input.productsTable),
    productsTableText: text(input.productsTableText),
    requestCode: text(input.requestCode),
    requesterName: text(input.requesterName),
    requiredRoi: text(input.requiredRoi),
    returnCallout: text(input.returnCallout),
    returnCalloutText: text(input.returnCalloutText),
    roiWindow: text(input.roiWindow),
    // Probation DV-snapshot / milestone tokens (probation_dv_snapshot, probation_day30/60/75). The
    // renderer resolves ONLY the keys listed here — a token declared on EmailTemplateContext and
    // allowlisted in placeholderHints still renders EMPTY unless it is mapped here (prod incident
    // 2026-07-14: DV snapshot + milestone emails went out with blank DV date / evaluator / score).
    dvDate: text(input.dvDate),
    evaluatorName: text(input.evaluatorName),
    evaluatorRole: text(input.evaluatorRole),
    visitCount: text(input.visitCount),
    dvProgress: text(input.dvProgress),
    milestoneDay: text(input.milestoneDay),
    probationDay: text(input.probationDay),
    daysRemaining: text(input.daysRemaining),
    provisionalScore: text(input.provisionalScore),
    riskStatus: text(input.riskStatus),
  };
}
