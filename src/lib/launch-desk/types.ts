import { z } from "zod";

export const launchDeskInputSchema = z.object({
  productBrief: z
    .string()
    .trim()
    .min(20, "Enter a brief with at least 20 characters.")
    .max(6000, "Keep the brief under 6,000 characters."),
  audience: z.string().trim().max(2000, "Keep the audience under 2,000 characters.").optional().default(""),
  launchDate: z.string().trim().max(80, "Keep the launch date short.").optional().default(""),
  constraints: z.string().trim().max(2500, "Keep constraints under 2,500 characters.").optional().default(""),
  assets: z.string().trim().max(2500, "Keep assets under 2,500 characters.").optional().default(""),
});

export type LaunchDeskInput = z.infer<typeof launchDeskInputSchema>;

export type LaunchPriority = "P0" | "P1" | "P2";
export type LaunchPhase = "Discovery" | "Build" | "Validation" | "Release" | "Post-launch";
export type LaunchRiskLevel = "High" | "Medium" | "Low";
export type LaunchReadinessStatus = "ready" | "watch" | "blocked";

export type LaunchTask = {
  id: string;
  title: string;
  ownerRole: string;
  priority: LaunchPriority;
  phase: LaunchPhase;
  dueHint: string;
  rationale: string;
};

export type LaunchRisk = {
  id: string;
  level: LaunchRiskLevel;
  risk: string;
  mitigation: string;
  ownerRole: string;
};

export type LaunchRubricItem = {
  area: string;
  status: LaunchReadinessStatus;
  score: number;
  evidence: string;
};

export type LaunchReadiness = {
  score: number;
  verdict: LaunchReadinessStatus;
  rubric: LaunchRubricItem[];
  riskRegister: LaunchRisk[];
  followUpQuestions: string[];
};

export type OwnerChecklist = {
  ownerRole: string;
  checklist: string[];
};

export type LaunchCopyDraft = {
  channel: "internal_slack" | "customer_email" | "changelog" | "executive_update";
  headline: string;
  body: string;
  callToAction: string;
};

export type LaunchDeskEvent =
  | {
      type: "tool_progress";
      stage: "started" | "completed";
      tool: string;
      message: string;
    }
  | {
      type: "text_delta";
      delta: string;
    }
  | {
      type: "final";
      output: string;
    }
  | {
      type: "error";
      message: string;
    };
