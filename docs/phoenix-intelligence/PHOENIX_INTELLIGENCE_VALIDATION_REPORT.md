# Phoenix Intelligence — validation report

Read on 14 Nov 2026, Cairo time. This report covers every check that was run for this branch
(`codex/visual-intelligence`). Each line gives the command, the number it printed, and what that
number proves. Anything that was not run is listed in section 5 with the reason. Nothing in this
report is taken from a screenshot that does not exist.

## 1. Which code was checked

| | Revision |
| --- | --- |
| Branch base (`origin/main` when cut, 18:26) | `950851277` |
| `origin/main` and staging `/api/healthz`, read 19:34 | `6df640b10` |
| KPIs board files changed between the two | **none**: `git diff --name-only 950851277 6df640b10` over the KPIs, CRM, shell, token and navigation paths is empty ([verification §1](PHOENIX_IMPLEMENTATION_VERIFICATION.md)) |

## 2. Automated checks run on this laptop (none starts a browser)

| Check | Command | Result | What it proves |
| --- | --- | --- | --- |
| The eight inspector test suites (re-run 21:58 on `34c116286`) | the eight `runPhoenixInspect*Tests` (registered in `tests/run-tests.ts`) | **8 of 8 passed** (route inventory 1,018 ms, route fence 826 ms, MCP door 772 ms; the other five under 50 ms) | fence, masking, click classifier, origin allowlist, MCP input checks, route inventory = navigation code, every address that acts when read is refused, computed-colour reading, the remote door's token checks, and recorded errors carry no address or id |
| CI on the PR (`36280d6dd`) | `validate`, `checks` | lint, typecheck and the test suite **passed**; the build is skipped on a PR by design | the branch compiles and the whole suite is green |
| MCP server over a real stdio client | `node scripts/phoenix-inspect/mcp-smoke.mjs` | **14 of 14 checks passed** | the eight tools list, answer and refuse: unknown tool, unknown persona, a URL in place of an id |
| The KPIs state plan | `node scripts/phoenix-inspect/explore.mjs --plan --module kpi-reports` | **122 jobs, 0 truncated**: CEO 21 + 17 + 21 and DM 19 + 15 + 19 at desktop, tablet and mobile; SFE, HR Resourcing, NSM, rep and Employee 2 each | the matrix is bounded and complete as specified |
| Repo contract gates | `node scripts/check-contracts.mjs` | **27 gates passed, 2 tool gates clean**, `changed-files-lint` over 29 files, `unknown-flag-gates-source` PASS, recorded for `34c116286` | no repo rule broken by the new files |
| Argument gates | each of the six new entry scripts run with `--zzz-bogus` | **exit 2, refused, no body run** (six of six) | a mistyped flag can never turn a read into a write (`tests/unknown-flag-gates.test.ts`, `tests/generator-arg-gates.test.ts`) |

**Break tests.** These are the new assertions that were proved by breaking the code they guard, then
restoring it:
- the two `structuredContent` assertions in `tests/phoenix-inspect-mcp.test.ts` each failed when the
  field was removed, and passed again when it was restored;
- the six argument gates printed `GATE-OK` and `GATE-REFUSES` under the gate probe, and
  `route-inventory.json` was not rewritten.

**Not run here, on purpose:**
- **Typecheck.** It is denied on this laptop; the PR's own CI (`validate`, `checks`) is the verdict.
- **The full test suite.** It runs in CI.

## 3. Browser checks against staging

The first two ran on the spare laptop. After you said not to depend on the spare (about 20:10), the
browser ran on this laptop under a memory guard: a pass stops when free memory falls under its floor.

| Run | When (Cairo) | Result | Files here? |
| --- | --- | --- | --- |
| `self-check.mjs`, run `20261114-190625` (spare) | 19:06 | 31 of 31 checks passed | yes: the fixture shots in `artifacts/phoenix-inspection/self-check/shots/` (a synthetic page, not Phoenix) |
| `self-check.mjs`, this laptop, after the visible-link and error-text fixes | after 21:47 | **34 of 34 checks passed**, lowest free memory 2,451 MB. With the visible-link fix taken out it scored **33 of 34**, failing on the same 30 s click timeout as the real run | yes, as above |
| KPIs smoke run `20261114-191254` (spare; CEO summary at desktop, Employee denied) | 19:12–19:13 | CEO `sign-in: ok`, summary captured; Employee `denied-as-expected`; writes stopped: 2; privacy deletions: 0 | **no**: the copy-back dropped; its files are still on the spare |
| **KPIs full run `20261114-205500-kpi`** (this laptop; 122 pages planned) | 20:59–21:47 | **52 captured, 3 errors, 67 not reached**: all 52 are the CEO's admin board. **0** privacy deletions, **55** writes stopped, **0** console errors, **0** failed requests, **0** overflow / radius / ellipsis. Measurements: [audit §5](KPI_REPORTS_VISUAL_AUDIT.md) | yes: masked shots and `manifest.json` in the delivery |

