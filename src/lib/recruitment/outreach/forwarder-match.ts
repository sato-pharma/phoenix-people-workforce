// Recruitment / ATS — matching a forwarded CV's sender to the advert channel that owns it.
//
// ~95% of CVs reach us as a forward from a small number of dedicated relay handsets, and a forward
// drops the applicant's own code-bearing greeting. So for a code-less forward, the ONLY signal left
// of where it came from is which relay forwarded it. Each relay is tied to one advert channel; this
// module turns "a message from +201280955558" into "channel PX-FORWARDED".
//
// Pure (no I/O): the service loads the channel list and hands it in, the intake path resolves
// against it, and the tests exercise the matching directly.

/**
 * The last nine significant digits of a phone number, or null when there are too few.
 *
 * Numbers reach us in three shapes for the same line — `+201280955558` (what Meta reports),
 * `201280955558`, and the local `01280955558` a human types — so matching on the raw string would
 * silently miss. Nine digits is the Egyptian subscriber number without the country code or the
 * trunk `0`; leading zeros are stripped first so the local and international forms collapse together.
 * A silently non-matching relay would send every forward down the "no channel" path — the exact
 * failure this exists to avoid — so the comparison is deliberately format-tolerant.
 */
export function phoneDigitsTail(value: string | null | undefined): string | null {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Whether any identifier in the list is the same line as `sender`. */
export function forwarderMatches(
  identifiers: ReadonlyArray<string | null | undefined>,
  sender: string | null | undefined,
): boolean {
  const target = phoneDigitsTail(sender);
  if (!target) return false;
  return identifiers.some((identifier) => phoneDigitsTail(identifier) === target);
}

export type ForwarderChannel = {
  code: string;
  forwarderIdentifiers: ReadonlyArray<string | null | undefined>;
};

/**
 * The advert code of the channel that owns `sender`'s relay handset, or null.
 *
 * Returns null for anything without a usable phone tail (an email sender, a WhatsApp username with
 * no number) so the caller never runs a lookup it cannot answer. Retired channels are matched too —
 * a relay that fed a group months ago keeps attributing, exactly as a tracking code does.
 */
export function resolveForwarderChannelFromList(
  channels: ReadonlyArray<ForwarderChannel>,
  sender: string | null | undefined,
): string | null {
  const target = phoneDigitsTail(sender);
  if (!target) return null;
  for (const channel of channels) {
    if (channel.forwarderIdentifiers.some((identifier) => phoneDigitsTail(identifier) === target)) {
      return channel.code;
    }
  }
  return null;
}
