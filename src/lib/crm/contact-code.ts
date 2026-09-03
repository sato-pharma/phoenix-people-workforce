/**
 * Parsing `marketing_customer_contacts.crm_code` — the free-text column that holds a CRM contact id.
 *
 * ## Why the parse is strict, and why it lives in one place
 *
 * `crm_code` is unconstrained text. The table CHECKs `contact_code` and `contact_name` for
 * blankness and constrains this column not at all, so nothing in the database stops
 * `"66355 (old)"` or `"66355 / 66356"` being stored in it. Both readers parsed it with a bare
 * `Number.parseInt`, which stops at the first non-digit and answers a confident `66355` for either
 * of those — a "CRM linked" badge naming a contact the stored text does not actually name.
 *
 * Measured on production 2026-09-03: all 133 non-empty codes are pure digits, so this has never
 * yet fired. It is the PATTERN that regenerates rather than the two call sites, which is why the
 * parse is shared now — `src/lib/marketing-requests/service.ts` and `src/lib/crm/contact-trade.ts`
 * had independently drifted to the same permissive shape, and a third reader would have too.
 *
 * ## What "resolves" does NOT mean — do not gate this on `ireports360_contacts`
 *
 * `ireports360_contacts` is NOT a CRM contact registry and must never decide whether a `crm_code`
 * is real. Its primary key is `(agent_crm_id, contact_crm_id, list_type)`: it is the contact LIST
 * the CRM handed one particular agent, synced only for the agents that door reads. Measured on
 * production 2026-09-03 — the roster was fresh that morning, so this is scope, not staleness — it
 * held 9,698 distinct contacts across 70 agents while `ireports360_visits` referenced 14,858
 * distinct contacts across 212 agents. So 6,953 contacts (47%) that reps have demonstrably visited
 * are absent from it, including every contact reachable only through a resigned rep. This is the
 * same exclusion that once hid ~1,100 doctors from a contact read.
 *
 * That is exactly what the 40 marketing contacts that "did not resolve" turned out to be. All 40
 * carry real CRM visits AND plan entries (1 to 82 visits each), and 7 of the 17 rosterless agents
 * visiting them are resigned or terminated employees. Not one of the 133 codes is stale, mistyped
 * or unknown — `truly_unknown` measured 0.
 *
 * So a code counts as linked when it PARSES, not when it appears in a roster. Gating the picker's
 * "CRM linked" label on `ireports360_contacts` would have unlinked 40 correct contacts and invited
 * a requester to re-enter a link that was already right — a worse lie, in the more expensive
 * direction.
 */

/** A CRM contact id is digits and nothing else — no separators, no suffix, no sign. */
const CRM_CONTACT_CODE = /^\d+$/;

/**
 * The CRM contact id a `crm_code` names, or null when the text does not name exactly one.
 *
 * Null covers every non-answer — unset, blank, and any text that is not purely digits — so a
 * caller tests one thing rather than re-deriving "is this linked" from a NaN check.
 */
export function parseCrmContactCode(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!CRM_CONTACT_CODE.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  // Past MAX_SAFE_INTEGER two different codes compare equal, which would link a contact to the
  // wrong CRM row rather than to none. `0` is not an id the CRM issues.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
