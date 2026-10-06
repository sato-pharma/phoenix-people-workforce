---
name: the-one-form-design-every-form-wears-the-adr-wizards-skin
description: "Every form in the system wears the Adverse Drug Reaction wizard's skin — strings in src/components/ui/form-tokens.ts, components in form-kit.tsx, ratchet at ZERO, h-8/h-9 dense controls AND every dark ground kept out by his own 2026-10-06 rulings — and the fifteen codemod traps, including a build failure that lint and typecheck both passed and 177 overrides a template literal silently threw away"
metadata:
  node_type: memory
  type: project
  originSessionId: 32214720-e523-4492-a811-fa71ff688146
  modified: 2026-10-06T05:05:57.397Z
---

Owner rule, **2026-10-06**: *"sweep the system wide everywhere admin or emp any form or any thing
applicable make it follow this form design"*, sent with a screenshot of the **Adverse Drug Reaction
Report** wizard in the admin shell.

**Why:** the look lived nowhere, measured from the sweep's own diff — **234 files painted their own
box, in 621 class strings**, and no two agreed: **five field heights** (`h-8`…`h-12`), **twelve
corner radii** (including hand-written `rounded-[5px]`, `[6px]`, `[8px]`, `[14px]`), **twenty
different focus border colours** and **thirty-one different focus rings**. Every new form copied
whichever neighbour the session happened to open, so restyling one screen would have changed one
screen. **282 files import the tokens now.**

**How to apply:** import the class strings from `src/components/ui/form-tokens.ts`
(`phxFieldClassName`, `phxSelectClassName`, `phxTextareaClassName`, `phxLabelClassName`, the four
button tokens) and assemble from `src/components/ui/form-kit.tsx` (`FormField`, `FormGrid`,
`FormBlock`, `CheckTile`, `FormError`, `FormActions`, `FormStepHeading`, `FormWizard` — the whole
multi-step shell). Never hand-write a field's border, background, radius, height or focus ring. The
identity: square corners, `h-10`, slate-300 hairline on white, `px-3`, orange focus border + ring,
micro-caps `text-phx-xs font-black uppercase text-slate-500` labels, rose required star, near-black
Next, orange Submit; slate + orange + rose and nothing else. `form-tokens.ts` is plain strings with
no `"use client"`, so a server component may import it. 🔴 **`h-8`/`h-9` on a dense table or
filter control is KEPT — HIS OWN RULING, 2026-10-06**: asked whether the ~200 dense controls should
be forced to the design's 40px he answered *"keep h-8 and h-9 on the dense table filters"*, so never
bring them into line later and never ask him again. `h-10` and taller became the design's 40px.

**Reach, measured 2026-10-06:** 1,485 real form controls — counting `<Input>`, `<Textarea>` and
`<SearchableSelect>` as the controls they render — of which **1,171 reach a shared token** and
**NONE paint a box of their own.** The rest paint nothing at all: chromeless inline editors taking
their box from a parent, plus the printed-document editors under `hiring-pack/` and `offers/`,
exempt under the house document identity. The ADR form itself now CONSUMES the kit, which is what
makes "change the token and the system follows" true.

🔴 **Fifteen codemod traps, every one of which cost a re-run:**
1. **Dropping a field's `pl-9` puts the magnifier on top of the text.** Side padding *larger* than
   the token's own `px-3` is icon clearance, not skin; the first pass broke ~45 search boxes.
2. **A regex that ends a JSX tag at the first `>` ends it inside `(e) => …`** — the attribute list
   is truncated before `className` on every control carrying a handler, so the sweep skips them and
   the audit afterwards calls them "built at runtime", which reads as *nothing more to do*.
3. **A ratchet that does not RESOLVE a className passes on a painted tree.** The first one read only
   bare tags with a static className: it missed the wrappers, missed `FIELD_CLASS`/`CONTROL`/`cell`
   constants, and counted any *reference* as on-design. 376 of 1,485 controls were still painting,
   `ui/searchable-select.tsx` among them — `rounded-[6px]` in a primitive the whole app renders,
   inherited by ~150 call sites, and the employee portal does NOT reset a radius. Also follow a
   `+`-concatenated constant and a plain alias (`const x = phxFieldClassName`): missing either
   reported 341 already-swept controls as unswept and invited a token in front of a painter, where
   `cn` lets the painter win.
4. **This repo's comments QUOTE JSX, so an unmasked scan reads prose as a control** — 26 of them,
   each looking like a control with no className, which is the shape that invites a codemod to add
   one. Mask comments per character first, always.
