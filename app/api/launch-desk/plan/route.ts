import type { RunStreamEvent } from "@openai/agents";

import { buildLaunchDeskPrompt, createLaunchDeskAgent, createLaunchDeskRunner, isLaunchDeskEnabled } from "@/lib/launch-desk/agent";
import { launchDeskInputSchema, type LaunchDeskEvent } from "@/lib/launch-desk/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: LaunchDeskEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function toolNameFromEvent(event: RunStreamEvent): string | null {
  if (event.type !== "run_item_stream_event") return null;
  const rawItem = (event.item as { rawItem?: { name?: unknown } }).rawItem;
  return typeof rawItem?.name === "string" ? rawItem.name : null;
}

function toolMessage(stage: "started" | "completed", toolName: string): string {
  const labels: Record<string, string> = {
    check_launch_readiness: "Checking launch readiness against the release rubric",
    draft_channel_launch_copy: "Drafting channel-specific launch copy",
    extract_launch_tasks: "Extracting launch tasks from the brief",
    generate_owner_checklists: "Generating owner checklists",
  };
  const label = labels[toolName] ?? `Running ${toolName}`;
  return stage === "started" ? label : `${label} complete`;
}

export async function POST(request: Request) {
  const csrfError = assertSameOriginMutation(request);
  if (csrfError) return csrfError;

  if (!isLaunchDeskEnabled()) {
    return Response.json(
      { success: false, error: "Launch Desk is disabled for this environment. Set LAUNCH_DESK_ENABLED=true to enable it." },
      { status: 404 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { success: false, error: "OPENAI_API_KEY is not configured on the server process." },
      { status: 400 },
    );
  }

  const parsed = launchDeskInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid Launch Desk request." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: LaunchDeskEvent) => {
        controller.enqueue(encoder.encode(sse(event)));
      };

      try {
        const agent = createLaunchDeskAgent();
        const runner = createLaunchDeskRunner();

        send({
          type: "tool_progress",
          stage: "started",
          tool: "launch_desk_agent",
          message: "Starting Launch Desk agent run",
        });

        const result = await runner.run(agent, buildLaunchDeskPrompt(parsed.data), {
          maxTurns: 8,
          signal: abortController.signal,
          stream: true,
          toolExecution: { maxFunctionToolConcurrency: 2 },
        });

        for await (const event of result) {
          if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
            const delta = typeof event.data.delta === "string" ? event.data.delta : "";
            if (delta) send({ type: "text_delta", delta });
            continue;
          }

          if (event.type === "run_item_stream_event" && (event.name === "tool_called" || event.name === "tool_output")) {
            const toolName = toolNameFromEvent(event) ?? "unknown_tool";
            const stage = event.name === "tool_called" ? "started" : "completed";
            send({
              type: "tool_progress",
              stage,
              tool: toolName,
              message: toolMessage(stage, toolName),
            });
          }
        }

        send({
          type: "final",
          output: typeof result.finalOutput === "string" ? result.finalOutput : JSON.stringify(result.finalOutput),
        });
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[launch-desk] agent stream failed", error);
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Launch Desk agent failed.",
          });
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
