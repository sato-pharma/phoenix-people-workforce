---
name: the-turn-box-took-the-ghost-text
description: "THE GHOST TEXT IS BACK SINCE 2026-10-15 20:03 Cairo — he reinstalled app build 2.31226.1 from his own kept msix, and that build mounts NO turn box, so the app asks the CLI for a suggestion again and the quoted **Next step:** words reach his input box for Tab+Enter. THE RULE IS NOW CONDITIONAL: ship the words as a `wrap_up` reply button only in a session that HAS `mcp__ccd_turn__*`, and `next-step-capture.mjs` clause 7 warns about a missing button only there (its own tool list is the discriminator — 4 matches in a turn-box session, 0 in this build). Why the box was empty 13-15 Oct: app 44.7.0 mounted the turn box and dropped the suggestion request in the same breath — `zt && (Q.promptSuggestions = void 0)` — so the CLI returned on the FIRST line of its own gate. Also holds the causes that are NOT it: the five switches, usage below a hard `rejected`, the Agent-SDK turnOrigin skips (auto_continuation after a BLOCKED Stop hook, task_notification), and the CLI chain's nine rungs."
metadata:
  node_type: memory
  type: project
  originSessionId: 0e88bd89-241a-48ce-8073-3ee1d7f63569
  modified: 2026-10-15T17:12:19.851Z
---

Read out of `claude.exe` 2.1.293 on **2026-10-15** (`grep -aoE` over the 256 MB binary, the technique
in [[effort-multiplier-is-the-biggest-usage-lever]]), after the owner asked why the box was empty and
then ruled: *"never stop suggestions from appearing in the text box even if the usuage is 99.99%"*.

🔴 **LIVE STATE, 2026-10-15 20:03 CAIRO — HE PUT THE OLD BUILD BACK AND THE GHOST TEXT RETURNED WITH
IT.** `Get-AppxPackage` reads **`Claude_2.31226.1.0_x64__pzs8sxrjxfjjc`**, installed from his own
`C:UserssatohDownloadsClaude-2.31226.1Claude-2.31226.1.msix` (294 MB, written 19:59); the
install folder was created 20:03:07 and its `app.asar` 20:03:18. See
[[the-desktop-app-cannot-be-rolled-back-to-an-older-build]], whose title is kept but whose
description now carries the method that worked.

