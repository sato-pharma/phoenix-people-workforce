---
name: a-dotall-regex-flag-is-refused-by-the-es2017-target
description: "`/…/s` (dotAll) in any repo file fails the required `checks` job with `error TS1501: This regular expression flag is only available when targeting 'es2018' or later` — `tsconfig.json` says `\"target\": \"ES2017\"`; use `[\s\S]` or a character class that already crosses newlines, and never raise the target to silence it."
metadata:
  node_type: memory
  type: project
---

`tsconfig.json` line 3 is `"target": "ES2017"`, so the `s` (dotAll) regex flag is a **compile error**,
not a lint warning: `error TS1501: This regular expression flag is only available when targeting
'es2018' or later`. It reddens the required `checks` job in about 80 seconds — the fastest red in the
gate, and the one a session cannot see coming locally, because **a local typecheck is denied
mechanically** (`bash-guard.mjs` C8) and a green unit run carries no type signal at all
([[a-green-test-run-carries-no-type-signal-at-all]]).

Caught on 2026-10-09, PR 5700: `/export type IntegritySource =[^;]*"signboard"/s`. The flag was
decorative — `[^;]*` already crosses newlines — so dropping it left the assertion identical, which is
the usual case: write the character class that spans lines (`[\s\S]`, `[^;]`, `[^}]`) and the flag is
never needed. **Do not raise the target**: ES2017 is what the Next build and the editor's TypeScript 5
share, and the gate compiles with TypeScript 7 via the `typescript-native` alias.
