---
name: set-state-in-effect-is-a-lint-error-here
description: "react-hooks/set-state-in-effect is an ERROR (not a warning) in this repo — any setState in an effect BODY fails the gate; put every setState inside the scheduled callback"
metadata: 
  node_type: memory
  type: reference
  originSessionId: a7d9767b-6023-40ee-aed7-29f5ee72470b
  modified: 2026-10-01T00:00:00.000Z
---

`react-hooks/set-state-in-effect` is configured as an **error**, so a `setState` called directly in
a `useEffect` body fails `pnpm run lint` and therefore **the required `lint` check on the PR**.
Cost me two full gate runs on 2026-08-04/05 (combo box, then the validation suggestions hook) — each
one a ~6-minute round trip for the same one-line mistake. *(Those runs were the local `check:harden`
gate, retired 2026-08-18; the round trip is now CI's, and lint runs inside the required `checks`
job — so the mistake still costs the same wait. Corrected 2026-10-01: this said `lint` was one of
four required checks; the gate is TWO, `validate` and `checks`, and `lint` has not been a check
name since #4527.)*

**The shape that passes** — every `setState` lives inside the scheduled callback, and the
"clear/reset" path becomes a 0 ms timeout rather than a bare call:

```ts
useEffect(() => {
  const term = value.trim();
  let cancelled = false;
  const timer = setTimeout(
    async () => {
      if (cancelled) return;
      if (term.length < 3) { setResults([]); return; }   // clear INSIDE the callback
      const data = await fetch(...);
      if (!cancelled) setResults(data);
    },
    term.length < 3 ? 0 : 250,                            // 0ms for the clear path
  );
  return () => { cancelled = true; clearTimeout(timer); };
}, [value]);
```

A `cancelled` flag (or a monotonic `seq` ref) is still needed so a stale response cannot overwrite
a newer keystroke's results — the lint rule does not give you that.

Typecheck does NOT catch this: `pnpm run check:edit` passes and only the lint step fails, so it
surfaces late, during the one expensive gate run. Related:
[[validate-once-at-done-not-per-edit]].
