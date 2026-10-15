---
name: prompt-suggestions-have-five-layers-and-four-are-not-it
description: "The suggestion gate is DECOMPILED, so it is never guessed again: Claude Code 2.1.293's chain is unfocused -> early_conversation (<2 assistant turns) -> last_response_error -> elicitation_active -> plan_mode -> rate_limit -> cache_cold (10,000 tokens) -> unused_streak (20) -> empty. USAGE DOES NOT STOP THEM BELOW A HARD `rejected`, because CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION exempts the `allowed_warning` band - that is why both copies of the variable must stay. The two that actually bite here are UNFOCUSED and EARLY_CONVERSATION, and neither has a setting."
metadata:
  node_type: memory
  type: project
  originSessionId: 0e88bd89-241a-48ce-8073-3ee1d7f63569
  modified: 2026-10-15T12:40:00.000Z
---

Read out of `claude.exe` 2.1.293 on **2026-10-15** (`grep -aoE` over the 256 MB binary, the technique
in [[effort-multiplier-is-the-biggest-usage-lever]]), after the owner asked why the box was empty and
then ruled: *"never stop suggestions from appearing in the text box even if the usuage is 99.99%"*.

🔴 **EVERY SWITCH BEING ON PROVES NOTHING — the generation chain has NINE other ways to return early,
and each one is SILENT: no log line, no telemetry file, no transcript entry.** (Searched: no
`suggest*` field exists in any session JSONL; `atis-latch` is always `""`; the app's own `Logs/`
folder never mentions it.) **Measure the chain, do not re-measure the switches.**

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
