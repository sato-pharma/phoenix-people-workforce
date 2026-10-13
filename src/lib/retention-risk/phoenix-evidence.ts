import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  phoenixWorkEvidenceProvesWorkedDay,
  type PhoenixWorkEvidenceDay,
} from "@/lib/crm/phoenix-work-evidence";

/**
 * Fold Phoenix CRM work into the activity the silence rule reads.
 *
 * The visits mirror view counts a Phoenix visit only once the rep's team has been started, so a rep
 * already working in Phoenix CRM before that reads as silent on this board. The evidence loader asks
 * the base tables instead, and a day it proves worked is a day the rep was seen — the same line the
 * deduction connectors draw. A day start alone proves nothing and is not folded in.
 */
export function mergePhoenixWorkEvidence(
  activity: Map<string, Set<string>>,
  firstSeen: Map<string, string>,
  days: readonly PhoenixWorkEvidenceDay[],
): void {
  for (const day of days) {
    if (!phoenixWorkEvidenceProvesWorkedDay(day)) continue;
    const key = canonicalHrIdKey(day.hrId);
    if (!key) continue;
    let bucket = activity.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      activity.set(key, bucket);
    }
    bucket.add(day.date);
    const earliest = firstSeen.get(key);
    if (!earliest || day.date < earliest) firstSeen.set(key, day.date);
  }
}
