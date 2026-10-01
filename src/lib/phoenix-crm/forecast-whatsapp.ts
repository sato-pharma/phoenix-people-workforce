/**
 * Phoenix CRM — the agreed daily forecast, as a WhatsApp message the rep never has to type.
 *
 * WHY THIS IS A LINK AND NOT AN API SEND, WHICH IS NOT A SHORTCUT. The owner asked for the forecast to
 * reach the CNS WhatsApp group "without writing at all" (2026-10-01). **No WhatsApp product can
 * address a group**: the Cloud API sends to phone numbers, and a `chat.whatsapp.com` invite is a join
 * link, not a destination. That is the same wall the Facebook-groups answer hit twice. So the honest
 * maximum is ZERO TYPING rather than zero touch — this composes the whole message and hands it to
 * WhatsApp's own share sheet, where the rep picks the CNS group and presses send.
 *
 * It is also the pattern this codebase already established, in its own words at
 * `app/api/recruitment/candidates/[id]/whatsapp-reply/route.ts`: "the only 'send' in this codebase
 * PREPARED a wa.me link for a human to press in their own WhatsApp." When the HR handset joined the
 * platform that unlocked replying to an APPLICANT'S NUMBER — it did not unlock groups, and nothing
 * since has.
 *
 * 🔴 DO NOT "FINISH" THIS INTO AN AUTOMATIC SEND. There is no endpoint to send it to. A future session
 * that posts to `graph.facebook.com` with a group id gets a 400 and concludes the token is wrong.
 *
 * The message obeys the owner's standing rules: product NAMES, never codes; no ellipsis; Cairo dates.
 *
 * Pure on purpose — no imports, no server types — so the format is tested without a browser and this
 * file can be read by a client component without dragging server code into the bundle.
 */

/**
 * One line as it appears in the message: the name the rep reads, the boxes he agreed, and the product
 * family it belongs to (Tebofortin, Rispadex, …), which is what the message groups the lines under.
 */
export type ForecastMessageLine = { readonly productName: string; readonly units: number; readonly family?: string | null };

export type ForecastMessageInput = {
  /**
   * Whose forecast it is. The territory rather than the person, because `ForecastFormView` carries
   * `territoryName` and no rep name — and the territory is what the group actually tracks.
   */
  readonly territoryName: string;
  /** The forecast's own Cairo business day, `YYYY-MM-DD`, as the server issued it. */
  readonly day: string;
  readonly lines: readonly ForecastMessageLine[];
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * The day, written the way a person reads it in the group.
 *
 * 🔴 FORMATTED FROM THE PARTS, NEVER THROUGH `new Date(day)`. The value is already a Cairo business
 * day; parsing it as a Date makes it UTC midnight, which then prints as the day BEFORE for any reader
 * west of the meridian. That off-by-one is the standing timezone trap in this repo, and a forecast
 * labelled with yesterday's date in the line's group is worse than no label.
 */
export function forecastDayLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return day.trim();
  const [, year, month, dayOfMonth] = match;
  return `${Number(dayOfMonth)} ${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/**
 * The message itself: units per concentration, per product (owner, 2026-10-01). Each product family is
 * a block under its own bold heading, and every concentration in it is its own line with its own boxes;
 * a family with only one line today is that line alone, because "Dolabactin" over "Dolabactin: 10"
 * says the name twice. Families come in the form's order — the biggest daily share first — and so do
 * the lines inside each.
 *
 * 🔴 NO TOTAL, EVER. A box of Tebofortine 40 mg and a box of Tebofortine Forte 80 are not the same
 * quantity, and a box of Rispadex is not a box of either — so no line here adds boxes together, across
 * products OR across one product's concentrations. The first version ended "Total: 319 boxes"; the
 * owner ruled it out on sight. A total of anything across products is summed by VALUE, and the group
 * message deliberately carries none.
 *
 * Only products with boxes appear: a list padded with zeroes is longer, harder to read on a phone, and
 * says nothing. When every figure is zero it says so in words rather than arriving as a bare heading,
 * because a rep who genuinely expects nothing today still has to report it.
 */
export function composeForecastMessage(input: ForecastMessageInput): string {
  const head = `Daily forecast — ${input.territoryName.trim()}\n${forecastDayLabel(input.day)}`;

  const withBoxes = input.lines
    .filter((line) => Number.isFinite(line.units) && line.units > 0)
    .map((line) => ({
      productName: line.productName.trim(),
      units: Math.trunc(line.units),
      // A product the master gives no family is a group of its own, under its own name.
      family: (line.family ?? "").trim() || line.productName.trim(),
    }));

  if (withBoxes.length === 0) return `${head}\n\nNo boxes forecast today.`;

  const families = new Map<string, Array<{ productName: string; units: number }>>();
  for (const line of withBoxes) families.set(line.family, [...(families.get(line.family) ?? []), line]);

  const blocks = [...families.entries()].map(([family, lines]) =>
    lines.length === 1
      ? `${lines[0].productName}: ${lines[0].units}`
      : [`*${family}*`, ...lines.map((line) => `${line.productName}: ${line.units}`)].join("\n"),
  );
  return `${head}\n\n${blocks.join("\n\n")}`;
}

/**
 * WhatsApp's share sheet, with the message already in it.
 *
 * 🔴 NO NUMBER IN THE URL, DELIBERATELY. `wa.me/<digits>?text=` opens a chat with THAT PERSON, which
 * is the opposite of what is wanted: the rep must land on the picker so he can choose the CNS group.
 * `wa.me/?text=` is the form that opens the picker. Putting digits here would quietly send the line's
 * forecast to one individual instead.
 */
export function forecastWhatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
