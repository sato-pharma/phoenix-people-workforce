import {
  createOpenAiResponseText,
  hasAiApiKey,
  resolveOpenAiCopilotModel,
} from "@/lib/ai/openai-client";

/**
 * The conversational side of the Copilot — PROSE ANSWERS, no actions.
 *
 * When the CEO types a question rather than a command ("why is Ahmed flagged?",
 * "who dropped in pay this month?", "how many joiners?"), the action parser
 * (llm.ts) returns nothing. This module answers instead: it hands the model a
 * compact, grounded summary of the current draft and asks it to reply in plain
 * English, strictly from that data. It never computes or mutates anything — it
 * only explains what's already on the sheet. Returns null when no OpenAI key is
 * configured (the UI then shows its normal "couldn't turn that into a change").
 */

export type AssistantEmployeeContext = {
  hrId: string;
  name: string;
  status: string;
  netSalary: number;
  monthSalary: number;
  totalAdditions: number;
  totalDeductions: number;
  flags: Array<{ rule: string; question: string }>;
  recommendation: { why: string; confidence: string } | null;
};

/** Hard cap so a very large roster can't blow the prompt budget. Flagged rows first. */
const MAX_CONTEXT_ROWS = 150;

function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

function employeeLine(e: AssistantEmployeeContext): string {
  const parts = [
    `${e.hrId} ${e.name}`,
    `status=${e.status}`,
    `net=${egp(e.netSalary)}`,
    `pay=${egp(e.monthSalary)}`,
    `additions=${egp(e.totalAdditions)}`,
    `deductions=${egp(e.totalDeductions)}`,
  ];
  if (e.flags.length > 0) {
    parts.push(`flags=[${e.flags.map((f) => f.rule).join(", ")}]`);
  }
  if (e.recommendation) {
    parts.push(`recommended(${e.recommendation.confidence})="${e.recommendation.why}"`);
  }
  return `- ${parts.join(" | ")}`;
}

/**
 * Build the grounded roster the model answers from. Flagged/held employees come
 * first (they're what questions are usually about); clean "green" rows are
 * summarised as a count so a 117-person roster stays compact and on-budget.
 */
export function buildAssistantContext(employees: AssistantEmployeeContext[]): string {
  const nonGreen = employees.filter((e) => e.status !== "green");
  const greenCount = employees.length - nonGreen.length;
  const shown = nonGreen.slice(0, MAX_CONTEXT_ROWS);
  const omitted = nonGreen.length - shown.length;

  const lines = shown.map(employeeLine);
  const summary = [
    `Total employees: ${employees.length} (${greenCount} clean/green with no open question, ${nonGreen.length} flagged or on hold).`,
    "",
    "Flagged / on-hold employees:",
    ...lines,
  ];
  if (omitted > 0) {
    summary.push(`… and ${omitted} more flagged employees not listed here.`);
  }
  return summary.join("\n");
}

export async function answerCeoQuestion(input: {
  text: string;
  periodLabel: string;
  employees: AssistantEmployeeContext[];
}): Promise<string | null> {
  if (!hasAiApiKey()) return null;

  const instructions = [
    `You are a payroll assistant helping the CEO review the ${input.periodLabel} payroll draft.`,
    "Answer the CEO's question in plain, concise English, using ONLY the roster data below.",
    "Typical questions: why someone is flagged, what changed vs last month, who dropped/rose in pay, how many joiners/leavers, what the Copilot recommends for someone.",
    "When asked why a person is flagged, explain their flag(s) and state the Copilot's recommendation for them in your own words.",
    "Never invent a number, name, or fact that isn't in the data. If the answer isn't in the roster below, say so plainly and suggest where the CEO can look.",
    "Keep it short — a few sentences or a tight list. Money is in EGP. Do not output JSON or code.",
    "",
    "Roster:",
    buildAssistantContext(input.employees),
  ].join("\n");

  const response = await createOpenAiResponseText({
    input: input.text,
    instructions,
    model: resolveOpenAiCopilotModel(),
    purpose: "payroll_copilot_ask",
    reasoning: { effort: "medium" },
    text: { format: { type: "text" } },
  });

  const answer = (response.outputText ?? "").trim();
  return answer.length > 0 ? answer : null;
}
