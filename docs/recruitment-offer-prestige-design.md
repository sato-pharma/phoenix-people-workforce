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
It is the classic letter's blocks, word for word (ids re-keyed `-x`), re-dressed by an override sheet
appended to the base — exactly how the house and premium designs work. What the skin does:

- **An Oxford double rule** closes the letterhead (a heavy deep-blue rule over a hairline), and a CSS
  `double` border repeats it over the salary total and the acceptance block.
- **A serif display face** (Georgia, Noto Serif on the server, Times last) for the title, the monthly
  and annual figures, the clause numerals, the section numerals and the signatories' names. Running
  text stays in the house sans.
- **Sections numbered in Roman capitals** by a CSS counter, so a section a designer adds or removes
  renumbers itself.
- **The ink rule.** Every area the base sheet fills is switched off or cleared under its own selector.
  The one fill left is the 6% zebra on the salary table.
- **The seal** is placed as the Premium letter places it: 21 mm, its foot on the signatory's rule. The
  signature cell and the signature ink are the base's, untouched.
- No page chrome, no image, no `/brand/` file, so the preview and the PDF hand it over exactly as
  they hand over the classic letter. Square corners, no shadow, no gradient.

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
