// ─── Third-party brand buttons ────────────────────────────────────────────────
//
// 🔒 OWNER, 2026-10-07: "give the WhatsApp share buttons their own brand constant" — asked after
// the decision-pair sweep left exactly two green buttons hand-written, and he was told why they
// could not take the approve token.
//
// 🔴 WHY THIS IS NOT IN `form-tokens.ts`. That file is the one form design, and its palette is
// asserted to be slate + orange + rose + the emerald of a decision pair — nothing else. A brand
// colour there would read as a fifth accent and, worse, would mean a future change to the approve
// green silently restyled a WhatsApp button. They are different concerns and they live apart on
// purpose: `identityTests()` in `tests/form-design-system.test.ts` scans every token in that file
// and would fail if this moved in.
//
// 🔴 THE COLOUR IS WHATSAPP'S OWN `#25D366`, BY THE OWNER'S INSTRUCTION ON 2026-10-07: "repaint
// the WhatsApp share buttons to the real #25D366". Until that moment these two buttons wore
// emerald-600 while the organogram's WhatsApp button and the dot on the WhatsApp Templates page
// used the real hex, so the app disagreed with itself about what WhatsApp looks like. It does not
// any more.
//
// 🔴 `#1DA851` IS NOT A SECOND BRAND COLOUR — it is `#25D366` darkened, for the hover and the
// hairline, because WhatsApp publishes the green without a pressed state. Darkening within the hue
// is deliberate: WhatsApp's other published greens (`#128C7E`, `#075E54`) are teals, and hovering
// from green to teal reads as a different button rather than the same one pressed.
//
// 🔴 THE INK IS NEAR-BLACK, BY THE OWNER'S INSTRUCTION ON 2026-10-08: "use near-black ink on the
// WhatsApp buttons". He was shown the measurement and chose legibility over likeness. WhatsApp's
// own treatment is white, and white on this green measures **1.98:1** — below WCAG AA for any text,
// and these labels are 12px. `text-slate-900` measures **9.00:1** on the fill and **5.76:1** on the
// `#1DA851` hover, so both states pass AA.
//
// 🔴 IT IS A FIXED NEAR-BLACK AND NOT THE THEME'S INK, DELIBERATELY. `--phx-ink` is `#0d1015` in
// light mode and `#eceae6` in dark (`src/styles/tokens.css`), so `text-phx-ink` on a FIXED brand
// fill would flip to near-white the moment the theme did — putting the 1.98:1 problem straight back
// with nothing to catch it, because the fill cannot follow the theme and the ink would. The test
// below refuses a theme-following ink here for that reason.

// The hex is written into the class strings below rather than built from a constant, because
// Tailwind only generates an arbitrary-value class it can SEE as a literal in the source — a
// `bg-[${GREEN}]` would compile to nothing at all. It also appears as DATA, not as a class, in
// `src/lib/share/social-share.ts` (the share-target list's `brand` field); that is a `lib` module
// and importing a UI token into it would invert the dependency, so the two are kept in step by
// hand and `tests/form-design-system.test.ts` pins this one.
//
// Nothing is SENT from a button wearing this. Every one of them opens WhatsApp on the person's own
// device with the message typed in; they press Send there, or they do not.

/**
 * TWO SIZES, ONE LOOK. The share links on the interview calendar are dense (12px on a row of
 * chips); "Open in WhatsApp" and "Send to any number" are full-size buttons at the top of their
 * own panel. Both wear the same brand green, the same darker hairline and the same hover, so a
 * change to the brand reaches all four buttons.
 *
 * 🔴 THE SEND PAIR WAS ALREADY `#25D366` AND WAS FOUND BY THE GUARD THIS REPAINT ADDED, not by
 * reading the files: the green-button ratchet looks for `bg-emerald-*`/`bg-green-*`, so a button
 * painted with the raw hex was invisible to it. Their hairline was the fill's own colour and they
 * had NO hover at all; both now match the share button, which is a 1px darkening and a hover state
 * added — stated plainly rather than slipped in, because a brand constant that preserved three
 * different versions of one button would not be a constant.
 */
/** The WhatsApp share button — opens WhatsApp with a message ready, sends nothing itself. */
export const phxWhatsAppShareButtonClassName =
  "inline-flex items-center gap-1.5 border border-[#1DA851] bg-[#25D366] px-2 py-1.5 text-[12px] font-bold leading-none text-slate-900 hover:bg-[#1DA851]";

/** The full-size WhatsApp button — "Open in WhatsApp", "Send to any number". Same look, bigger. */
export const phxWhatsAppSendButtonClassName =
  "inline-flex items-center gap-1.5 border border-[#1DA851] bg-[#25D366] px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-[#1DA851]";