5. 🔴 **An inserted import above `"use client"` is a BUILD failure that `lint` and `typecheck` BOTH
   pass.** `remote-check all` reported lint PASS, typecheck PASS, the unit suite green, then
   `Ecmascript file had an error … org-fields.tsx:2:1`. **Run `all`, never `test`, whenever a sweep
   adds a file or an import.**
6. **A chromeless control must not be GIVEN the token** — 24 of them paint no box by design
   (`border-0`/`bg-transparent` inside a wrapper that carries the border and the `focus-within`
   ring), and prepending the token paints a second border inside the first. Detectable because
   `bg-transparent` survives the strip.
7. 🔴 **A TEMPLATE LITERAL GETS NO TAILWIND-MERGE, so the override silently LOSES.** 177 of the
   constants the sweep wrote were `` `${phxSelectClassName} h-9 px-2` ``, which puts BOTH the
   token's `h-10` and the caller's `h-9` in one class attribute with nothing to resolve them —
   `cn()` is tailwind-merge, a template is string concatenation — and the stylesheet's own order
   hands the win to the LARGER value, so a caller asking for a 36px dense field rendered 40px. Same
   shape as the `text-phx-*` defect of 2026-08-28: in the source, absent from the DOM, invisible to
   lint, to typecheck and to any test that only reads classes. The guard's fourth part now refuses
   the template form wherever the tail conflicts with a group the token already sets.
8. 🔴 **A guard that mandates `cn()` must also RESOLVE `cn()`.** Converting those 177 made the
   ratchet stop following the very form it had just required, and the measured reach fell from
   1,171 to 668 with nothing changed on screen — a number that, left unread, would have shipped in
   the PR as the truth. Re-measure after every change to the resolver, never only after a change to
   the code.

9. 🔴 **THE TOKEN IS `text-sm` = 14px, AND iOS SAFARI ZOOMS THE WHOLE VIEWPORT ON A FIELD
   UNDER 16px.** `approvals-hub/decision-actions.tsx` — the screen where money moves — had
   already been fixed with `text-base … md:text-sm`, and the sweep flattened it to the bare token.
   Caught ONLY by the full unit suite on the box, by its own named assertion in
   `tests/direct-orders-approval-window-mobile.test.ts`; lint, typecheck and the build all passed
   the same commit. Now `cn(phxTextareaClassName, "text-base md:text-sm")`, with the assertion
   pinning the composition in BOTH halves rather than the old contiguous literal. Measured across
   the branch: exactly ONE call site carried that pair, so it is a one-screen exception — **never
   change the token to fix it**, which would redesign his own screen.

10. 🔴 **LIFTING A SHELL INTO A SHARED KIT MOVES THE REFERENCE A SIBLING'S TEST MEASURES
    AGAINST.** `tests/phoenix-crm-step-form.test.ts` pins the CRM step form to Report It's own five
    class strings and says *"the reference moved"* when Report It stops carrying them — which is
    exactly what happened when Report It began consuming `form-kit.tsx`, byte-identical, with the
    screen unchanged. Re-point the reference to the kit AND assert Report It still renders
    `<FormWizard`, or the kit can drift from the screen he pointed at. **`run-tests.ts` stops at the
    first throw, so each box round buys ONE of these** — find the rest cheaply by listing every
    test that reads a file the branch changed and names a literal the branch removed.

11. 🔴 **THE DARK AUTH SCREENS ARE NOT THIS DESIGN.** `auth/premium-login-page.tsx` and
    `auth/password-setup-form.tsx` are a deliberate dark glass identity (`border-white/14`,
    `bg-white/[0.045]`, white text, `#ff7900` focus, `h-12`/`h-14`, `text-base`). The light token
    turned the login fields into white boxes on a dark panel — the screen every employee meets
    first — and only half of them, because one of the two kept its overrides. Restored byte for
    byte; `src/components/auth/` is in the guard's `EXEMPT` list. 🔴 **AND THE FRONT DOOR STAYING
    OUT IS HIS OWN RULING, 2026-10-06** — asked whether the login screen should wear the design too he
    answered *"keep the login screen out of the form design"*.
    🔴 **THEN EVERY OTHER DARK GROUND BECAME HIS RULING TOO, the same day.** Told that the two admin
    menus, the black sidebar's search (`bg-[#000000]`), the weekly Field Force band and the weekly
    column editor's near-black select (`bg-[#020617]`) had been restored on the SWEEP's judgement
    rather than his, he answered *"keep the dark menus and bands out of the form design too"*. So a
    dark ground is exempt BY HIS DECISION, not a session's taste: the light token is never prepended
    to a control sitting on one, none is converted later, and he is never asked again. Two of those
    grounds are arbitrary hex, so a sweep looking for colour NAMES cannot see them — read the ground
    from the container, never from the control's own class string.

