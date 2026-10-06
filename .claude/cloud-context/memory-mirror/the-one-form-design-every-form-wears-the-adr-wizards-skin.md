---
name: the-one-form-design-every-form-wears-the-adr-wizards-skin
description: "Every form in the system wears the Adverse Drug Reaction wizard's skin — strings in src/components/ui/form-tokens.ts, components in form-kit.tsx, ratchet at ZERO, h-8/h-9 dense controls kept by his own 2026-10-06 ruling — and the eight codemod traps, including a build failure that lint and typecheck both passed and 177 overrides a template literal silently threw away"
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
screen. **287 files import the tokens now.**

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

🔴 **Eight codemod traps, every one of which cost a re-run:**
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

🔴 **And a quoted bash heredoc on this machine HALVED the backslashes in a JS regex literal** —
`/[^"\\]/` landed as `/[^"\]/`, which matched nothing and reported "0 controls" with no error at all.
Write a script with the file tool, or scan instead of matching.

**Held by** `tests/form-design-system.test.ts` in the required `validate` job: it pins the identity,
asserts the ADR form still imports the kit and renders `FormWizard`, **ratchets painted controls at
ZERO**, refuses a template-literal override, and asserts its own scan still finds ~1,485 controls
with ~1,171 reaching a token — because a cap of zero would otherwise pass on a scan that had
quietly stopped finding anything. Never raise it. Hook: `AGENTS.md` §4, "How to build". Account:
`docs/agents-owner-rules.md`, "The one form design".

Related: [[never-horizontal-scroll-always-mobile-and-desktop-friendly]], [[the-house-document-identity-standard]].
