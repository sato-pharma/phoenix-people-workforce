# The Prestige offer letter and the Product Manager offer

Owner, 17 November 2026: "a design in the job offer module a offer tailored to product manager and
can be reporting to marketing manager or group product manager as i choose but very premium polished".
He answered two questions before it was built:

- **Letter look: "both"** — a new sixth design (Prestige) AND the Product Manager's own wording on the
  job title, so every design prints it through `{{roleSummary}}`.
- **Manager name: "Title only"** — the letter prints "reporting to the Group Product Manager" or
  "reporting to the Marketing Manager", never a person's name.

## The design

`src/lib/offers/prestige-template.ts` registers it; `src/lib/offers/prestige-skin.ts` is its look.
It uses the classic letter's blocks, word for word (ids re-keyed `-x`).

**The first version was rejected.** It re-ruled the ordinary letter (a double rule under the
letterhead, a serif title), and he answered the same evening: "this is the normal templete i want a
godmode premium polished one". So the letter now opens on a plate of its own.

- **A navy cover plate.** `prestigeOfferBody` folds the letterhead, reference and title blocks into one
  plate in Sato navy (`#17304d`, the navy the on-navy mark was measured against). It carries:
  - the reverse (white) mark and the company's names;
  - "Offer of Employment" between two gold rules;
  - the candidate's name in large spaced serif capitals;
  - the position in serif italic;
  - "Reporting to the …" when the offer names a manager;
  - the reference ledger along its foot.

  Four flat-gold corner marks sit inside it, and a gold rule runs a hair below it. Editing those
  three blocks in the designer moves the plate. The ordinary letterhead, reference row, title and
  rail are not drawn as well.
- **Flat gold.** `#a07a3a` on paper, `#c8a462` on navy, and a deeper `#86662d` for small gold type.
  The gold is printed flat, like foil, never as a gradient or a sheen.
- **A serif voice** (Georgia, Noto Serif on the server, Times last) for:
  - the running text and the figures;
  - the clause numerals and the section numerals;
  - the signatories.

  Labels stay in the house sans, in spaced capitals.
- **Sections numbered in Roman capitals** in gold by a CSS counter, so a section a designer adds or
  removes renumbers itself.
- **The salary** is a 32 pt serif figure with the currency set small. The table has a 6% zebra and a
  double navy rule over the total. The acceptance block opens on the same double rule.
- **A navy closing plate.** The legal footer sits in navy under its own gold rule, so the letter
  closes the way it opens.
- **Three fills only:** the cover plate, the zebra and the closing plate. Every other area the base
  sheet fills is switched off or cleared under its own selector.
- **The signature and the seal are centred on the company's line, one over the other.** Owner,
  17 Nov 2026: "put the stamp on my signature", then "center the signature and the stamp".
  - The seal is 21 mm, like Premium's. Its foot rests just under the rule, so the signature sits in
    its lower half and the SIGNATURE label below stays clear. Checked in the browser.
  - It prints as ink (multiply), so the signature reads through it.
  - The signature keeps its own size: 35 px is the file's own pixel height, and enlarging it only
    blurs it.
  - The signing lines are navy, and each label sits centred under its line in small gold capitals.
    All four lines stay level.
- **What the PDF and preview pass.** They hand the plate the reverse mark exactly as they hand it to
  the Sato letter. There is no page chrome, no tiled image and no `/brand/` file.
- **Square corners, no shadow, no gradient.**

The four frozen designs keep their digests and Premium is untouched; the skin reaches only a row whose
`variant` is `prestige`.

## Which position opens on it

The registry entry carries `opensFor: ["Product Manager"]`. `ensureBuiltinTemplates()` in
`src/lib/offers/service.ts` reads it **once**, when it first inserts the prestige row: it points
`offer_job_titles.template_id` at the new row for each named title **whose design is still unset**.
A title HR has already pointed elsewhere is left alone, and a failure is a `console.warn`, never a
thrown error (the designer's template list must not break over it). Prestige is never the default.

## The Product Manager title

- Seeded in `OFFER_SEED_JOB_TITLES` and inserted on production by migration
  `20261117154057_offer_prestige_design_and_product_manager.sql`: cost of living **3,500** (payroll's
  pair for the title, 3,000 allowance + 500 fuel, as for the Training Manager), reports to the
  **Marketing Manager**, "One year, renewable".
- Its paragraph is `OFFER_PRODUCT_MANAGER_ROLE_SUMMARY` (`src/lib/offers/role-summary.ts`). It
  describes the job as Sato Pharma runs it: the portfolio's strategy and brand plan, positioning and
  key messages, key opinion leaders, and product and medical knowledge — training the field force on
  the products, the diseases they treat and the key messages, and testing that knowledge (his locked
  rule of 4 November 2026: never the Training Manager's). It promises no territory, district plan or
  field team, and names no manager — the letter's opening sentence already does.
- The migration builds the same words with `chr(8212)`, `chr(8217)` and `chr(10)`;
  `tests/offer-role-summary.test.ts` rebuilds them from the SQL and compares them to the constant.

## Choosing the reporting line

`src/lib/offers/reports-to-choices.ts` returns `["Marketing Manager", "Group Product Manager"]` for
the Product Manager title and nothing for any other. The offer form shows them as two buttons beside
the Reports to box; a press writes the title into the box, which stays typeable. The letter prints
whatever the box holds as "reporting to the …".

## Order of release

The migration widens the two `offer_templates` CHECK constraints (`variant`, `builtin_key`) to allow
`prestige`. It must run before the code deploys, because the seed insert is refused until it does and
`ensureBuiltinTemplates()` throws on a refused insert. It was applied to staging and production on
17 November 2026, before the PR opened.
