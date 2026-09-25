---
name: react-hooks-refs-lint-rule-during-render
description: "This repo's ESLint (react-hooks/refs) errors on any .current read/write that executes synchronously during render — even inside a helper function called from JSX"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eb2b3b7b-8795-4ebe-84cf-604557d06837
  modified: 2026-07-24T06:06:53.517Z
---

This repo's `eslint-plugin-react-hooks` config enforces `react-hooks/refs`: "Cannot
access refs during render." It fires not just on obvious `ref.current` reads in the
component body, but on any HELPER FUNCTION that is itself CALLED during render and
internally touches `.current` — e.g. a memoization-cache pattern like
`function getHandler(key) { if (!cache.current[key]) cache.current[key] = fn; return
cache.current[key]; }` called inline as `onClick={getHandler(key)}` fails, because
`getHandler`'s body executes synchronously as part of render.

**Why:** hit while building [[sos-bulk-import-module-build]] — needed one stable
callback identity per dynamically-touched distributor code (to feed a child's
`useEffect` deps array without an infinite render loop) plus a persistent store of
`forwardRef` imperative handles to call later from an event handler. The natural
"lazily cache in a ref" pattern for both failed lint.

**How to apply:**
- For a **stable per-key callback** whose identity must not change on every parent
  re-render (e.g. feeding a child's `useEffect` deps): build it with `useMemo` keyed on
  the actual state array that grows/shrinks the key set (e.g. `useMemo(() => { const
  map = {}; for (const k of items) map[k] = (v) => setState(p => ({...p, [k]: v})); return
  map; }, [items])`), NOT a ref-of-functions read during render. `useMemo` recomputes
  only when `items`'s reference changes (i.e., when a key is actually added/removed),
  which is exactly the stability window needed — and it's not a ref, so the rule
  doesn't apply.
- For a **persistent mutable store only read in event handlers** (e.g. a map of
  `forwardRef` handles read later from a "Confirm All" click): keep the `useRef` store,
  but write to it via an INLINE closure passed directly as the `ref` prop —
  `ref={(h) => { store.current[key] = h; }}` — never via a helper function that itself
  reads `store.current` synchronously while being called during render. A fresh inline
  closure each render is fine for a ref-callback prop (React invokes it at commit time,
  not during the render call stack), even though the closure lexically mentions
  `.current` — the rule only flags `.current` access that actually executes as part of
  the render function call, not access deferred into a later-invoked callback.
