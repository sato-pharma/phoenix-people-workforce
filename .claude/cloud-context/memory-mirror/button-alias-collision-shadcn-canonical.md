---
name: button-alias-collision-shadcn-canonical
description: "Root components/ui/button.tsx shadcn scaffold was the REAL live Button all along; dead custom Button deleted, shadcn version is now canonical at src/components/ui/button.tsx"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2be7eee9-6736-44b9-8df4-f4afaf9df571
---

Fixed 2026-07-02: a stray root-level `components/ui/button.tsx` (committed 2026-05-12 in
`93c1e880`, an accidental `shadcn` CLI scaffold run from repo root) collided with
`tsconfig.json`'s `"@/*": ["./*", "./src/*"]` alias order, so **every** `import {
Button } from "@/components/ui/button"` across 81 files resolved to the ROOT shadcn
file, not the intended `src/components/ui/button.tsx` custom design-system Button
built 2026-04-28.

Verified live (not just statically) by inspecting the running dev server DOM:
buttons had `data-slot="button"` / `data-variant="outline"` — markers only the
shadcn file sets. The custom Button (`primary|secondary|ghost|destructive` variants)
was **100% dead code**, never rendered anywhere, despite CLAUDE.md and
docs/editing-guide.md describing it as "the app's actual design system." Zero
files ever used `variant="primary"`; 15+ call sites across 6+ files explicitly used
`variant="outline"` or dynamic ternaries producing `"default"` — both shadcn-only
variants that don't exist on the custom Button's type.

**Resolution (owner-approved):** adopted the shadcn Button as canonical. Moved its
exact content into `src/components/ui/button.tsx` (replacing the dead custom file),
deleted the root `components/ui/button.tsx` + empty `components/` dir. Zero visual
change since production was already rendering the shadcn look. `npm run typecheck`
and `npm run build` both pass clean across the whole repo (all ~350 routes compiled).

**Why:** the button.tsx alias collision was a live landmine — any new component
writing `variant="primary"` (the "correct" API per old docs) would have silently
failed to compile, while `variant="outline"` (the actually-working API) looked wrong
per documentation. Docs (`docs/editing-guide.md`, CLAUDE.md's mention of
`src/components/ui/button.tsx`) are now stale on this point and should eventually be
updated to describe the shadcn variant set (`default|outline|secondary|ghost|destructive|link`)
as canonical, not primary/secondary/ghost/destructive.

**How to apply:** if a future task references "the custom Button design system" or
`primary` variant, verify against the current file first — it no longer exists.
`buttonVariants` export and shadcn's cva-based sizing (`xs|sm|default|lg|icon*`) are
now the real API. `src/components/ui/surface-context.ts` (`useDarkSurface`) is
unrelated and still in active use elsewhere (`src/components/admin/admin-design-system.tsx`) —
was NOT removed.
