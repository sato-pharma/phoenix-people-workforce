import { tool } from "@openai/agents";
import { z } from "zod";

import {
  launchDeskInputSchema,
  type LaunchCopyDraft,
  type LaunchDeskInput,
  type LaunchPriority,
  type LaunchReadiness,
  type LaunchReadinessStatus,
  type LaunchRisk,
  type LaunchRiskLevel,
  type LaunchTask,
  type OwnerChecklist,
} from "@/lib/launch-desk/types";

const toolInputSchema = launchDeskInputSchema.describe("Launch brief, audience, date, constraints, and assets supplied by the user.");

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function lowerBlob(input: LaunchDeskInput): string {
  return `${input.productBrief} ${input.audience} ${input.constraints} ${input.assets}`.toLowerCase();
}

function firstSentence(value: string, fallback: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(.{24,220}?[.!?])\s/);
  return ((match?.[1] ?? cleaned.slice(0, 180)) || fallback).trim();
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function inferDaysUntilLaunch(launchDate: string, referenceDate = new Date()): number | null {
  const trimmed = normalizeText(launchDate);
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const launch = new Date(parsed);
  const todayUtc = Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate());
  const launchUtc = Date.UTC(launch.getUTCFullYear(), launch.getUTCMonth(), launch.getUTCDate());
  return Math.ceil((launchUtc - todayUtc) / 86_400_000);
}

function priorityFromRisk(hasDatePressure: boolean, isReleaseCritical: boolean): LaunchPriority {
  if (isReleaseCritical || hasDatePressure) return "P0";
  return "P1";
}

export function extractLaunchTasks(input: LaunchDeskInput, referenceDate = new Date()): { tasks: LaunchTask[]; assumptions: string[] } {
  const blob = lowerBlob(input);
  const daysUntilLaunch = inferDaysUntilLaunch(input.launchDate, referenceDate);
  const hasDatePressure = daysUntilLaunch !== null && daysUntilLaunch <= 14;
  const hasMigration = hasAny(blob, ["migration", "database", "schema", "data backfill", "backfill"]);
  const hasSecurity = hasAny(blob, ["security", "permission", "auth", "compliance", "privacy", "legal"]);
  const hasMobile = hasAny(blob, ["mobile", "ios", "android"]);
  const hasAssets = normalizeText(input.assets).length > 0;

  const tasks: LaunchTask[] = [
    {
      id: "scope-lock",
      title: "Lock the launch scope and non-goals",
      ownerRole: "Product lead",
      priority: "P0",
      phase: "Discovery",
      dueHint: "Before implementation starts",
      rationale: "A rough launch idea needs a clear boundary before engineering commits to dates.",
    },
    {
      id: "release-architecture",
      title: "Confirm release path, feature flags, and rollback switch",
      ownerRole: "Engineering lead",
      priority: priorityFromRisk(hasDatePressure, true),
      phase: "Build",
      dueHint: hasDatePressure ? "Within 24 hours" : "Early build window",
      rationale: "The launch plan needs a safe way to ship, pause, and recover.",
    },
    {
      id: "test-matrix",
      title: "Build the role, browser, and environment test matrix",
      ownerRole: "QA lead",
      priority: "P0",
      phase: "Validation",
      dueHint: "Before release candidate",
      rationale: "Launch readiness depends on proving the critical paths across real user scenarios.",
    },
    {
      id: "observability",
      title: "Add launch dashboards, alerts, and failure triage owners",
      ownerRole: "Engineering lead",
      priority: hasDatePressure ? "P0" : "P1",
      phase: "Release",
      dueHint: "Before release cut",
      rationale: "The team needs live signals when traffic reaches the launch surface.",
    },
    {
      id: "launch-comms",
      title: "Prepare internal and audience-facing launch messages",
      ownerRole: "Product marketing",
      priority: hasAssets ? "P1" : "P0",
      phase: "Release",
      dueHint: "Two business days before launch",
      rationale: "A release plan is incomplete until stakeholders know what changed and what action to take.",
    },
    {
      id: "support-briefing",
      title: "Brief support and customer-facing teams",
      ownerRole: "Support lead",
      priority: "P1",
      phase: "Release",
      dueHint: "Before announcement",
      rationale: "Support needs expected behavior, known limitations, escalation path, and FAQ answers.",
    },
    {
      id: "post-launch-review",
      title: "Schedule the launch review and decision checkpoint",
      ownerRole: "Release manager",
      priority: "P2",
      phase: "Post-launch",
      dueHint: "24 to 72 hours after launch",
      rationale: "The team needs a planned point to decide whether to expand, hold, or roll back.",
    },
  ];

  if (hasMigration) {
    tasks.splice(3, 0, {
      id: "migration-rehearsal",
      title: "Rehearse migration, backup, and data verification steps",
      ownerRole: "Data or platform engineer",
      priority: "P0",
      phase: "Validation",
      dueHint: "Before release candidate",
      rationale: "Database or data migration work needs a repeatable rollback-aware path.",
    });
  }

  if (hasSecurity) {
    tasks.splice(2, 0, {
      id: "security-review",
      title: "Complete security, permissions, and privacy review",
      ownerRole: "Security or platform owner",
      priority: "P0",
      phase: "Validation",
      dueHint: "Before release approval",
      rationale: "Security-sensitive launches need explicit authorization checks before exposure.",
    });
  }

  if (hasMobile) {
    tasks.push({
      id: "mobile-store-readiness",
      title: "Confirm mobile build, app review, and rollback constraints",
      ownerRole: "Mobile lead",
      priority: "P1",
      phase: "Release",
      dueHint: "Before app submission or staged rollout",
      rationale: "Mobile launches can be slowed by store review and client version adoption.",
    });
  }

  const assumptions: string[] = [];
  if (!normalizeText(input.audience)) assumptions.push("Audience is not defined, so owner and copy recommendations use role-level assumptions.");
  if (!normalizeText(input.launchDate)) assumptions.push("Launch date is missing, so due hints are relative instead of calendar-specific.");
  if (!normalizeText(input.assets)) assumptions.push("No launch assets were listed, so copy and support collateral are marked as creation work.");

  return { tasks, assumptions };
}

