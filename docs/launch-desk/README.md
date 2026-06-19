# Launch Desk

Launch Desk is a Next.js frontend plus OpenAI Agents SDK workflow for turning a rough launch idea into an actionable release plan.

## What It Builds

- Prioritized release plan
- Risk register
- Owner-specific checklist
- Channel-specific launch copy
- Follow-up questions when key details are missing

## Project Structure

- `app/launch-desk/page.tsx` - frontend route.
- `src/components/launch-desk/launch-desk-client.tsx` - client UI and SSE stream reader.
- `app/api/launch-desk/plan/route.ts` - server-side streamed agent API route.
- `src/lib/launch-desk/agent.ts` - Agents SDK agent, model, runner, and tracing setup.
- `src/lib/launch-desk/tools.ts` - deterministic Launch Desk tool logic and SDK tool wrappers.
- `src/lib/launch-desk/types.ts` - request schema and shared types.
- `tests/launch-desk-tools.test.ts` - deterministic tool coverage.
- `scripts/verify-launch-desk-stream.mjs` - real local streamed API verification.

## Local Setup

Add an OpenAI API key to `.env.local`:

```bash
OPENAI_API_KEY=<your server-only OpenAI API key>
```

Optional settings:

```bash
# Default is gpt-5.4-mini for latency and cost. Use gpt-5.5 for flagship reasoning.
LAUNCH_DESK_MODEL=gpt-5.4-mini

# Required only for deployed production/preview runtimes.
LAUNCH_DESK_ENABLED=true

# Default traces are enabled with sensitive data excluded.
LAUNCH_DESK_TRACING_DISABLED=false
```

Run the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000/launch-desk
```

## Real Stream Verification

With the dev server running and `OPENAI_API_KEY` available to that server process:

```bash
npm run launch-desk:verify
```

The script posts to `/api/launch-desk/plan` and fails unless it receives both:

- at least one `tool_progress` event
- at least one `text_delta` event

This is intentionally stronger than checking `/api/health`, Vite/Next startup, TypeScript, or unit tests.

## OpenAI SDK Notes

Launch Desk uses the current OpenAI Agents SDK package:

```ts
import { Agent, Runner, tool } from "@openai/agents";
```

It does not use the deprecated Assistants API or legacy Chat Completions scaffolding. The route streams SDK events from `runner.run(agent, input, { stream: true })` into browser-friendly server-sent events.

The runner enables SDK tracing with `traceIncludeSensitiveData: false`. Set `LAUNCH_DESK_TRACING_DISABLED=true` for local debugging sessions where trace export is not wanted.

## Extending Tools

Add new deterministic launch logic in `src/lib/launch-desk/tools.ts`, then wrap it with `tool({ name, description, parameters, execute })` and append it to `launchDeskTools`.

Keep tool output business-friendly and small. The model should synthesize the final plan from tool results, not rely on a tool to produce the entire answer.
