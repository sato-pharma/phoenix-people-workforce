---
name: match-module-design-before-building-ui
description: "Before building any new UI, inspect the sibling pages in that module and match their exact design identity — never one-off inline styling."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dc8abefb-23a3-48ba-b27f-cc4cfe6a9225
---

The user reacted strongly ("why the fuck did you build them with different design" / "nothing changed") about new Weekly Sales pages (Weekly Mapping, Weekly Missing Data). TWO root causes:

1. **Wrong route group = NO shell (the big one).** The pages were created under `app/sales/weekly/` instead of `app/(admin)/sales/weekly/`, so they rendered BARE — no sidebar, no top bar, no Phoenix chrome. ALL real pages live under `app/(admin)/` and inherit AppShell from `app/(admin)/layout.tsx`. Any new admin/sales/weekly page MUST go under `app/(admin)/...` (URL is identical — route groups are transparent; `@/` imports are unaffected). See [[admin-route-group-shell]]. Verify a new page renders the sidebar before claiming it's done.
2. **Bespoke styling instead of the module's look.**

**Why:** Phoenix has a consistent, locked visual identity per area; off-pattern pages read as broken/unfinished and are unacceptable.

**How to apply:** Before writing UI, read the canonical sibling page in the same module and copy its exact classes — don't invent. For the **Weekly Sales** module the reference is `src/components/sales/weekly/weekly-dashboard-view.tsx`:
- Page header = card with orange-dot kicker: `rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm`, kicker `text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]` + `<span class="h-2 w-2 rounded-full bg-[#F97316]" />`.
- Cards/panels: `rounded-[6px] border border-[#E2E8F0] bg-white p-4 shadow-sm` (6px corners, NOT square here, NOT rounded-xl).
- Tables: `<section class="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">` → PanelTitle bar (`border-b bg-[#F8FAFC] px-3 py-2` + count badge) → `<thead class="bg-[#020617] text-left text-[10px] font-black uppercase text-white">` → rows `border-t border-[#F1F5F9] transition hover:bg-[#FFF7ED]`.
- Inputs/buttons: `rounded-[6px] ... shadow-sm`, focus `border-[#FDBA74]`, primary button `bg-[#F97316] hover:bg-[#EA6A0C]`.

Palette: slate `#0F172A`/`#334155`/`#64748B`/`#94A3B8`, borders `#E2E8F0`/`#F1F5F9`, orange `#F97316`, near-black table header `#020617`. Shared primitives exist in `src/components/ui/` (Card uses rounded-xl — that's the non-weekly premium surface; the weekly module hand-rolls rounded-[6px]). See also [[admin-shell-design-rules]] and [[premium-design-language]].
