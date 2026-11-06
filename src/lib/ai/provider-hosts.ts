/**
 * The AI providers' host names, held by the AI library so no other module spells an AI address
 * (tests/ai-one-door.test.ts). A list of names, never a call: the test-account fence
 * (src/lib/auth/test-dry-run.ts) reads it to let an AI question through, because asking an AI saves
 * nothing. Pure, no imports — the fence is installed at boot, before anything heavier loads.
 */
export const AI_PROVIDER_HOSTS = ["api.openai.com", "api.anthropic.com", "api.groq.com"] as const;
