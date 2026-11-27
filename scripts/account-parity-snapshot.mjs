#!/usr/bin/env node
// Claude Code account-parity snapshot.
//
// Collects ONLY non-secret configuration so two logins can be diffed.
// It NEVER reads ~/.claude/.credentials.json, never emits a token, cookie,
// API key, password or OAuth secret. The account email IS emitted, because the
// owner supplied both addresses himself and the file is useless without it.
//
// Run once under each login:   node ~/.claude/scripts/account-parity-snapshot.mjs
// Then diff the two files it names.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const OUT_DIR = path.join(HOME, '.claude', 'parity-snapshots');
const REPO = 'F:\\Phoenix Workforce\\phoenix-workforce';

const sh = (c) => {
  try {
    return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const readJSON = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const listDir = (p) => {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return null;
  }
};
const sizeOf = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
};

// ---- redaction: anything that smells like a credential never leaves this file
const SECRET_KEY = /(token|secret|key|password|passwd|credential|cookie|auth|bearer|jwt|refresh)/i;
const scrub = (v, key = '') => {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (SECRET_KEY.test(key)) return `<redacted:${v.length} chars>`;
    if (/^(sbp_|sb_|sk-|ghp_|gho_|eyJ[A-Za-z0-9_-]{10,})/.test(v)) return '<redacted:looks-like-a-credential>';
    return v.length > 400 ? `${v.slice(0, 400)}...<+${v.length - 400}>` : v;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrub(v[k], k);
    return o;
  }
  return v;
};

const cfg = readJSON(path.join(HOME, '.claude.json')) || {};
const acct = cfg.oauthAccount || {};

// The CLI config's account can DISAGREE with the desktop app's live account.
// Resolve the app's real account from its own log. An account uuid is not a secret.
let appAccount = null;
try {
  const log = fs.readFileSync(path.join(HOME, 'AppData', 'Local', 'Claude', 'Logs', 'main.log'), 'utf8');
  const hits = [...log.matchAll(/cacheKey=acct:([0-9a-f-]{36})\|/g)].map((m) => m[1]);
  if (hits.length) appAccount = hits[hits.length - 1];
} catch {}

const registry = readJSON(path.join(HOME, '.claude', 'relay', 'accounts.json'));
const emailFor = (uuid) => registry?.accounts?.[uuid]?.email ?? null;

const userSettings = readJSON(path.join(HOME, '.claude', 'settings.json')) || {};
const repoSettings = readJSON(path.join(REPO, '.claude', 'settings.json')) || {};
const repoLocal = readJSON(path.join(REPO, '.claude', 'settings.local.json')) || {};

const skillRoot = path.join(
  HOME,
  'AppData',
  'Roaming',
  'Claude',
  'local-agent-mode-sessions',
  'skills-plugin',
);
const accountSkills = {};
try {
  for (const org of fs.readdirSync(skillRoot)) {
    const orgDir = path.join(skillRoot, org);
    if (!fs.statSync(orgDir).isDirectory()) continue;
    for (const a of fs.readdirSync(orgDir)) {
      const s = listDir(path.join(orgDir, a, 'skills'));
      if (s) accountSkills[emailFor(a) ?? a] = s;
    }
  }
} catch {}