function statusFromScore(score: number): LaunchReadinessStatus {
  if (score >= 80) return "ready";
  if (score >= 55) return "watch";
  return "blocked";
}

function risk(level: LaunchRiskLevel, riskText: string, mitigation: string, ownerRole: string, id: string): LaunchRisk {
  return { id, level, risk: riskText, mitigation, ownerRole };
}

export function checkLaunchReadiness(input: LaunchDeskInput, referenceDate = new Date()): LaunchReadiness {
  const blob = lowerBlob(input);
  const daysUntilLaunch = inferDaysUntilLaunch(input.launchDate, referenceDate);
  const hasBrief = normalizeText(input.productBrief).length >= 80;
  const hasAudience = normalizeText(input.audience).length >= 8;
  const hasDate = normalizeText(input.launchDate).length > 0 && daysUntilLaunch !== null;
  const hasConstraints = normalizeText(input.constraints).length >= 8;
  const hasAssets = normalizeText(input.assets).length >= 8;
  const hasRollback = hasAny(blob, ["rollback", "feature flag", "kill switch", "dark launch", "staged rollout"]);
  const hasMetrics = hasAny(blob, ["metric", "analytics", "dashboard", "alert", "sentry", "observability", "kpi"]);
  const hasOwners = hasAny(blob, ["owner", "engineering", "qa", "support", "marketing", "product"]);

  const rubric = [
    {
      area: "Scope clarity",
      score: hasBrief ? 15 : 7,
      status: hasBrief ? "ready" : "watch",
      evidence: hasBrief ? "Brief has enough detail to derive workstreams." : "Brief is short; confirm what is in and out of scope.",
    },
    {
      area: "Audience clarity",
      score: hasAudience ? 12 : 3,
      status: hasAudience ? "ready" : "blocked",
      evidence: hasAudience ? "Audience is provided." : "Audience is missing or too vague.",
    },
    {
      area: "Launch date realism",
      score: hasDate ? (daysUntilLaunch !== null && daysUntilLaunch < 0 ? 0 : daysUntilLaunch !== null && daysUntilLaunch <= 7 ? 5 : 12) : 2,
      status: hasDate && daysUntilLaunch !== null && daysUntilLaunch >= 0 ? (daysUntilLaunch <= 7 ? "watch" : "ready") : "blocked",
      evidence: hasDate ? `Launch date parses with ${daysUntilLaunch} day(s) remaining.` : "Launch date is missing or cannot be parsed.",
    },
    {
      area: "Constraints captured",
      score: hasConstraints ? 10 : 4,
      status: hasConstraints ? "ready" : "watch",
      evidence: hasConstraints ? "Constraints are listed." : "Constraints need to be stated explicitly.",
    },
    {
      area: "Assets and collateral",
      score: hasAssets ? 10 : 3,
      status: hasAssets ? "ready" : "watch",
      evidence: hasAssets ? "Available assets are listed." : "Launch assets are missing.",
    },
    {
      area: "Rollback path",
      score: hasRollback ? 14 : 3,
      status: hasRollback ? "ready" : "blocked",
      evidence: hasRollback ? "Rollback or staged release language is present." : "No rollback or feature-flag plan is visible.",
    },
    {
      area: "Observability",
      score: hasMetrics ? 12 : 4,
      status: hasMetrics ? "ready" : "watch",
      evidence: hasMetrics ? "Metrics, dashboards, or alerts are mentioned." : "Success metrics and alerting need definition.",
    },
    {
      area: "Owner coverage",
      score: hasOwners ? 15 : 5,
      status: hasOwners ? "ready" : "watch",
      evidence: hasOwners ? "At least some owner roles are named." : "Owner roles are implied but not assigned.",
    },
  ] satisfies { area: string; score: number; status: LaunchReadinessStatus; evidence: string }[];

  const score = rubric.reduce((sum, item) => sum + item.score, 0);
  const riskRegister: LaunchRisk[] = [];

  if (!hasAudience) {
    riskRegister.push(risk("High", "Audience mismatch", "Define primary and secondary audiences before final copy or rollout sequencing.", "Product lead", "audience-mismatch"));
  }
  if (!hasDate || (daysUntilLaunch !== null && daysUntilLaunch <= 7)) {
    riskRegister.push(risk("High", "Schedule compression", "Cut scope, stage the rollout, or move launch approval until validation is complete.", "Release manager", "schedule-compression"));
  }
  if (!hasRollback) {
    riskRegister.push(risk("High", "No visible rollback path", "Add a feature flag, kill switch, data backup, or documented rollback decision tree.", "Engineering lead", "rollback-gap"));
  }
  if (hasAny(blob, ["migration", "database", "schema", "backfill"])) {
    riskRegister.push(risk("Medium", "Data migration failure", "Run a rehearsal on staging, capture counts before and after, and assign a rollback owner.", "Data or platform engineer", "migration-failure"));
  }
  if (hasAny(blob, ["security", "permission", "privacy", "legal", "compliance"])) {
    riskRegister.push(risk("Medium", "Security or compliance delay", "Complete sign-off before public exposure and document any restricted rollout rules.", "Security or platform owner", "security-delay"));
  }
  if (!hasMetrics) {
    riskRegister.push(risk("Medium", "No launch health signal", "Define success, failure, adoption, and support metrics before announcement.", "Engineering lead", "metrics-gap"));
  }
  if (!hasAssets) {
    riskRegister.push(risk("Low", "Announcement assets are incomplete", "Create screenshots, FAQ, changelog notes, and enablement snippets.", "Product marketing", "asset-gap"));
  }

  const followUpQuestions: string[] = [];
  if (!hasAudience) followUpQuestions.push("Who is the primary audience and who should not see this launch yet?");
  if (!hasDate) followUpQuestions.push("What exact launch date or launch window should the plan optimize around?");
  if (!hasRollback) followUpQuestions.push("What is the rollback or staged rollout mechanism if the launch causes issues?");
  if (!hasMetrics) followUpQuestions.push("Which metrics decide whether the launch is healthy after release?");
  if (!hasOwners) followUpQuestions.push("Who owns engineering, QA, product marketing, support, and final launch approval?");

  return {
    score,
    verdict: statusFromScore(score),
    rubric,
    riskRegister,
    followUpQuestions,
  };
}