12. 🔴 **FILTERING A SCAN'S GENERIC MATCHES KILLS THE TRUE POSITIVE WITH THE NOISE.** The scan
    that looked for pinned literals the branch had removed returned 21 hits, nearly all noise
    (`border-slate-200`), so the generic ones were filtered — and `text-base` IS generic. It then
    reported **0 remaining** while `tests/portal-rep-kpi-month.test.ts` was already red. The thing
    that finds this is a DIFF, not a scan: count each functional class in `origin/main`'s copy of
    every swept file and in the branch's, and read every file whose count went DOWN. Four had
    dropped a deliberate `text-base`. The three that mattered are pinned together now by
    `SIXTEEN_PX_KEEPS` in `tests/form-design-system.test.ts`.

13. 🔴 **A DENSE SIZE CAN BE PINNED BY A TEST THAT EXISTS BECAUSE MONEY IS APPROVED THERE.**
    The outstation expense review's approved-amount input is `h-8 w-28 … text-xs`, pinned verbatim
    by `tests/expense-review-row-height.test.ts` (*"the controls are moved, never reshaped"*, written
    after an earlier row-shortening attempt reshaped them). The sweep took it to 40px and the guard
    fired: *"no size reduction on a money field"*. Restore the string and exempt the file — **never
    relax the assertion**, which would turn a red test into a shipped change on an approvals screen.

14. 🔴 **A SHORT className ON A WRAPPER IS NOT A HALF-STRIP — READ THE TAG.** Two planning-calendar
    controls read `className="w-full px-3 ring-1 ring-transparent"` where main had a full skin, which
    looks precisely like a stripped control. They are `<SearchableSelect>`, whose own base is
    `cn(phxSelectClassName, "pr-9")` and which merges the caller's classes over it — so they were
    already on-design, and "restoring" the fill painted grey over the design. `<Input>`, `<Textarea>`
    and `<SearchableSelect>` carry the token; only a RAW `<input>`/`<select>`/`<textarea>` must name
    its own ground.

15. 🔴 **AN `EXEMPT` LIST STOPS THE RATCHET COUNTING A FILE — IT DOES NOT KEEP THAT FILE'S
    CONTROL DARK.** Four of the five restored dark grounds survived the branch; the admin
    sidebar's module search did not, and SHIPPED in #5382 as `cn(phxFieldClassName, "pl-9 pr-8")`
    — a lit white box inside a bare `bg-[#000000]` sidebar, on every admin page — precisely
    because exempting the FILE made the guard look away from the control that needed watching.
    `DARK_GROUND_KEEPS` in `tests/form-design-system.test.ts` now asserts the fragment that
    MAKES each of the six dark controls dark. **An exemption is the absence of a rule; his
    ruling needed the presence of one.**
    🔴 **The audit that found it is the one to repeat:** scan every file importing a token (283)
    for a control whose CONTAINER is dark — 33 candidates, 23 of them a light body under a dark
    HEADER STRIP (resolve those mechanically on whether a light ground is re-declared between the
    two), 10 read by hand, 9 noise. The tenth, the payroll copilot's sheet search, sits in a
    `bg-slate-900` band and was a deliberate WHITE box there before the sweep too — his design,
    not a loss. **Always compare against the pre-sweep file before calling a white control on a
    dark band a defect.**

🔴 **And a quoted bash heredoc on this machine HALVED the backslashes in a JS regex literal** —
`/[^"\\]/` landed as `/[^"\]/`, which matched nothing and reported "0 controls" with no error at all.
Write a script with the file tool, or scan instead of matching.

**Held by** `tests/form-design-system.test.ts` in the required `validate` job: it pins the identity,
asserts the ADR form still imports the kit and renders `FormWizard`, **ratchets painted controls at
ZERO**, refuses a template-literal override, and asserts its own scan still finds ~1,485 controls
with ~1,171 reaching a token — because a cap of zero would otherwise pass on a scan that had
quietly stopped finding anything. Never raise it. Hook: `AGENTS.md` §4, "How to build". Account:
`docs/agents-owner-rules.md`, "The one form design".

**Shipped 2026-10-06** as PR **#5382**, squash `20c8cf573` — 346 files, and it took FOUR runs of
`remote-check all` on the box: three found a real defect the design had broken (the approvals reason
box's 16px, a moved reference after the shell was lifted into the kit, the expense review's money
field), and the fourth was clean. The sweep also took the body-portal radius ratchet in
`tests/square-edge-portal-ratchet.test.ts` from **173 to 156** — seventeen rounded corners in
components that mount outside both shells, where no `globals.css` sweep reaches.

Related: [[never-horizontal-scroll-always-mobile-and-desktop-friendly]], [[the-house-document-identity-standard]].
