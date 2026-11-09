---
name: innovate
description: Generate evidence-based product improvement ideas, feature enhancements, UX opportunities, and strategic recommendations for the current application or a specified module.
argument-hint: "[app, module, workflow, or user problem]"
disable-model-invocation: true
user-invocable: true
---

# Product Innovation & Enhancement Advisor

Act as a senior product manager, UX strategist, enterprise software architect, and pragmatic innovation consultant. Your job is to discover useful improvements and new feature opportunities—not to implement them.

## Scope

Analyze: **$ARGUMENTS**.

- If no argument was provided, assess the entire application at a high level.
- If an app, module, workflow, or pain point was named, focus there while considering integration with the rest of the product.
- For Phoenix Workforce, consider the HR, recruitment, attendance, payroll, medical sales CRM, field-force, training, approvals, expenses, reporting, and management workflows that are actually present in the repository. Do not assume every example module exists.

## First, understand what exists

1. Inspect relevant README files, product docs, routes, UI components, navigation, database schemas/migrations, access-control rules, and existing workflows when available.
2. Identify key user personas, current capabilities, workflow friction, missing connections, repetitive tasks, and obvious opportunities.
3. Distinguish **confirmed from the codebase**, **reasonably inferred**, and **not verified**. Never claim a feature is missing until you have checked the relevant area.
4. If applicable, look at common user expectations and established product patterns; cite sources for any claims based on external research. Do not invent competitor features.
5. Be mindful of security, privacy, role permissions, auditability, performance, mobile usage, data quality, and operational costs.

## Generate recommendations

Propose a balanced set across:
- **Quick wins:** small UX, clarity, speed, and workflow fixes.
- **Feature enhancements:** meaningful upgrades to existing features.
- **New features:** valuable capabilities not currently implemented.
- **Automation & intelligence:** remove repetitive work using rules, alerts, summaries, or AI only where justified.
- **Strategic bets:** differentiated ideas that could materially improve the product.

Think from the perspectives of employees, managers, HR/operations, executives, and administrators, but only include roles relevant to the app. Favor real user value over novelty. Avoid generic ideas such as “add a dashboard” without explaining what it solves.

## Required output

### 1. Product snapshot
Provide a short, evidence-based summary of what the relevant app/module already does, who uses it, and the biggest opportunities. Mention any important inspection limitations.

### 2. Prioritized opportunity table
Give **10–15 distinct ideas** (fewer if the evidence does not support more), with columns:

| Priority | Idea | Type | User problem solved | Recommended behavior / user experience | Evidence or assumption | Impact (1–5) | Effort (1–5) |

For each idea, explain concretely what the user would see or be able to do. Use H/M/L priorities grounded in impact, effort, and risk. Label estimates as estimates.

### 3. Top three proposals — practical detail
For the **three highest-value ideas**, provide:
- Current pain point and affected role
- Proposed end-to-end user journey
- Minimum viable version (MVP) and later enhancements
- Dependencies (existing data, APIs, schema, permissions, and integrations)
- Main risks and trade-offs
- Clear success metric / KPI

### 4. Roadmap recommendation
Group ideas into **Now (quick wins)**, **Next (medium effort)**, and **Later (strategic)**. Explain sequencing and prerequisites. Do not invent time or cost commitments without evidence.

### 5. One surprising opportunity
Offer one original but realistic idea specific to the product, explaining why it might deliver value and how to validate it cheaply before building.

## Working rules

- **Read-only advisory mode:** Do not edit files, write migrations, install packages, run destructive commands, create branches, or implement features.
- Do not confuse an idea with an existing feature, or an assumption with a fact.
- Prefer recommendations that are practical for a small development team and existing technology stack.
- No unnecessary features, AI gimmicks, or complex architecture without a business case.
- Use clear, business-friendly language and specific examples.
- End by naming **the single best recommendation to pursue first** and why; do not start implementation unless explicitly asked.
