const endpoint = process.env.LAUNCH_DESK_URL || "http://localhost:3000/api/launch-desk/plan";
const endpointOrigin = new URL(endpoint).origin;

const payload = {
  productBrief:
    "Launch a release-planning assistant for engineering teams that turns rough product ideas into release tasks, risks, launch copy, and follow-up questions. The first release should be guarded by a feature flag and used by a small pilot group before wider rollout.",
  audience: "Engineering managers, product managers, QA leads, and support leads.",
  launchDate: "2026-07-15",
  constraints: "Needs a rollback switch, observability, security review, and a support FAQ before launch.",
  assets: "Product brief, draft changelog, pilot customer list, and Figma screen.",
};

function parseSseBlock(block) {
  let eventName = "";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!eventName || data.length === 0) return null;
  const parsed = JSON.parse(data.join("\n"));
  return parsed.type === eventName ? parsed : null;
}

async function main() {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: endpointOrigin,
      Referer: `${endpointOrigin}/launch-desk`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`Launch Desk stream failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawToolProgress = false;
  let sawTextDelta = false;
  let textDeltaChars = 0;
  const tools = new Set();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event) continue;

      if (event.type === "tool_progress") {
        sawToolProgress = true;
        tools.add(event.tool);
      }

      if (event.type === "text_delta") {
        sawTextDelta = true;
        textDeltaChars += event.delta.length;
      }

      if (event.type === "error") {
        throw new Error(`Launch Desk stream error: ${event.message}`);
      }
    }

    if (sawToolProgress && sawTextDelta) {
      break;
    }
  }

  if (!sawToolProgress) throw new Error("Expected at least one tool_progress event, but none was received.");
  if (!sawTextDelta) throw new Error("Expected at least one text_delta event, but none was received.");

  console.log(
    JSON.stringify(
      {
        endpoint,
        ok: true,
        textDeltaChars,
        tools: Array.from(tools),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
