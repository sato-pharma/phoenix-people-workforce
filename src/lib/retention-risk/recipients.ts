/**
 * Retention risk — who is told, as a pure function.
 *
 * Split out of ./notify.ts for the same reason ./messages.ts is: this file imports nothing that
 * touches the network, so the rule can be asserted directly instead of through a mocked sweep.
 * notify.ts stays the I/O shell that feeds it.
 */

import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";

/**
 * THE CEO NEVER RECEIVES A RETENTION-RISK ALERT. Owner, 2026-09-09, asked and answered: he was
 * shown that the CEO is excluded today only by circumstance, and asked for it to be a rule.
 *
 * WHY CIRCUMSTANCE WAS NOT ENOUGH. He received three of the seven alerts on 2026-09-07, purely as
 * the line manager of three head-office managers on ordinary approved leave. The reps-only scope
 * (#3407) removed those subjects, and measured on production 2026-09-09 all 68 active Medical
 * Representatives report to a District Sales Manager or a National Sales Manager, so no manager
 * path reaches him. But nothing STOPS it: make the CEO the direct manager of one rep and the
 * alerts come back, silently, because the audience is assembled from whoever the reporting line
 * happens to name.
 *
 * WHY IT IS THE ROLE AND NOT THE HR ID. Hard-coding `AA` would pin a person, not an office. The
 * exclusion is resolved from whoever holds the CEO app role at send time, so it follows the chair.
 *
 * WHY IT FILTERS THE WHOLE AUDIENCE AND NOT JUST THE MANAGER PATH. "Hard exclude" has to mean the
 * role policy too. `notification_role_policies.retention_risk_alert` is admin-editable, so without
 * this an admin could add CEO to it and put him straight back on every alert. It holds four roles
 * today and the CEO is not among them, so this changes nothing until someone tries.
 *
 * AND WHY THAT REMOVAL IS ANNOUNCED. A filter that silently drops a recipient an admin explicitly
 * added is a config screen that lies. `excluded` is returned so the caller can warn, which is the
 * house rule against a silent no-op.
 */
export const RETENTION_RISK_EXCLUDED_ROLE = "CEO" as const;

export type RetentionRiskRecipient = {
  hrId: string;
  userId: string | null;
};

export type RetentionRiskRecipientPlan = {
  /** Everyone to tell about this signal, deduped, in delivery order. */
  recipients: RetentionRiskRecipient[];
  /** Display-form HR ids the exclusion removed. Empty on every normal run. */
  excluded: string[];
};

/**
 * Assemble the audience for ONE signal.
 *
 * @param audience    the standing role-resolved recipients, already deduped by person
 * @param managerHrId the flagged person's own line manager, added on top — owner's choice
 *                    2026-09-06, so a district manager hears about their own people
 * @param excludedHrIds whoever holds {@link RETENTION_RISK_EXCLUDED_ROLE} at send time
 */
export function planRetentionRiskRecipients(args: {
  audience: readonly RetentionRiskRecipient[];
  managerHrId: string | null;
  excludedHrIds: readonly string[];
}): RetentionRiskRecipientPlan {
  const excludedKeys = new Set<string>();
  for (const hrId of args.excludedHrIds) {
    const key = canonicalHrIdKey(hrId);
    // HR ids are MIXED CASE in this database, so both sides are canonicalised. A plain equality
    // check here would let `aa` through against a stored `AA` and quietly undo the whole rule.
    if (key) excludedKeys.add(key);
  }

  const excluded: string[] = [];
  const recipients: RetentionRiskRecipient[] = [];
  const seen = new Set<string>();

  const push = (recipient: RetentionRiskRecipient) => {
    const key = canonicalHrIdKey(recipient.hrId);
    if (!key) return;
    if (excludedKeys.has(key)) {
      const display = canonicalHrIdForDisplay(recipient.hrId) ?? recipient.hrId;
      if (!excluded.includes(display)) excluded.push(display);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push(recipient);
  };

  for (const one of args.audience) push(one);

  if (args.managerHrId) {
    push({
      hrId: canonicalHrIdForDisplay(args.managerHrId) ?? String(args.managerHrId),
      userId: null,
    });
  }

  return { recipients, excluded };
}
