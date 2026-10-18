// Which commit an URGENT deploy is serving (docs/deployment.md, "The urgent route").
//
// A normal deploy is a Railway GitHub build, and Railway injects RAILWAY_GIT_COMMIT_SHA, which
// getDeployRevision() reads. An urgent deploy is a `railway up` CLI upload, which carries no git
// metadata at all — so /api/healthz would report `revision: null`, scripts/urgent-deploy.mjs could
// not tell its build is live, and deploy-drift-check would alarm. The urgent workflow therefore
// writes public/urgent-deploy.json into the uploaded tree; it is never committed, so a normal build
// never has it and this returns null there.
//
// Server-only (node:fs). Read once per process: the file cannot change inside a running container.

import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null | undefined;

export function readUrgentDeployRevision(): string | null {
  if (cached !== undefined) return cached;
  let revision: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "public", "urgent-deploy.json"), "utf8"));
    const value = typeof raw?.revision === "string" ? raw.revision : "";
    revision = /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    revision = null;
  }
  cached = revision;
  return revision;
}
