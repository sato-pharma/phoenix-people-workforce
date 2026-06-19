import { Agent, Runner } from "@openai/agents";

import { launchDeskTools } from "@/lib/launch-desk/tools";
import type { LaunchDeskInput } from "@/lib/launch-desk/types";

export function getLaunchDeskModel(): string {
  return process.env.LAUNCH_DESK_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

export function isLaunchDeskEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.LAUNCH_DESK_ENABLED === "true";
}

export function buildLaunchDeskPrompt(input: LaunchDeskInput): string {
  return [
    "Turn this launch idea into an actionable release plan.",
    "",
    `Product brief:\n${input.productBrief}`,
    "",
    `Audience:\n${input.audience || "Not provided"}`,
    "",
    `Launch date or window:\n${input.launchDate || "Not provided"}`,
    "",
    `Constraints:\n${input.constraints || "Not provided"}`,
    "",
    `Available assets:\n${input.assets || "Not provided"}`,
  ].join("\n");
}

export function createLaunchDeskAgent(): Agent {
  return new Agent({
    name: "Launch Desk",
    model: getLaunchDeskModel(),
    modelSettings: {
      parallelToolCalls: true,
      reasoning: { effort: "low" },
      text: { verbosity: "medium" },
      toolChoice: "required",
    },
    tools: launchDeskTools,
    instructions: [
      "You are Launch Desk, a release-planning agent for engineering teams.",
      "Use the provided tools before writing the final answer. You should call extract_launch_tasks, check_launch_readiness, generate_owner_checklists, and draft_channel_launch_copy whenever possible.",
      "Your final answer must be practical and structured with these sections: Prioritized plan, Risk register, Owner checklist, Launch copy suggestions, Follow-up questions.",
      "Do not invent named people. Use owner roles unless the user provided names.",
      "When details are missing, make conservative assumptions, mark them as assumptions, and ask direct follow-up questions.",
      "Keep launch advice production-minded: rollout controls, validation, observability, rollback, support readiness, and decision gates.",
      "Avoid deprecated Assistants API language. This workflow runs through the OpenAI Agents SDK and its tools.",
    ].join("\n"),
  });
}

export function createLaunchDeskRunner(): Runner {
  return new Runner({
    workflowName: "Launch Desk release planning",
    traceIncludeSensitiveData: false,
    traceMetadata: {
      app: "launch-desk",
      surface: "next-route-handler",
    },
    tracingDisabled: process.env.LAUNCH_DESK_TRACING_DISABLED === "true",
  });
}