export function generateOwnerChecklists(input: LaunchDeskInput, referenceDate = new Date()): { owners: OwnerChecklist[] } {
  const { tasks } = extractLaunchTasks(input, referenceDate);
  const readiness = checkLaunchReadiness(input, referenceDate);
  const owners = new Map<string, string[]>();

  for (const task of tasks) {
    const list = owners.get(task.ownerRole) ?? [];
    list.push(`${task.priority}: ${task.title} (${task.phase}, ${task.dueHint})`);
    owners.set(task.ownerRole, list);
  }

  for (const item of readiness.riskRegister) {
    const list = owners.get(item.ownerRole) ?? [];
    list.push(`Risk: ${item.mitigation}`);
    owners.set(item.ownerRole, list);
  }

  return {
    owners: Array.from(owners.entries()).map(([ownerRole, checklist]) => ({ ownerRole, checklist: checklist.slice(0, 7) })),
  };
}

export function draftLaunchCopy(input: LaunchDeskInput): { drafts: LaunchCopyDraft[] } {
  const audience = normalizeText(input.audience) || "the target audience";
  const brief = firstSentence(input.productBrief, "A new product launch is ready for planning.");
  const launchWindow = normalizeText(input.launchDate) || "the planned launch window";
  const assets = normalizeText(input.assets) || "screenshots, FAQ, and demo notes still to be confirmed";

  return {
    drafts: [
      {
        channel: "internal_slack",
        headline: "Launch plan ready for review",
        body: `${brief} We are preparing this for ${audience} with launch timing around ${launchWindow}. Engineering, QA, product marketing, and support should review their owner checklist before release approval.`,
        callToAction: "Reply with blockers, missing owners, or launch-risk updates.",
      },
      {
        channel: "customer_email",
        headline: "A better way to get the launch outcome you need",
        body: `${brief} This update is designed for ${audience}. We will share availability, key benefits, and support details when the release window is confirmed.`,
        callToAction: "Watch for the launch note and share any questions with your account or support contact.",
      },
      {
        channel: "changelog",
        headline: "Launch update",
        body: `${brief} Included assets: ${assets}. Validation should confirm critical paths, rollout controls, and known limitations before this entry is published.`,
        callToAction: "Link to docs, migration notes, and support guidance.",
      },
      {
        channel: "executive_update",
        headline: "Release readiness summary",
        body: `${brief} Current audience: ${audience}. Target date: ${launchWindow}. Decision makers should review readiness score, high risks, rollback path, and owner coverage before approving release.`,
        callToAction: "Approve, hold, or request more evidence before the launch gate.",
      },
    ],
  };
}