- **The proof it changed the surface is the session's own tool list**, not the version string: a
  transcript from the 44.7.0 build carries `"name":"mcp__ccd_turn__update_plan"` and `…__wrap_up`
  inside its `tools[]` attachment (4 matches, measured in that day's worktree session), and one from
  2.31226.1 carries **none** (0 matches). No turn box mounted → `zt` is false → the app never runs
  `Q.promptSuggestions = void 0` → the nine-rung CLI chain below runs again and the quoted words
  appear as ghost text.
- 🔴 **SO THE BUTTON RULE IS CONDITIONAL, AND SO IS THE HOOK.** `next-step-capture.mjs` **clause 7**
  now stands down unless the transcript shows a `mcp__ccd_turn__` tool, and it fails SILENT: on this
  build a warning would not have been captured, so the clause written to fill his box would have
  emptied it on every turn that edits a file. Proved by breaking it — 42 cases, the new case the only
  failure. The three live rule files (`task-rules.txt` rule 6, `suggestion-context.mjs`,
  `~/.claude/CLAUDE.md`) say "whichever surface this session has" since the same evening.

🔴 **ROOT CAUSE, 2026-10-15 (he reported "since this update the suggestions are not appearing … in
several sessions"): THE TURN BOX TOOK THE GHOST TEXT'S PLACE, AND THE APP ITSELF SWITCHES THE
SUGGESTION OFF.** Read out of `resources/app.asar` of `Claude_2.37337.1.0_x64` (app `version` =
**44.7.0**, asar written **13/10/2026 20:46 Cairo**), in the session-spawn path:

```js
let Ot = n.bu() && i.turnBox === true && re?.turnBox !== !1;        // turn box wanted
let { ..., turnBoxMounted: Rt } = await this.setupMcpAndPlugins(Q, r, d, { ..., turnBox: Ot, ... });
let zt = Rt, Bt = zt || !(A||b||H) && re?.turnBox === !0;
(zt || Bt && W) && (E += n.ao(G));     // append the turn-box system prompt
zt && (Q.promptSuggestions = void 0);  // <-- AND STOP ASKING FOR A SUGGESTION
```

`turnBoxMounted` is `_[n.Ou] !== void 0` — true whenever the `mcp__ccd_turn__*` pair is mounted,
which is every Code session now. The CLI (the app runs its own bundled **2.1.295**, not the global
2.1.293) then returns on the FIRST line of `DS.afterResult`:
`if (!this.promptSuggestions() || e.shouldQuery === !1 || this.shuttingDown() || a.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === !1) return`
— before `IS({paused, turnOrigin})`, before `cacheSafeParams()`, before any `tengu_prompt_suggestion`
event is emitted. **So nothing is suppressed and nothing is logged: it is never asked for.**

- 🔴 **NO LOCAL OFF-SWITCH.** `prompt_suggestions` (app), `promptSuggestionEnabled`, the `env` copy,
  the Windows user variable and the CLI flag were all ON while the box was empty. `n.bu()` reads a
  server-side GrowthBook gate (`fZ(id, true)` — default ON), `CLAUDE_DEV_FORCE_GATES` is ignored in a
  packaged build and only forces gates ON, and there is no `ccTurnBox` setting key. **Never tell him
  to reinstall or restart the app.**
- 🔴 **THE REPLACEMENT SURFACE IS THE `wrap_up` REPLY BUTTONS** — `actions[0].message` is sent
  verbatim as his next message, the click that replaced Tab+Enter. A turn that ends with a
  `Next step:` line must ALSO ship those exact words as a button; `next-step-capture.mjs` **clause 7**
  (added 2026-10-15, selftest 40 cases) warns when a turn kept a task list or edited a file and never
  called `wrap_up`, when the recap carried no actions, and when no action sends the line's words.
- **Measured:** the turn box first appears in a session started **14/10/2026 19:55 Cairo** and in all
  **39** sessions since — i.e. every session he has run since the update, which is exactly the
  "several sessions" he tested.

🔴 **EVERY SWITCH BEING ON PROVES NOTHING — the generation chain has NINE other ways to return early,
and each one is SILENT: no log line, no telemetry file, no transcript entry.** (Searched: no
`suggest*` field exists in any session JSONL; `atis-latch` is always `""`; the app's own `Logs/`
folder never mentions it.) **Measure the chain, do not re-measure the switches.**

⬇️ **EVERYTHING BELOW IS NOW DOWNSTREAM OF THE KILL SWITCH ABOVE — in an app session with the turn
box mounted it is dead code, and it was read out of 2.1.293 while the app runs 2.1.295. Keep it for a
TERMINAL session and for the day the turn box is not mounted.**

🔴 **THE DESKTOP APP DOES NOT USE THE CLI CHAIN BELOW — IT RUNS THE AGENT SDK, AND THE SDK GATE IS
`afterResult` -> `N_({paused, turnOrigin})`, WHICH HAS EXACTLY TWO SKIP REASONS** (read out of
`claude.exe` 2.1.293, 2026-10-15; this session had `CLAUDE_AGENT_SDK_VERSION=0.3.295`):

```
if (paused)                          -> "host_paused"
else if (sM.has(turnOrigin()))       -> "not_user_started"
else                                 -> null   (generate)
sM = new Set(["scheduled","task_notification","auto_continuation","host_synthetic","system"])
```

- 🔴 **`auto_continuation` IS WHAT A BLOCKED STOP HOOK PRODUCES, SO `next-step-capture.mjs` REFUSING A
  REPLY COSTS HIM THAT TURN'S SUGGESTION.** It fired twice on 2026-10-15 over a missing `Next step:`
  line, and each re-emitted turn was an auto-continuation — excluded by name. **Getting the opening
  line right in the FIRST emission is the one half of this a session controls.**
- ✅ **FIXED THE SAME DAY, at his instruction ("soften next-step-capture so it warns instead of
  blocking"): the hook now emits `{nextStepVerdict:"warn", reason, systemMessage}` and NEVER
  `{decision:"block"}`,** so the turn ends normally and keeps its suggestion while the model reads
  the verdict and fixes the line in its NEXT reply. A warned line is deliberately NOT captured — the
  status bar keeps its last good line rather than handing him a placeholder to send. Both halves are
  pinned by `node ~/.claude/hooks/next-step-capture.mjs selftest` (33 cases, 0 failed), including one
  case that goes red the moment `decision: 'block'` comes back. 🔴 **Never restore the block to "make
  the rule stick" — it spends the thing it is protecting.** The auto-mode classifier also refuses the
  edit as self-modification, so a session cannot quietly undo it.
- 🔴 **A TURN A SIDE SESSION'S `task_notification` STARTED IS EXCLUDED TOO**, as are a `scheduled` run
  and anything `system` or `host_synthetic`. So a box that is empty after a cron, a subagent report or
  a hook block is the product working as designed — never a switch, never usage.
- **`host_paused`** is the app's own `set_prompt_suggestions_paused`, which it sends "for a host whose
  composer is not on screen". Nothing a session can read or set; it clears when the app un-pauses.
- 🔴 **`CLAUDE_CODE_SESSION_KIND` IS UNSET IN A DESKTOP SESSION, SO `Nt()` IS FALSE** and the CLI
  focus branch, if it ran, would be the LENIENT one (`terminalFocus` starts `"unknown"`, and only a
  real `"blurred"` skips). Do not blame focus without reading that variable.

The CLI chain below still applies to a terminal session, and its size and rate-limit constants are
the same in both.

**The chain, in the order the binary runs it** — `DIo()` at turn end, then `nIr()`:

1. 🔴 **`unfocused` / `bg_unattached` — the session must be THE FOCUSED ONE at the moment its turn
   ends, or no suggestion is ever generated for that turn.** `if (o ? t !== "focused" && !s : t === "blurred") return`,
   where `t = w8()` is live `terminalFocus` (`"focused"` / `"blurred"`). **With ten sessions open this
   is the normal case, and NO setting overrides it** — it is a hard return. A reply that lands while he
   is reading another session has an empty box for ever; the next reply he watches has one.
2. 🔴 **`early_conversation` — fewer than TWO assistant messages means no suggestion, so a brand-new
   session's FIRST reply never has one.** `if (U(n, h => h.type === "assistant") < 2) return`.
3. `last_response_error` — the previous reply was an API error.
4. `elicitation_active` — an MCP elicitation is pending.
5. `plan_mode` — `toolPermissionContext.mode === "plan"` kills it outright.
6. 🔴 **`rate_limit` — and this is the one his standing rule is about.** The gate reads the
   `anthropic-ratelimit-unified-status` header, which has exactly three bands: **`allowed`**,
   **`allowed_warning`** (approaching the weekly limit) and **`rejected`** (reached).
   `let t = n === "allowed_warning" && a.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === true; if (n !== "allowed" && !t) return "rate_limit"`.
   **So the variable exempts `allowed_warning` and ONLY that band** — which is the proof of why both
   copies must stay, and the answer to "even at 99.99%": at 99.99% the header still reads
   `allowed_warning`, the variable covers it, and suggestions keep coming. They stop for usage only at
   a hard `rejected`, which no setting can override and where the turn itself would not run either.
   🔴 **Never report a percentage as the cause.** On 2026-10-15 weekly read **87%** with
   `extraUsage.enabled: false` and `cachedExtraUsageDisabledReason: "out_of_credits"`, and that was
   NOT the cause — rungs 1 and 2 were.
7. **`cache_cold` — the gate is `C = 1e4`**: `input_tokens + output_tokens > 10,000`, or that sum plus
   `cache_creation_input_tokens` over 10,000 unless the `tengu_chomp_thaw` flag is on. Measured across
   the ten live sessions on 10-15: **340-4,044 per turn**, so it was not firing. Hook injections are
   what push a turn toward it.
8. **`unused_streak` — `i = 20`, sentinel `u = 21`, and after the latch only ONE turn in `MBo = 10`
   generates.** `promptSuggestionUnusedStreak` lives in `.claude.json` and read **undefined (= 0)** on
   10-15, so it had never fired. The variable exempts this too (`n5n()` returns false when it is true),
   and accounts younger than `m = 14 days` are exempt. The notice is *"Showing fewer prompt suggestions
   · use one to bring them back"*, and using one, or toggling the config, resets it.
9. **`empty` and the `q()` text filter** — a generated suggestion that reads as `done`, `nothing
   found`, `nothing to suggest`, `no suggestion`, or matches `silence is` / `stay(s|ing) silent` is
   **thrown away and the box stays blank.** This is the mechanical half of his 2026-09-18 rule: a
   `Next step:` line that ends in a closing word produces no box at all.
10. `timing` / `aborted` — the suggestion arrived after the composer had moved on.

**Runtime control, not a cause:** `set_prompt_suggestions_paused` is an internal host command that
pauses a session's suggestions ("for a host whose composer is not on screen"). It only pauses; there is
nothing that forces generation.

🔴 **NOT the cause, do not spend the turn there** (measured 2026-10-02 and again 2026-10-15): the five
switches (app `prompt_suggestions`, `promptSuggestionEnabled`, the `env` copy, the Windows User
variable, the `tengu_prompt_suggestion` flag — all ON both days), the **status bar**, which is a
different feature he distinguishes himself (*"non this nor this"*), and the **Stop hook**, which writes
`~/.claude/.next-step/<sessionId>.txt` within a second of every reply, curly quotes intact.

**How to answer him:** name the rung, not the switches. On 2026-10-02 the live rung was the app's own
`prompt_suggestions` ("applies only from a session's next start or resume" — the lever is a fresh
session, HIS click, and it goes in the prose, never in the box:
[[never-put-his-physical-actions-in-the-next-step-box]]). On 2026-10-15 it was rungs 1 and 2. Never tell
him to reinstall, never restart the app, and never remove either copy of the variable to "reset" it —
an audit removed one on 2026-09-15 and he ordered it back.