const snap = {
  snapshotVersion: 2,
  takenAt: new Date().toISOString(),
  takenAtCairo: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo' }),

  identity: {
    cliConfigAccount: acct.emailAddress ?? null,
    cliConfigAccountUuid: acct.accountUuid ?? null,
    cliConfigOrgUuid: acct.organizationUuid ?? null,
    desktopAppAccountUuid: appAccount,
    desktopAppAccountEmail: appAccount ? emailFor(appAccount) : null,
    AGREE: appAccount ? appAccount === acct.accountUuid : 'unknown',
    subscriptionTier: registry?.accounts?.[appAccount ?? acct.accountUuid]?.tier ?? null,
  },

  claudeCode: {
    runningExecutable: process.env.CLAUDE_CODE_EXECPATH ?? null,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    desktopAppVersion: process.env.CLAUDE_CODE_DESKTOP_APP_VERSION ?? null,
    sdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION ?? null,
    npmGlobalVersion: sh('claude --version'),
    npmGlobalPath: sh('where claude'),
    installMethod: cfg.installMethod ?? null,
    bundledVersionsOnDisk: listDir(
      path.join(
        HOME,
        'AppData',
        'Local',
        'Packages',
        'Claude_pzs8sxrjxfjjc',
        'LocalCache',
        'Roaming',
        'Claude',
        'claude-code',
      ),
    ),
    node: process.version,
  },

  modelAndEffort: {
    settingsModel: userSettings.model ?? null,
    settingsFallbackModel: userSettings.fallbackModel ?? null,
    settingsEffortLevel: userSettings.effortLevel ?? null,
    settingsAutoCompactWindow: userSettings.autoCompactWindow ?? null,
    env_CLAUDE_EFFORT: process.env.CLAUDE_EFFORT ?? null,
    env_CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
    env_CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,
    additionalModelOptionsCache: cfg.additionalModelOptionsCache ?? null,
    modelAccessCache: cfg.modelAccessCache ?? null,
    orgModelDefaultCache: cfg.orgModelDefaultCache ?? null,
  },

  featureFlags: {
    growthBookCount: Object.keys(cfg.cachedGrowthBookFeatures ?? {}).length,
    growthBookFetchedAt: cfg.cachedGrowthBookFeaturesAt
      ? new Date(cfg.cachedGrowthBookFeaturesAt).toISOString()
      : null,
    experimentFeatures: scrub(cfg.cachedExperimentFeatures ?? null),
    hasAvailableSubscription: cfg.hasAvailableSubscription ?? null,
    extraUsageDisabledReason: cfg.cachedExtraUsageDisabledReason ?? null,
  },

  settings: {
    user: scrub(userSettings),
    repoProject: scrub(repoSettings),
    repoLocalPermissionCounts: {
      allow: repoLocal?.permissions?.allow?.length ?? 0,
      deny: repoLocal?.permissions?.deny?.length ?? 0,
      ask: repoLocal?.permissions?.ask?.length ?? 0,
      bytes: sizeOf(path.join(REPO, '.claude', 'settings.local.json')),
    },
  },

  mcp: {
    globalServers: Object.keys(cfg.mcpServers ?? {}),
    repoServers: Object.keys(readJSON(path.join(REPO, '.mcp.json'))?.mcpServers ?? {}),
    enabledMcpjsonServers: userSettings.enabledMcpjsonServers ?? null,
    disabledMcpjsonServers: userSettings.disabledMcpjsonServers ?? null,
  },

  plugins: {
    installed: Object.keys(
      readJSON(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'))?.plugins ?? {},
    ),
    enabledMap: userSettings.enabledPlugins ?? null,
  },

  skills: {
    machineLevel: listDir(path.join(HOME, '.claude', 'skills')),
    repoLevel: listDir(path.join(REPO, '.claude', 'skills')),
    accountScoped_THIS_IS_THE_ONE_THAT_DIFFERS: accountSkills,
    skillOverrides: userSettings.skillOverrides ?? null,
  },

  agentsHooksCommands: {
    userAgents: listDir(path.join(HOME, '.claude', 'agents')),
    repoAgents: listDir(path.join(REPO, '.claude', 'agents')),
    userHooks: listDir(path.join(HOME, '.claude', 'hooks')),
    repoHooks: listDir(path.join(REPO, '.claude', 'hooks')),
    userCommands: listDir(path.join(HOME, '.claude', 'commands')),
    repoCommands: listDir(path.join(REPO, '.claude', 'commands')),
    userHookEvents: Object.keys(userSettings.hooks ?? {}),
    repoHookEvents: Object.keys(repoSettings.hooks ?? {}),
  },

  autoLoadedContext: (() => {
    const files = {
      'repo CLAUDE.md': path.join(REPO, 'CLAUDE.md'),
      'repo AGENTS.md': path.join(REPO, 'AGENTS.md'),
      'user CLAUDE.md': path.join(HOME, '.claude', 'CLAUDE.md'),
      'MEMORY.md': path.join(
        HOME,
        '.claude',
        'projects',
        'F--Phoenix-Workforce-phoenix-workforce',
        'memory',
        'MEMORY.md',
      ),
    };
    const out = {};
    let total = 0;
    for (const [k, p] of Object.entries(files)) {
      const b = sizeOf(p);
      out[k] = b;
      total += b ?? 0;
    }
    out.TOTAL_BYTES = total;
    out.APPROX_TOKENS_EVERY_REQUEST = Math.round(total / 3.6);
    return out;
  })(),

  git: {
    toplevel: sh(`git -C "${REPO}" rev-parse --show-toplevel`),
    branch: sh(`git -C "${REPO}" branch --show-current`),
    head: sh(`git -C "${REPO}" log -1 --oneline`),
    worktreeCount: (sh(`git -C "${REPO}" worktree list`) ?? '').split('\n').filter(Boolean).length,
  },

  terminalUi: {
    theme: userSettings.theme ?? null,
    statusLine: userSettings.statusLine ?? null,
    defaultShell: userSettings.defaultShell ?? null,
    TERM: process.env.TERM ?? null,
    TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
    WT_SESSION_present: Boolean(process.env.WT_SESSION),
    COLORTERM: process.env.COLORTERM ?? null,
    note: 'Font and font size are NOT Claude Code settings. In the desktop app they belong to the app. In a terminal they come from that terminal profile (Windows Terminal > Settings > Profiles > Appearance > Font face).',
  },

  envVarNamesOnly: Object.keys(process.env)
    .filter((k) => /^(CLAUDE|ANTHROPIC)/.test(k))
    .sort(),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const who = (snap.identity.desktopAppAccountEmail ?? snap.identity.cliConfigAccount ?? 'unknown').replace(
  /[^a-z0-9]+/gi,
  '-',
);
const file = path.join(OUT_DIR, `parity-${who}-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify(snap, null, 2));

console.log('\nSNAPSHOT WRITTEN');
console.log(`  ${file}`);
console.log(`\n  CLI config account : ${snap.identity.cliConfigAccount}`);
console.log(`  desktop app account: ${snap.identity.desktopAppAccountEmail ?? '(unresolved)'}`);
console.log(`  they AGREE         : ${snap.identity.AGREE}`);
console.log(`  plan tier          : ${snap.identity.subscriptionTier}`);
console.log(`  running exe        : ${snap.claudeCode.runningExecutable ?? '(cli)'}`);
console.log(`  npm global version : ${snap.claudeCode.npmGlobalVersion}`);
console.log(
  `  auto-loaded context: ~${snap.autoLoadedContext.APPROX_TOKENS_EVERY_REQUEST.toLocaleString()} tokens EVERY request`,
);
console.log(`  account-scoped skill sets seen: ${Object.keys(accountSkills).length}`);
console.log('\nNo credential, token, cookie or key was read or written.\n');
