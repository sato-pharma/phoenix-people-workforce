# Development Workflow

## Overview

Phoenix Workforce follows a governed development workflow. All changes -- whether manually written or tool-assisted -- pass through the same validation, review, and approval pipeline before reaching production.

## Engineering Operating Rules

The repository root contains internal engineering reference files that define coding standards, architecture conventions, command references, and operating procedures for contributors. These files are the source of truth for repository governance and are maintained alongside the codebase.

Key topics covered:

- Available commands and quality gates
- Architecture overview and domain layout
- Auth and access control conventions
- API route patterns
- Testing conventions and test harness structure
- Branch and deployment model
- Code conventions and path aliases
- Communication standards
- Git workflow safety rules
- Validation and quality requirements
- Database and migration safety rules
- Enterprise safety rules for high-risk domains (payroll, auth, employee lifecycle)
- Approval workflow requirements

## Development Rules

1. All changes follow the same review process regardless of how they were authored
2. All commits, pushes, and PRs require explicit approval
3. Validation gates must pass before proposing changes
4. Production-impacting changes require explanation of risk and rollback plan
5. Database changes follow the migration policy (see [migrations.md](migrations.md))
6. Repetitive tasks should be automated where safely possible

## Workflow Summary

- Use the working branch (never push directly to `main`)
- CI is the gate: push and let the PR's checks answer, rather than running a full validation
  locally first (`check:edit` is an optional fast typecheck mid-task)
- Explain changes before executing them
- Ask for approval before destructive operations
- Follow the domain-first architecture rule (business logic in `src/lib/<domain>/`)
- Never merge a PR whose required checks are red

## Related Documentation

- [CONTRIBUTING.md](../CONTRIBUTING.md) -- branch strategy, commit format, PR process
- [Architecture](architecture.md) -- system design and domain layout
- [Editing Guide](editing-guide.md) -- where to make edits, quality gate workflow
- [Scripts Reference](scripts.md) -- all npm scripts with safety classifications
- [Testing](testing.md) -- test strategy and adding new tests
- [Performance Engineering Standards](performance-engineering-standards.md) -- mandatory query, caching, and data-lifecycle rules from the 2026-07 production incident
