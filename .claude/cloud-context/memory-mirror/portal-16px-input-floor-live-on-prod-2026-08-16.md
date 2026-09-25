---
name: portal-16px-input-floor-live-on-prod-2026-08-16
description: "Portal-wide 16px mobile form-control floor in globals.css — LIVE prod 2026-08-16 (#2174), never remove; the \"very zoomed in\" report was iOS focus-zoom, not layout."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3059dd29-f9dd-415b-8ce4-95b1f9be0b4f
  modified: 2026-08-16T10:50:39.046Z
---

The field force's "the Direct Order screen is very zoomed in on mobile" (2026-08-16) was
**iOS Safari focus-zoom**, not a layout or viewport bug. Focus a control whose computed
font-size is under 16px and Safari zooms the page in and **never zooms back**. Android
Chrome does not do it, which is why it survived — invisible on the desk.

Fix LIVE on prod as `f4e68a89` (PR #2174), verified via `/api/healthz`. **Do NOT undo.**
`app/globals.css`, portal design-rules section, RULE 3:

```css
@media (max-width: 767px) {
  .employee-portal-shell input:not([type="checkbox"]):not([type="radio"]),
  .employee-portal-shell select, .employee-portal-shell textarea { font-size: max(16px, 1em); }
}
```

- **`max(16px, 1em)`, never a flat `16px`** — `em` on font-size resolves against the PARENT,
  so it is a floor that leaves a deliberately larger control alone. A flat value shrinks those.
- **Never "fix" this with `maximum-scale=1` / `user-scalable=no`** — that suppresses the
  symptom by removing pinch-zoom from a field force reading Arabic and English on a phone
  (WCAG 1.4.4). `tests/employee-portal-mobile-input-zoom.test.ts` bans it from `app/layout.tsx`.
- The rule selects on `.employee-portal-shell` (chrome root, `employee-portal-layout.tsx`).
  Renaming that class silently kills this and every other portal CSS rule.

**Scale it covered: 181 sub-16px controls in 74 component files, reached by 78 of 110
portal pages.** Fixed in CSS, not per component, because the trigger is the computed
font-size whatever class produced it.

The repo had diagnosed this ONCE before, on one control — decision-actions' reason box
(`text-base md:text-sm`) and the assertion in `direct-orders-approval-window-mobile.test.ts`
say exactly why — and never generalised it.

Audit of all 110 portal pages the same day found the layout otherwise broadly mobile-safe:
0 clipped min-widths, 0 fixed widths over 380px. `PortalDesktopTable` (hidden under 768px by
`[data-portal-desktop-table]` in enterprise-shell.tsx) is the shared primitive most tables
already use — see [[portal-mobile-audit-remaining-tables-2026-08-16]].
