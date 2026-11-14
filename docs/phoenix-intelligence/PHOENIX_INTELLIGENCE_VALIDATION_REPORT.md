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
| The five new test suites | the five `runPhoenixInspect*Tests` (registered in `tests/run-tests.ts`) | **5 of 5 passed** (route inventory 1,140 ms; fence, redaction, safety and MCP under 60 ms each) | fence, masking, click classifier, origin allowlist, MCP input checks, route inventory = navigation code |
| MCP server over a real stdio client | `node scripts/phoenix-inspect/mcp-smoke.mjs` | **14 of 14 checks passed** | the eight tools list, answer and refuse: unknown tool, unknown persona, a URL in place of an id |
| The KPIs state plan | `node scripts/phoenix-inspect/explore.mjs --plan --module kpi-reports` | **122 jobs, 0 truncated**: CEO 21 + 17 + 21 and DM 19 + 15 + 19 at desktop, tablet and mobile; SFE, HR Resourcing, NSM, rep and Employee 2 each | the matrix is bounded and complete as specified |
| Repo contract gates | `node scripts/check-contracts.mjs` | **27 gates passed, 2 tool gates clean**, `changed-files-lint` over 22 files, `unknown-flag-gates-source` PASS | no repo rule broken by the new files |
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

## 3. Browser checks, run on the spare laptop against staging

| Run | When (Cairo) | Result | Files here? |
| --- | --- | --- | --- |
| `self-check.mjs`, run `20261114-190625` | 19:06 | **31 of 31 checks passed**: navigation failure, full-page and scroller shots, the three viewports, masking, leak deletion, and "the server received no request other than GET" | yes: the fixture shots in `artifacts/phoenix-inspection/self-check/shots/` (a synthetic page, not Phoenix) |
| KPIs smoke run `20261114-191254` (CEO summary at desktop, Employee denied) | 19:12–19:13 | CEO `sign-in: ok`, summary captured; Employee `sign-in: ok`, `denied-as-expected`; **writes stopped: 2**; **privacy deletions: 0** | **no**: the copy-back dropped (`scp.exe: Connection closed`). The files are still on the spare; `on-spare.ps1 fetch 20261114-191254` brings them back |
| KPIs full run (122 pages) | — | **not run**: see section 5 | — |

**What staging recorded.** The only rows the seven inspection logins ever wrote to staging's
`audit_logs`, read at 19:57, are:

| Login | Entry | Time (Cairo) |
| --- | --- | --- |
| `INSPECT-CEO` | Login succeeded | 19:13:10 |
| `TEST-INSPECT-EMP` | Login succeeded | 19:13:32 |

These are the one POST the fence allows: the sign-in itself. No other row was written. The seven logins
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

1. **The full 122-page KPIs run did not happen.** The spare laptop stopped accepting SSH sessions at about
   19:15. It first authenticated and then reset the session; later attempts timed out.
   The address finder named it again at 19:57, but SSH still timed out. Every browser run happens on
   the spare by design: this laptop starts no browser. Because of that:
   - the audit's section 5 (overflow, computed radius, ellipsis, computed contrast, tap targets,
     console, network on real data) is **unmeasured**;
   - the component map's section 7 (screens to files, from the run) is **unfilled**;
   - **no KPIs screenshot is in the delivery.** Only the synthetic self-check fixture shots are, and
     they are labelled as such.
2. **The desktop-tables, phone-cards rule (R10) has no dedicated test** (source dependency map §8). The
   full run's 390 px shots are the check, and they are pending.
3. **Super Admin's own view** is not inspected: its sign-in asks for an authenticator code, and the
   explorer does not bypass account security. The CEO's view has the same company-wide reach.
4. **Nothing is reachable from ChatGPT**, and ChatGPT Desktop's use of a custom plugin on Windows is not
   verified ([readiness](CHATGPT_MCP_CONNECTION_READINESS.md)).
5. **Thirteen unknowns** remain in the source dependency map (§8). Each one is marked there and none
   carries a finding.

## 6. What finishing it takes

When the spare answers again:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phoenix-inspect/on-spare.ps1 fetch 20261114-191254
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phoenix-inspect/on-spare.ps1 explore --module kpi-reports --no-prune
```

Then fill the audit's section 5 and the component map's section 7 from the run's `manifest.json`, and
add the shots to the delivery's screenshot index. Any measurement over its limit becomes a P0 row in
the plan.
