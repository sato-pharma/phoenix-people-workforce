# Launch Desk Validation Checklist

## Agent Behavior

- The agent calls at least one Launch Desk tool before final output.
- The final answer includes prioritized plan, risk register, owner checklist, launch copy suggestions, and follow-up questions.
- Missing audience, launch date, rollback path, metrics, or owners produce follow-up questions.
- The agent does not invent named owners when the user only provides roles or no names.
- The output distinguishes assumptions from confirmed launch details.

## Frontend Flow

- `/launch-desk` loads without authentication in local development.
- The form captures product brief, audience, launch date, constraints, and assets.
- Submit disables the generate button while the stream is active.
- Tool progress updates before or during model output.
- Model text appears progressively in the output pane.
- Stop aborts the current request without crashing the UI.
- API errors show a clear message in the output pane.

## Tool Outputs

- `extract_launch_tasks` returns tasks with priority, owner role, phase, due hint, and rationale.
- `check_launch_readiness` returns a score, rubric, risk register, and follow-up questions.
- `generate_owner_checklists` groups action items by owner role.
- `draft_channel_launch_copy` returns internal Slack, customer email, changelog, and executive update drafts.

## Local Verification

- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm run test` passes or any unrelated failure is documented.
- `npm run build` passes because this feature touches app routes and API routes.
- `npm run launch-desk:verify` passes against a running local server with `OPENAI_API_KEY`.

## Deployment Safety

- Production and preview runtime access requires `LAUNCH_DESK_ENABLED=true`.
- `OPENAI_API_KEY` remains server-only.
- No API keys or secrets are committed.
- Tracing excludes sensitive input and output data by default.
