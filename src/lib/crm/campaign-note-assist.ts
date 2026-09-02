/**
 * The cheap-model half of campaign-note reading: what the rules could not classify.
 *
 * `campaign-note.ts` settles most of the corpus for free — measured 2026-08-28 over all 17,474
 * distinct campaign notes on production, the rules name a person in 57.8% and a place in 24.3%, and
 * recognise a further 12.8% as the rep's own remark. What is left is **2,664 notes (15.2%)** that a
 * human reads instantly and a rule cannot:
 *
 *   "محمد الحويزي"            a bare name — a doctor, or the pharmacist who owns the shop?
 *   "م. طنطا العام"           an abbreviation for Tanta General Hospital
 *   "الجمعيه الشرعيه فالبيطاش"  a charity clinic, with its district inside its name
 *   "ص ثروت"                  "ص" is صيدلية — Tharwat Pharmacy
 *
 * The owner's instruction, 2026-08-28: *"you can use a cheap or free AI assist that already exists
 * in our code base to separate and analyse and extract the data."* So this uses the same
 * `gpt-5.4-nano` tier the rest of the app already runs on ($0.20/$1.25 per million in/out), on the
 * residue only — never on a note the rules already read, which is what keeps it cheap.
 *
 * TWO RULES CARRIED OVER FROM `campaign-account.ts`, AND NEITHER IS OPTIONAL.
 *
 * 1. **The model may choose and delimit; it may not author.** Every string it returns must occur
 *    inside the rep's own segment or it is dropped. Asked to find a doctor in a note that has none,
 *    a model will invent a plausible Egyptian name, and an invented doctor on a manager's board is
 *    worse than a blank — it looks like evidence.
 * 2. **The assist is invisible** (owner rule, ai-assist-invisible-to-users). No badge, no wording, no
 *    attribution reaches a user. Internal metrics still record the call, because hiding it is for
 *    users and not for the audit trail.
 *
 * It never throws. This runs inside a page render, so a missing key, a timeout or a malformed answer
 * must all degrade to "the rules' answer, unchanged".
 *
 * SPLIT INTO THREE ON 2026-09-02, along one line: what a "use client" component may reach.
 *
 *   campaign-note.ts                 the CampaignAssistReading type and applyAssist — the FOLD
 *   campaign-note-assist.ts (here)   acceptAssistedValue / acceptAssistRow — the GATE
 *   campaign-note-assist-model.ts    assistCampaignFragments — the CALL
 *
 * It was one file until rep-visits.ts needed the fold, and rep-visits.ts is imported by
 * rep-visits-detail.tsx, which is "use client". THIS FILE IS NOT CLIENT-SAFE and cannot be made so:
 * the gate needs normalizeAccountText from campaign-account.ts, and campaign-account.ts imports
 * @/lib/ai/openai-client itself. So the fold went to campaign-note.ts, which imports only
 * contact-taxonomy — the one of the three a client component can reach without dragging the OpenAI
 * SDK into the browser bundle.
 *
 * Measured, both ways: 40 client entry files reach src/lib/ai/ on main, 41 with the fold imported
 * from here, 40 again with it in campaign-note.ts. openai-client.ts carries no `server-only` guard,
 * so the wrong answer failed nothing — it would simply have shipped.
 */

import { normalizeAccountText } from "@/lib/crm/campaign-account";
import { type CampaignAccountKind, type CampaignAssistReading } from "@/lib/crm/campaign-note";

/** Longer than this is the segment handed back, not a name pulled out of it. */
const MAX_NAME_LENGTH = 80;
/** Shorter than this identifies nobody ("د.", "ص", "hi"). */
const MIN_NAME_LENGTH = 3;

const PLACE_KINDS: ReadonlyArray<CampaignAccountKind> = [
  "hospital",
  "clinic",
  "pharmacy",
  "laboratory",
  "medical centre",
  "company",
  "warehouse",
];


/**
 * Accept a model answer only when the rep actually wrote it.
 *
 * Pure and exported so the anti-fabrication guarantee is tested directly, with no network call.
 */
export function acceptAssistedValue(segment: string, candidate: string | null | undefined): string | null {
  const source = typeof segment === "string" ? segment.trim() : "";
  const answer = typeof candidate === "string" ? candidate.trim() : "";
  if (!source || !answer) return null;
  if (["null", "none", "n/a", "na", "-", "unknown"].includes(answer.toLowerCase())) return null;
  if (answer.length < MIN_NAME_LENGTH || answer.length > MAX_NAME_LENGTH) return null;
  if (!normalizeAccountText(source).includes(normalizeAccountText(answer))) return null;
  return answer;
}

/** Turn one raw model row into a reading, or null if it fails the gate. */
export function acceptAssistRow(segment: string, row: unknown): CampaignAssistReading | null {
  if (typeof row !== "object" || row === null) return null;
  const { kind, name, placeKind, speciality } = row as {
    kind?: unknown;
    name?: unknown;
    placeKind?: unknown;
    speciality?: unknown;
  };

  if (kind === "remark") return { kind: "remark" };

  const accepted = acceptAssistedValue(segment, typeof name === "string" ? name : null);
  if (!accepted) return null;

  if (kind === "person") {
    return {
      kind: "person",
      name: accepted,
      speciality: acceptAssistedValue(segment, typeof speciality === "string" ? speciality : null),
    };
  }

  if (kind === "place") {
    const resolved = PLACE_KINDS.find((value) => value === placeKind);
    // A place whose kind the model did not name is still a place the rep visited; "clinic" is the
    // least specific claim available and is preferred to dropping the row.
    return { kind: "place", name: accepted, placeKind: resolved ?? "clinic" };
  }

  return null;
}
