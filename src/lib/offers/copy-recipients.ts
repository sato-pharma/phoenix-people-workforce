/**
 * Who else receives a copy of an offer — the CC and BCC lines (owner, 2026-09-28).
 *
 * ── Any address, no reason ──
 * The owner was asked whether an offer, which carries the candidate's salary, may be copied outside
 * the company, and answered "anyone, no reason". So an address is judged on its SHAPE only: nothing
 * here refuses a domain and nothing asks for a justification. Do not add a company-only rule or a
 * reason box back — that was the question, and that was his answer.
 *
 * ── One reader for the screen and the server ──
 * The composer calls this to show HR, as they type, exactly who will be copied; the send calls it
 * again on the server before a single byte leaves. Pure and dependency-free on purpose, so the
 * browser bundle and the route read the same rule and cannot drift apart.
 *
 * ── Nothing is dropped silently ──
 * An address that is not an email STOPS the send — sending to the others and quietly leaving one
 * off is a partial send nobody chose. An address that is only redundant (the candidate's own, or
 * one already on the CC line) is left off and SAID, because it changes nothing about who reads it.
 */

/**
 * The most copies one offer may carry, CC and BCC together.
 *
 * Ten is a hiring manager, their manager, HR and a few colleagues with room to spare. The Notification
 * Confidence Gate is told the same number (`offers/offer_letter` in `CEILING_OVERRIDES`), so an offer
 * inside this cap is never held as a mass send — the two are pinned together by a test.
 */
export const OFFER_COPY_MAX = 10;

export type OfferCopyRecipients = {
  bcc: string[];
  cc: string[];
};

export type OfferCopyPlan = OfferCopyRecipients & {
  /** Entries that are not email addresses, per line, exactly as typed — so the screen can say which box. */
  invalid: OfferCopyRecipients;
  /** The over-the-cap refusal on its own, since it belongs to neither line alone. Also in `problems`. */
  limitProblem: string | null;
  /** Addresses left off because they were redundant, and why. Shown to HR, never swallowed. */
  notes: string[];
  /** What stops the send, in words HR can act on. Empty means the copies may go. */
  problems: string[];
};

const EMAIL_SHAPE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Every address typed or pasted into one line.
 *
 * Commas, semicolons and new lines separate entries, and so do plain spaces — "a@x.com b@y.com" is
 * two people. An Outlook-style `Omar Anwar <omar@satopharma.com>` is read as the address inside the
 * angle brackets, because that is what somebody pasting from their mail client means.
 */
export function splitOfferCopyAddresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(splitOfferCopyAddresses);
  if (value === null || value === undefined) return [];

  const out: string[] = [];
  for (const entry of String(value).split(/[,;\n\r]+/)) {
    const bracketed = entry.match(/<([^<>]*)>/);
    if (bracketed) {
      const inside = bracketed[1].trim();
      if (inside) out.push(inside);
      continue;
    }
    for (const word of entry.split(/\s+/)) {
      const trimmed = word.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

export function isOfferCopyAddress(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}

/**
 * The CC or BCC box with one more address on the end, as the "Add to CC" / "Add to BCC" buttons write
 * it (owner, 2026-11-10). Whatever was typed is kept exactly; an address already there is not added
 * twice, whatever its case.
 */
export function appendOfferCopyAddress(value: string, email: string): string {
  const address = email.trim().toLowerCase();
  if (!address) return value;
  if (splitOfferCopyAddresses(value).some((entry) => entry.toLowerCase() === address)) return value;
  const kept = value.trim().replace(/[,;\s]+$/, "");
  return kept ? `${kept}, ${address}` : address;
}

/**
 * The CC and BCC an offer will actually carry.
 *
 * Every address lower-cased and de-duplicated. The candidate's own address is left off both lines
 * (it is already the To). An address on both lines stays on CC — the line everyone can see — and
 * leaves BCC, because a person cannot be both openly and secretly copied on one message.
 */
export function planOfferCopies(input: { bcc?: unknown; candidateEmail?: string | null; cc?: unknown }): OfferCopyPlan {
  const candidate = String(input.candidateEmail ?? "").trim().toLowerCase();
  const notes: string[] = [];
  const problems: string[] = [];
  let candidateDropped = false;

  const clean = (raw: unknown, taken: Set<string>) => {
    const kept: string[] = [];
    const repeated: string[] = [];
    const bad: string[] = [];
    for (const entry of splitOfferCopyAddresses(raw)) {
      const address = entry.trim().toLowerCase();
      if (!isOfferCopyAddress(address)) {
        if (!bad.includes(entry.trim())) bad.push(entry.trim());
        continue;
      }
      if (candidate && address === candidate) {
        candidateDropped = true;
        continue;
      }
      if (taken.has(address)) {
        if (!repeated.includes(address)) repeated.push(address);
        continue;
      }
      taken.add(address);
      kept.push(address);
    }
    return { bad, kept, repeated };
  };

  const ccResult = clean(input.cc, new Set<string>());
  const cc = ccResult.kept;
  // BCC is judged against CC's addresses, so a person on both lines keeps only the visible one.
  const bccResult = clean(input.bcc, new Set<string>(cc));
  const bcc = bccResult.kept;

  const invalid = [...ccResult.bad, ...bccResult.bad.filter((entry) => !ccResult.bad.includes(entry))];
  if (invalid.length > 0) {
    problems.push(
      `${invalid.length === 1 ? "This is" : "These are"} not ${invalid.length === 1 ? "an email address" : "email addresses"}: ${invalid.join(", ")}. Fix or remove ${invalid.length === 1 ? "it" : "them"} before sending.`,
    );
  }
  const limitProblem =
    cc.length + bcc.length > OFFER_COPY_MAX
      ? `An offer can be copied to at most ${OFFER_COPY_MAX} people; this one has ${cc.length + bcc.length} on CC and BCC together.`
      : null;
  if (limitProblem) problems.push(limitProblem);
  if (candidateDropped) {
    notes.push("The candidate's own address is already on To, so it was left off the copies.");
  }
  const onBoth = bccResult.repeated.filter((address) => cc.includes(address));
  if (onBoth.length > 0) {
    notes.push(`${onBoth.join(", ")} ${onBoth.length === 1 ? "is" : "are"} on CC already, so left off BCC.`);
  }

  return { bcc, cc, invalid: { bcc: bccResult.bad, cc: ccResult.bad }, limitProblem, notes, problems };
}