**Eye check.** Five masked shots were looked at one by one: 007, 009, 021, 043 and 053. Every name reads
as x's and every figure as 0's. The board's own words are kept, and the layout keeps its shape. One
defect came from this look: the search hint is cut off on a phone (audit UX-01).

**What staging recorded.** Every row the inspection logins wrote to staging's `audit_logs` since 18:00,
read at about 22:00:

| Login | Entry | Count | First – last (Cairo) |
| --- | --- | --- | --- |
| `INSPECT-CEO` | Login succeeded | 13 | 19:13 – 21:44 |
| `TEST-INSPECT-EMP` | Login succeeded | 1 | 19:13 |

These are the one POST the fence allows: the sign-in itself, once for the smoke run and once per pass of
the full run. No other row was written. The seven logins
are on staging (`cifwmndunmlxjhyjugxa`), all active, all with bcrypt hashes, none set to force a
password reset. The four `TEST-` ones are marked as test accounts. **None exists in production.**

## 4. Reviews

| Reviewer | Verdict | What changed because of it |
| --- | --- | --- |
| UI rules review (the fits-the-screen, square-edge, no-ellipsis and form-design rules) | 1 blocker | O-01 / D-03 now leave the 8 `text-base` filter controls alone. They are the 16 px floor that stops iOS zooming on focus, pinned by `SIXTEEN_PX_KEEPS`. Also added: `leading-5`, "row heights unchanged", and never `text-phx-xs` |
| CRM rules review (KPIs, AM · PM, marker words, scope) | clear, 3 should-fix | V-01 acceptance: the computed ground (including the orange-50 chips), the active tab, and "No plan" / "Just started" staying distinct. The test list is named in the plan and the prompt. Each role's scope is in component map §1 |
| Universal inspection roadmap (reuse audit) | 1 correction | The test accounts' server-side dry run skips GET. The fence comment and `INSPECTION_PERSONAS.md` said otherwise, and both now say so. The KPIs board has no page that writes on GET |
| Delivery privacy scan (`build-delivery.mjs`) | 2 files flagged | The masking tests' made-up person looked real (a name, an HR-id-shaped code, a company-domain address). It was replaced with values that cannot be anyone, at the same lengths. The 5 suites pass 5 of 5 again; the self-check was **not** re-run after this, because it needs the spare. Its masked shapes are unchanged by construction |
| Source dependency map (80 elements, line-level) | 7 corrections | `kpis-chrome.tsx` is **not** KPIs only: `KpiSection` and `KpiTile` also draw Team Visits, Weekly Sheet and District Manager Plans. The plan's blast radius and order of work now say so. The other six are in the component map's footnote |

## 5. Not validated, and why

1. **70 of the 122 KPIs pages were not measured** (audit §5.4):
   - **3 CEO drill-downs ended in a click timeout.** The explorer clicked the first rep link, which at
     desktop and tablet is the hidden phone-card copy. Fixed in `34c116286`; not re-run.
   - **67 pages were never reached**, because of this laptop's memory: 4 CEO pages, all **53 District
     Manager portal pages**, and the 10 landing pages of the SFE Manager, HR Resourcing, NSM, rep and
     Employee personas. The explorer pauses itself under 2,300 MB free; an outer guard stops a pass
     (node and its Chromium, nothing else) under its floor. That guard stopped passes at 1,895, 1,862 and
     1,721 MB free with its floor at 1,900 MB, then at 2,147 and 2,134 MB after the floor was raised to
     2,150 MB. The loop ended at 21:47 after two passes with no new
     page. The spare laptop was still off: the address finder exited 1 and SSH timed out.
   - So the **portal side of the board is unmeasured**, and so are the **Employee denied path** in this
     run (it passed in the 19:12 smoke run) and the **loading and error mocks**.
   - The component map's section 7 (screens to files, from the run) is filled for the CEO's 20 states only.
2. **The desktop-tables, phone-cards rule (R10) has no dedicated test** (source dependency map §8). The
   CEO's 390 px shots show cards and stacked tiles, and its 1440 px shots show the table (seen on 007 and
   009). The portal's shots are missing.
3. **Super Admin's own view** is not inspected: its sign-in asks for an authenticator code, and the
   explorer does not bypass account security. The CEO's view has the same company-wide reach.
4. **Nothing is reachable from ChatGPT**, and ChatGPT Desktop's use of a custom plugin on Windows is not
   verified ([readiness](CHATGPT_MCP_CONNECTION_READINESS.md)).
5. **Thirteen unknowns** remain in the source dependency map (§8). Each one is marked there and none
   carries a finding.

## 6. What finishing it takes

The 70 missing pages need a browser with memory to spare: the spare laptop when it is back on, or this
laptop when fewer sessions are open. `--resume` keeps the run's manifest, skips every page it already
captured and tries the 3 errored drill-downs again, so the next pass takes only what is missing:

```text
node scripts/phoenix-inspect/explore.mjs --module kpi-reports --run-id 20261114-205500-kpi --resume --no-prune --max-minutes 45 --min-free-mb 2300 --relaunch-every 3
```

Then add the District Manager's states to the audit's section 5 and the component map's section 7.
Any measurement over its limit becomes a P0 row in the plan.
