/**
 * A SENT email keeps no figures in the outbox (owner, 13 Nov 2026: "email figures cleared at send").
 *
 * The outbox stores the whole email input as its payload, and that input carries the numbers the
 * email showed — pay, deductions, probation scores, marketing financials, a submitted plan's rows —
 * in `metrics`, `templateContext` and the plan table. Once the provider has the email, nothing reads
 * them again: the pre-send checks run before the send, Email Activity reads the subject, title and
 * recipients, and the outbox stats read the email's type. So the row keeps who, what and when, and
 * the figures are deleted when it is marked sent. The row says `figuresCleared`.
 *
 * Kept: the "Employee" metric — a name, not a figure — which the email identity audit reads to know
 * whose email it was. A failed or skipped row keeps its figures for diagnosis (it was never sent);
 * the daily retention clean-up removes it at 90 days like any other finished row.
 */

type FigureFields = {
  figuresCleared?: boolean;
  metrics?: Array<{ label: string; value: string | number }>;
  planTableHtml?: string;
  planTableText?: string;
  templateContext?: unknown;
};

const KEPT_METRIC_LABELS = new Set(["employee"]);

/** The payload a SENT row keeps, or null when there is nothing to clear and the row should not be rewritten. */
export function sentFiguresClearedPayload<T extends FigureFields>(payload: T): T | null {
  const metrics = Array.isArray(payload.metrics) ? payload.metrics : undefined;
  const keptMetrics = metrics?.filter((metric) => KEPT_METRIC_LABELS.has(String(metric?.label ?? "").trim().toLowerCase()));
  const hasFigures =
    (metrics !== undefined && keptMetrics!.length !== metrics.length) ||
    payload.templateContext !== undefined ||
    payload.planTableHtml !== undefined ||
    payload.planTableText !== undefined;
  if (!hasFigures) return null;

  const cleared: T = { ...payload, figuresCleared: true };
  if (keptMetrics && keptMetrics.length > 0) cleared.metrics = keptMetrics;
  else delete cleared.metrics;
  delete cleared.templateContext;
  delete cleared.planTableHtml;
  delete cleared.planTableText;
  return cleared;
}