export const extractLaunchTasksTool = tool({
  name: "extract_launch_tasks",
  description: "Extract prioritized engineering, QA, launch, and post-launch tasks from a rough product brief.",
  parameters: toolInputSchema,
  strict: true,
  execute: (input: z.infer<typeof toolInputSchema>) => extractLaunchTasks(input),
});

export const checkLaunchReadinessTool = tool({
  name: "check_launch_readiness",
  description: "Score launch readiness against a practical release rubric and return risks plus follow-up questions.",
  parameters: toolInputSchema,
  strict: true,
  execute: (input: z.infer<typeof toolInputSchema>) => checkLaunchReadiness(input),
});

export const generateOwnerChecklistsTool = tool({
  name: "generate_owner_checklists",
  description: "Generate owner-specific checklists for engineering, QA, product marketing, support, and release management.",
  parameters: toolInputSchema,
  strict: true,
  execute: (input: z.infer<typeof toolInputSchema>) => generateOwnerChecklists(input),
});

export const draftLaunchCopyTool = tool({
  name: "draft_channel_launch_copy",
  description: "Draft channel-specific launch copy for internal Slack, customer email, changelog, and executive update channels.",
  parameters: toolInputSchema,
  strict: true,
  execute: (input: z.infer<typeof toolInputSchema>) => draftLaunchCopy(input),
});

export const launchDeskTools = [
  extractLaunchTasksTool,
  checkLaunchReadinessTool,
  generateOwnerChecklistsTool,
  draftLaunchCopyTool,
];
