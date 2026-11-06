import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";
import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ONE DOOR TO THE AI ACCOUNTS (owner, 24 Oct 2026: "pass by all modules that use ai in phoenix and make
// sure they use same rule"). Every AI call goes OpenAI → Anthropic account 1 → Anthropic account 2, and a
// call moves on only when the account it asked is out of credit or refuses its key. That chain lives in
// two places and nowhere else:
//   - src/lib/ai/                    the shared call (createOpenAiResponseText) and the Anthropic leg
//   - src/lib/sales/ai/provider.ts   the sales chain (planSalesAi / runWithSalesAiFailover), which also
//                                    reaches the OpenAI-compatible AI_BASE_URL, Groq and OpenRouter
// A module that builds its own OpenAI client, posts to a provider URL or reads a key itself skips the
// second and third accounts without anyone noticing: it answers until OpenAI runs dry, then fails alone.
// Groq speech to text is the one other door (no Anthropic speech engine; owner cost ruling 2026-09-25).
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRS = ["src", "app"];
const AI_LIBRARY = "src/lib/ai/";
const SALES_PROVIDER = "src/lib/sales/ai/provider.ts";
const GROQ_SPEECH = "src/lib/ai/groq-transcription.ts";
// The AI library's list of provider HOST NAMES — names the test-account fence lets through, never a call.
const AI_HOST_NAMES = "src/lib/ai/provider-hosts.ts";

type DoorRule = { allowed: (file: string) => boolean; pattern: RegExp; what: string };

const RULES: DoorRule[] = [
  {
    allowed: (file) => file === "src/lib/ai/openai-client.ts",
    pattern: /from\s+["'](?:openai|@openai\/[^"']+)["']|require\(\s*["'](?:openai|@openai\/[^"']+)["']\s*\)|\bnew\s+OpenAI\s*\(/,
    what: "the OpenAI SDK (use createOpenAiResponseText from src/lib/ai/openai-client.ts)",
  },
  {
    allowed: (file) => file.startsWith(AI_LIBRARY) || file === SALES_PROVIDER,
    pattern: /api\.openai\.com/,
    what: "the OpenAI address",
  },
  {
    allowed: (file) => file.startsWith(AI_LIBRARY),
    pattern: /api\.anthropic\.com/,
    what: "the Anthropic address (use the shared call; it reaches both Anthropic accounts)",
  },
  {
    allowed: (file) => file.startsWith(AI_LIBRARY),
    pattern: /env\s*(?:\.\s*|\[\s*["'])ANTHROPIC_API_KEY/,
    what: "an Anthropic key read (use hasAiApiKey() to ask whether AI is configured)",
  },
  {
    allowed: (file) => file.startsWith(AI_LIBRARY) || file === SALES_PROVIDER,
    pattern: /env\s*(?:\.\s*|\[\s*["'])OPENAI_API_KEY/,
    what: "an OpenAI key read (use hasAiApiKey() to ask whether AI is configured)",
  },
  {
    allowed: (file) => file === GROQ_SPEECH || file === SALES_PROVIDER || file === AI_HOST_NAMES,
    pattern: /api\.groq\.com|openrouter\.ai/,
    what: "a Groq or OpenRouter address",
  },
];

function sourceFiles(relativeDir: string, out: string[] = []): string[] {
  const absolute = path.join(ROOT, relativeDir);
  for (const name of cachedReaddir(absolute)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const relative = `${relativeDir}/${name}`;
    if (cachedIsDirectory(path.join(absolute, name))) sourceFiles(relative, out);
    else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(name)) out.push(relative);
  }
  return out;
}

export function findAiDoorBreaches(files: { code: string; file: string }[]): string[] {
  const breaches: string[] = [];
  for (const { code, file } of files) {
    for (const rule of RULES) {
      if (!rule.allowed(file) && rule.pattern.test(code)) breaches.push(`${file}: ${rule.what}`);
    }
  }
  return breaches;
}

export async function runAiOneDoorTests() {
  const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(dir)).map((file) => ({
    code: stripComments(cachedReadFile(path.join(ROOT, file))),
    file,
  }));
  assert.ok(files.length > 1000, `the sweep read only ${files.length} files: a sweep that reads less reports a clean tree`);
  assert.ok(
    files.some((entry) => entry.file === "src/lib/ai/openai-client.ts" && /new\s+OpenAI\s*\(/.test(entry.code)),
    "the shared call must still be where the sweep looks for it",
  );

  assert.deepEqual(
    findAiDoorBreaches(files),
    [],
    "RED an AI call outside the one door skips the two Anthropic accounts: route it through src/lib/ai/ or the sales chain",
  );

  // The sweep itself must fire: each rule refuses a planted breach in an ordinary module.
  const planted = [
    'import OpenAI from "openai";\nconst client = new OpenAI({ apiKey: "x" });',
    'await fetch("https://api.openai.com/v1/responses");',
    'await fetch("https://api.anthropic.com/v1/messages");',
    "const key = process.env.ANTHROPIC_API_KEY_2;",
    'const key = process.env["OPENAI_API_KEY"];',
    'await fetch("https://api.groq.com/openai/v1/chat/completions");',
  ];
  for (const code of planted) {
    assert.equal(findAiDoorBreaches([{ code, file: "src/lib/expenses/notes.ts" }]).length > 0, true, `the sweep must refuse: ${code}`);
  }
  assert.deepEqual(
    findAiDoorBreaches([{ code: 'await fetch("https://api.groq.com/openai/v1/audio/transcriptions");', file: GROQ_SPEECH }]),
    [],
    "Groq speech to text keeps its own door",
  );
  assert.deepEqual(
    findAiDoorBreaches([{ code: 'const k = env.OPENAI_API_KEY; const u = "https://api.openai.com/v1";', file: SALES_PROVIDER }]),
    [],
    "the sales chain reaches its OpenAI-compatible providers itself",
  );
}
