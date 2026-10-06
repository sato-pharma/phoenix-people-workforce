---
name: run-tests-stops-at-the-first-throw-so-patch-it-to-continue
description: "`tests/run-tests.ts` rethrows on the first failing test, so one FAIL reports on a PREFIX of 2,200+ tests and each box run buys exactly ONE defect — copy it to `tests/_tmp-continue-runner.ts`, make its catch push the name instead of rethrowing, and run that WITHOUT an env file for the complete failure list in one local pass"
metadata:
  type: feedback
---

`runTest` in `tests/run-tests.ts` logs `FAIL <name>` and then `throw error`, so the process dies on
the first failing test. A red run therefore says nothing about the ~2,200 tests after it. Measured
2026-10-06 on the Production Planner branch: the first box run failed at the portal-route-skeleton
guard with **889 of 2,223 tests never reached**, and the next two runs each bought exactly one more
defect at about eight minutes a time — four separate round trips for four defects that were all
present from the first commit.

**The fix is a throwaway runner, not four more box runs.** `_tmp-*` is gitignored here, so:

```bash
python - <<'PY'
import io
s = io.open("tests/run-tests.ts", encoding="utf-8", newline="").read()
s = s.replace("""  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }""", """  } catch (error) {
    console.error(`FAIL ${name}`);
    failedNames.push(name);
  }""")
s = s.replace("const testDurationsMs: { name: string; durationMs: number }[] = [];",
  "const testDurationsMs: { name: string; durationMs: number }[] = [];\nconst failedNames: string[] = [];\nprocess.on(\"exit\", () => { console.log(\"TOTAL-FAILURES=\" + failedNames.length); for (const n of failedNames) console.log(\"FAILED :: \" + n.slice(0, 120)); });", 1)
io.open("tests/_tmp-continue-runner.ts", "w", encoding="utf-8", newline="").write(s)
PY
node --max-old-space-size=2048 --experimental-strip-types \
  --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
  tests/_tmp-continue-runner.ts > "$SCRATCH/all-local.txt" 2>&1
```

🔴 **Leave `--env-file-if-exists=.env.local` OFF.** `.env.local` points at PRODUCTION Supabase
([[the-test-suite-runs-with-production-credentials-and-app-env-production]]); without it the
DB-touching tests log `SUPABASE_SERVICE_ROLE_KEY is required` and pass exactly as they do on the CI
box, which has no key either. It ran in ~6 minutes with ~1.3 GB free RAM and was not reaped, because
it is a file-reading suite rather than a `tsc`. Read `TOTAL-FAILURES=` — **0 means the whole gate's
test half is green, and it is the only way to know that from here**, since a local
`pnpm run test` is the same first-throw runner.

A narrower version of the same trick: generate a driver importing the `run*` export of every
`tests/*.test.ts` that walks a directory (`readdirSync`), which is the class of guard a NEW MODULE
trips. Alias every import (`X as t12_0`) — two files export the same name and a bare import is a
`SyntaxError`, and a regex over `export (async )?function run\w+` also picks up names that are not
really exported, which is why copying `run-tests.ts` itself is the better route.

**What a new module tripped, none of which any module-level test could see:** no `loading.tsx` under
`app/employee-portals/<module>/` (an ABSOLUTE, not a ratchet); `default current_date` in its
migration (UTC = yesterday 00:00–03:00 Cairo); `he`/`his` inside an access-registry `reason`, which
is a string literal and so inside `neutral-wording`'s sweep of every non-comment line; and an
`ar-EG` check written as a line-wise `.filter(... !line.startsWith("*"))`, which
`comment-strip-ratchet` refuses — use `stripComments` from `tests/support/comment-strip.ts`.

Related: [[a-green-test-run-carries-no-type-signal-at-all]],
[[choosing-test-suites-by-grepping-your-symbols-misses-the-source-pinning-ones]].
