# Recruitment CV re-read batch — 2026-08-16

Four one-off, hand-run scripts from the 16 Aug 2026 candidate-data repair. **They have already been
run against production.** Nothing here is wired to a route, a cron, or `package.json` — they exist
so the next person can see exactly what was done to live candidate records, and re-run the logic if
the same problem recurs.

They were rescued into the repository on 2026-08-18 because they lived only in an untracked folder
inside a worktree whose PR had already merged, so a routine `git worktree remove` would have
destroyed them.

## Run order

| # | Script | What it did |
| --- | --- | --- |
| 1 | `recruitment-split-forwarded-candidates.ts` | Split forwarded CVs into their own candidate records. Works off a hardcoded allowlist of file/holder pairs, each re-asserted against its holder before anything moves, so a re-run or stray edit cannot split unrelated attachments. Clears the applicant's phone off the forwarding colleague first — `phone_norm` has a partial UNIQUE index with no trigger behind it, so creating the applicant with her own number is rejected outright while the colleague still holds it. |
| 2 | `recruitment-fix-candidate-names.ts` | Renamed candidates after the person on the CV rather than the person who emailed it. |
| 3 | `recruitment-reread-never-read-cvs.ts` | Re-read the CVs the AI had never read. Needs `OPENAI_API_KEY`; writes its report to `CV_REREAD_OUT_DIR`. |
| 4 | `recruitment-apply-reread-fields.ts` | Applied the high-confidence fields from that re-read onto the candidates. |

Scripts 1, 2 and 4 need `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
environment. They read no credential from any file in this repository.

## Where the run reports live

The four JSON artefacts these produced — `cv-apply-plan.json`, `cv-reread-report.json`,
`forwarded-split-report.json`, `name-fix-plan.json` — are **deliberately not in git.** They are the
per-candidate record of what changed, and they carry real names, mobile numbers, LinkedIn URLs and
job titles. Committing them would put that personal data in the repository history permanently.

They are archived verbatim outside the repository at:

```
F:\Phoenix Workforce\ops-archive\recruitment-cv-reread-20260816\
```

That folder also holds the unredacted original of every script below.

## What was redacted here

Two comments in the git copies had real mobile numbers in them, quoted as examples. The digits are
masked; the explanation around them is unchanged. The unredacted originals are in the archive above.

Candidate **names** remain in `recruitment-split-forwarded-candidates.ts` — they are the `expectName`
guard in the `SPLITS` allowlist, which is what stops the script re-splitting the wrong attachment.
Stripping them would leave a script that cannot safely run.

## Still open

The 22-digit phone problem this batch uncovered — two or three numbers run together in one column —
was worked around in script 4 by refusing to write a value that is not a plausible phone number. The
underlying `selectAutoApplyFields` rule still gates only on confidence and blankness, and has no idea
what a phone number looks like.
