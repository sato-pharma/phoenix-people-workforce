---
name: recruitment-cv-reread-run-reports-live-outside-git
description: "The 2026-08-16 CV re-read scripts are in scripts/, but their per-candidate run reports are deliberately outside git at F:\\Phoenix Workforce\\ops-archive\\recruitment-cv-reread-20260816\\"
metadata: 
  node_type: memory
  type: project
  originSessionId: 37375444-88fb-4740-977c-a056555ade15
  modified: 2026-08-18T14:55:58.674Z
---

The four one-off scripts from the 2026-08-16 candidate-data repair were rescued into `scripts/` on
2026-08-18 (PR #2192) out of `_wt-recruit-simplify`, where they existed only as untracked files.
`scripts/README-recruitment-cv-reread-2026-08-16.md` is the map.

**Their four JSON run reports are NOT in git and never should be** — `cv-apply-plan.json`,
`cv-reread-report.json`, `forwarded-split-report.json`, `name-fix-plan.json` are per-candidate and
carry real names, mobile numbers, LinkedIn URLs and job titles. They live, with the unredacted
originals of all four scripts, at:

```
F:\Phoenix Workforce\ops-archive\recruitment-cv-reread-20260816\
```

Two comments in the committed copies had real applicant mobile numbers masked out. The candidate
**names** in the `SPLITS` allowlist of `recruitment-split-forwarded-candidates.ts` are load-bearing —
they are the `expectName` guard each split is re-asserted against, so they cannot be redacted.

**Why:** if you go looking for what those scripts actually did to which candidate, git will not tell
you — only the archive will. And a future "let's commit the reports too for completeness" would put
applicant personal data in the repository history permanently.

**How to apply:** read the archive, not git, for per-candidate detail. Never commit `.cv-reread/`.
Related: [[candidate-name-fix-and-field-apply-prod-2026-08-16]],
[[forwarded-cv-split-applied-to-prod-2026-08-16]],
[[candidate-phone-backfill-and-the-two-traps-2026-08-16]].
