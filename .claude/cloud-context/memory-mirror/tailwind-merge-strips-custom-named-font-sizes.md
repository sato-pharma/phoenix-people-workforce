---
name: tailwind-merge-strips-custom-named-font-sizes
description: "cn() silently dropped text-phx-* sizes app-wide because tailwind-merge files them as COLOURS - sidebar rendered 16px instead of 13px"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cf5aa32-4d8c-4a73-9b79-a284b8c51694
  modified: 2026-08-28T13:06:47.073Z
---

`cn()` is `twMerge(clsx(...))`. **tailwind-merge is a plain JS library and never sees Tailwind
v4's CSS-declared theme**, so the `--text-phx-*` scale (`app/globals.css` -> `--phx-fs-*` in
`src/styles/tokens.css`) does not exist as far as it is concerned. Its default config only knows
the stock names (`xs`, `sm`, `base`, `lg`...). Given `text-phx-md` it fails the font-size check
and files the class under **`text-color`** - where it then **conflicts with any real colour class
in the same `cn()` call and one of the two is silently dropped.**

**Measured live 2026-08-28 on `/admin`:** every sidebar nav label rendered at **16px** (the
inherited root size) instead of `text-phx-md` = **13px**, and the alarm badges at **16px/900**,
18x14px -> 24x20px, instead of `text-phx-2xs` = **10px**. The owner reported it as the font being
"bolder than it was" and the notification badges being "very big and bold, very very noisy" -
both were the same single defect.

```
cn("... text-phx-md font-semibold ...", active ? "..." : "text-slate-400 ...")
   -> text-phx-md DROPPED by text-slate-400
```

**The renaming sweep is what introduced it.** `text-[13px]` -> `text-phx-md` app-wide looks like a
pure rename and audits as one - and `text-[13px]` was SAFE, because tailwind-merge parses the
bracket contents and correctly sees a length. The defect exists only for the *named* form. About
**4,800 size call sites across 483 files** were affected.

**It is invisible in source and in every static check.** The class is right there in the JSX; it
is only absent from the rendered DOM. Nothing catches it: not lint, not typecheck, not a test that
reads the source, not a diff audit that pairs old and new classes (they pair perfectly). The only
detector is reading `getComputedStyle` / `element.className` in a live browser, or grepping the
server HTML for the class and getting a count far below the number of call sites - it was **2**
occurrences of `text-phx-md` in the whole `/admin` document, against 94 nav links.

**FIXED 2026-08-28** on branch `codex/sidebar-restore-as-it-was` by registering the 11 names with
`extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: [...] }] } } })`. Proof:
`text-phx-md` in the server-rendered `/admin` HTML went **2 -> 112**, and 94 of 96 nav labels
measured 13px in the DOM. Colour merging still behaves (last colour wins, last size wins).

**Write the fix into `lib/utils.ts` at the REPO ROOT, not `src/lib/utils.ts`** - see
[[at-slash-lib-shadows-src-lib-via-tsconfig-paths]]; the src copy is shadowed and editing it does
nothing. Keep the name list in sync with the `--text-phx-*` keys in `app/globals.css`.
