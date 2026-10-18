---
name: an-anthropic-key-with-no-workspace-answers-400-on-every-call
description: "An Anthropic key created with no workspace chosen authenticates but answers HTTP 400 \"must include the anthropic-workspace-id header\" on EVERY Messages call, so the OpenAI-to-Anthropic failover would fail silently; create the key with a workspace picked in the Console, set it on BOTH Railway services that hold OPENAI_API_KEY (web and worker), and prove it with a live railway-run call, never a mock."
metadata:
  node_type: memory
  type: reference
  originSessionId: 4f5cb21d-7ab7-4ca7-aa79-351b08aee6ae
  modified: 2026-10-18T05:29:55.579Z
---

On 2026-10-18 the OpenAI account was out of credit and the owner supplied an Anthropic key for the failover (PR 6065, `src/lib/ai/anthropic-fallback.ts`). The key he first pasted was a user-level key (`sk-ant-usr-…`, 106 chars) with no workspace: it passed Railway's shape check and was accepted by Anthropic's auth, but every call returned HTTP 400 "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header". Every test until then had used a mocked fetch, so only a live call showed it.

**Why:** a failover that has never made one successful live call is a hope, not a fallback. The 400 reads as a generic `failed`, not `auth_failed`, so nothing in the error monitor would have said "key problem".

**How to apply:** when the key is created or rotated, (1) at platform.claude.com/settings/keys choose a workspace in the Create key dialog; the new key still starts `sk-ant-usr-`, so the prefix proves nothing. (2) Set `ANTHROPIC_API_KEY` on `phoenix-people-workforce` AND `phoenix-workforce-worker` in production, because both hold `OPENAI_API_KEY`. (3) Prove it with a one-token call through the shipped client under `railway run -s <service> -e production -- node …`, which injects the key so it is never printed; both models (`claude-haiku-5-5`, `claude-sonnet-5-5`) answered "OK" on both services on 2026-10-18 08:29 Cairo. The key is not in the secret-sync list, so it is set by hand. Related: [[a-railway-variable-is-reverted-by-its-github-secret]].
