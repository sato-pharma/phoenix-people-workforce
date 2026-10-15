---
name: prompt-suggestions-have-five-layers-and-four-are-not-it
description: "The suggestion gate is DECOMPILED. THE DESKTOP APP USES THE AGENT-SDK GATE, NOT THE CLI CHAIN: it skips on `host_paused` or on a turnOrigin in {scheduled, task_notification, auto_continuation, host_synthetic, system} — so a turn after a BLOCKED STOP HOOK (auto_continuation) or a side-session task_notification gets NO suggestion, by design — which is why next-step-capture.mjs WARNS and never blocks since 2026-10-15. USAGE NEVER STOPS THEM below a hard `rejected`, because CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION exempts the `allowed_warning` band. Also holds the CLI chain (unfocused, early_conversation, the 10,000-token gate, the 20-unused back-off) and the four things that are NOT the cause."
metadata:
  node_type: memory
  type: project
  originSessionId: 0e88bd89-241a-48ce-8073-3ee1d7f63569
  modified: 2026-10-15T13:23:53.891Z
---

Read out of `claude.exe` 2.1.293 on **2026-10-15** (`grep -aoE` over the 256 MB binary, the technique
in [[effort-multiplier-is-the-biggest-usage-lever]]), after the owner asked why the box was empty and
then ruled: *"never stop suggestions from appearing in the text box even if the usuage is 99.99%"*.

🔴 **EVERY SWITCH BEING ON PROVES NOTHING — the generation chain has NINE other ways to return early,
and each one is SILENT: no log line, no telemetry file, no transcript entry.** (Searched: no
`suggest*` field exists in any session JSONL; `atis-latch` is always `""`; the app's own `Logs/`
folder never mentions it.) **Measure the chain, do not re-measure the switches.**

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
