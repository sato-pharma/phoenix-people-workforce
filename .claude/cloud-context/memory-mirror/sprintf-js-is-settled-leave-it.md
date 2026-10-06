---
name: sprintf-js-is-settled-leave-it
description: SETTLED 2026-10-06 by the owner — "leave sprintf-js as it is, it never loads". Never re-raise it, never propose the argparse@2 override, never offer it as a Next step; it is a runtime-scope alert with no patch at any version, and it is measured never to be required.
metadata:
  type: project
---

Asked directly on 2026-10-06 and he answered **"leave sprintf-js as it is — it never loads"**. That
is a recorded risk acceptance. **Do not re-raise it, do not propose the override, and do not put it
in a `Next step:` line** — the question is closed.

The facts behind it, all measured that day, so a future session does not re-derive them:

- Alert **#116**, GHSA-hp3w-g68c-fv3c, **MEDIUM** (CVSS 5.3), `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`
  — availability only, and LOW. It cannot fail `pnpm audit --audit-level=high --prod`.
- Scope is **`runtime`**, so it IS in the production graph — scope is not what makes it quiet.
- **No patched version at any release:** every published version, 0.0.7 through 1.1.3, is inside the
  advisory's `<= 1.1.3`.
- **It is never loaded, and that is measured.** `argparse` is referenced in exactly one file of the
  installed `mammoth` package — `node_modules/mammoth/bin/mammoth`, the command-line tool — plus its
  `package.json`. A require-graph walk from the library entry `mammoth/lib/index.js` visits **78
  files and never reaches `argparse`**. Phoenix only calls `mammoth.extractRawText`
  (`src/lib/recruitment/cv-extraction.ts`) and nothing here runs that binary.
- The removal route exists and was rejected: chain is `mammoth → argparse@1.0.10 → sprintf-js`, and
  `argparse@2` has no dependencies at all, so a `pnpm.overrides` entry would delete the chain — at
  the risk of breaking the .docx reader behind CV extraction. **He chose not to take that risk.**
- What would reopen it: the scope changing, a patched version appearing, or something in this repo
  starting to run the `mammoth` binary or call `sprintf` directly.

The row carrying this is `docs/security/open-dependency-alerts.md`, under
`### sprintf-js`. 🔴 **The checker recognises a decision ONLY on the word `Accepted` in the
`**Decision**` cell** keyed to exactly one `#116` — so if a session ever reports this as still
needing a decision, that cell has been edited, not that he never decided.

Related: [[a-failed-dependabot-run-withholds-the-production-deploy]]
