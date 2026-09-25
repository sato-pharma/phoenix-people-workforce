---
name: a-test-can-never-hand-a-function-a-process-env-literal
description: "A function taking an env bag so a test can inject one CANNOT be typed in this app — Next declares NODE_ENV as required on NodeJS.ProcessEnv, and the narrow stand-in hits the weak-type rule from the other side. Take the value, not the bag."
metadata: 
  node_type: memory
  type: project
  originSessionId: bc64a6e6-925a-4aa2-970d-6dfa931aa34f
  modified: 2026-08-26T20:45:56.676Z
---

`node_modules/next/types/global.d.ts:21` augments **`NodeJS.ProcessEnv` with a required, readonly
`NODE_ENV`**. That is Next's declaration, not this repo's — nothing in `src/` or a `.d.ts` here
touches `ProcessEnv`, so grepping the repo for the cause finds nothing and looks like a mystery.

Both obvious ways to write "an env object, defaulted from `process.env`, that a test can substitute"
therefore fail `typecheck`, and each error only appears after you have fixed the other:

| Parameter type | What breaks |
| --- | --- |
| `env: NodeJS.ProcessEnv = process.env` | **TS2345** at every call site — the test's literal is missing the required `NODE_ENV`. |
| `env: { MY_VAR?: string } = process.env` | **TS2559** at the default — the target is all-optional (a *weak type*), and `ProcessEnv`'s only named member is `NODE_ENV`, so "no properties in common". |

`src/lib/sales/master-map/sheets-client.ts:82` does use `env: NodeJS.ProcessEnv = process.env` and
compiles — because nothing ever passes it a literal. That precedent does **not** transfer the moment
a test wants to inject one.

**Why:** each attempt costs a full red CI round (~16 Actions minutes on an account that has hit the
spending cap), and the local suite cannot see either — `--experimental-strip-types` never
typechecks, so a green run says nothing. See [[a-green-test-run-carries-no-type-signal-at-all]].

**How to apply:** do not take an env bag as a parameter at all. **Take the values the function
actually reads**, defaulted at the signature — `configuredPath: string = process.env.MY_VAR ?? ""`.
The test then passes a string, no env type is involved, and the parameter stops lying about how many
variables the function reads. Done this way in `resolveChromiumPath` (`src/lib/offers/pdf.ts`), PR
#2432. If a function genuinely reads many variables, pass a `Record<string, string | undefined>` and
read it with bracket access, matching `src/lib/env.ts:6` and `src/lib/crm/config.ts:20`.

Before pushing a fix for an error of this class, run one cold `node ./node_modules/typescript/bin/tsc
--noEmit --pretty false --incremental false` (~2 min, exit 0 = silent). That is not the banned
pre-push validation ritual — it is the "you genuinely need the answer before pushing" case AGENTS.md
§7 carves out, and it is what broke a three-round streak of consecutive red typechecks.
