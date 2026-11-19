import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// The topbar's click-to-open panels load their own code on first use (19 Nov 2026).
//
// The notifications list, the messages panel with "My email", and the desk calculator were
// mounted with the topbar on every signed-in page, so every page view downloaded and parsed all
// of them before anyone clicked. Each is now two files: the trigger, which stays with the page
// (the button, the unread count and the background checks behind it), and the panel body, which
// is a separate chunk fetched when the page goes idle, on hover or focus, or on the click.
//
// What would quietly undo it, and what this pins:
//   • one static import of a panel body, anywhere, pulls the chunk back into the page;
//   • a loader with no `.catch` turns a stale tab after a deploy into a page error;
//   • a badge moved into the body would show nothing until the panel had been opened once.
// lazy-topbar-panel.tsx holds the three rules in words.
// ─────────────────────────────────────────────────────────────────────────────

function readSource(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const PANELS = [
  {
    body: "calculator-panel",
    exportName: "CalculatorPanel",
    failure: "CalculatorLoadFailed",
    loader: "loadCalculatorPanel",
    trigger: "src/components/layout/calculator-widget.tsx",
  },
  {
    body: "in-app-notifications-panel",
    exportName: "InAppNotificationsPanel",
    failure: "NotificationsPanelLoadFailed",
    loader: "loadNotificationsPanel",
    trigger: "src/components/layout/in-app-notifications-bell.tsx",
  },
  {
    body: "internal-messages-panel",
    exportName: "InternalMessagesPanel",
    failure: "MessagesPanelLoadFailed",
    loader: "loadMessagesPanel",
    trigger: "src/components/layout/internal-messages-menu.tsx",
  },
] as const;

export function runTopbarLazyPanelsTests() {
  // ── 1. Each trigger loads its body through next/dynamic, with a caught failure ───────────────
  for (const panel of PANELS) {
    const trigger = codeOnly(readSource(panel.trigger));
    const where = panel.trigger;
    assert.match(trigger, /import dynamic from "next\/dynamic";/, `${where}: the panel body loads through next/dynamic`);
    assert.ok(
      trigger.includes(`const ${panel.loader} = () => import("@/components/layout/${panel.body}");`),
      `${where}: one loader, ${panel.loader}, imports the body on demand`,
    );
    const dynamicCall = new RegExp(
      `dynamic<\\w+>\\(\\s*\\(\\) =>\\s*${panel.loader}\\(\\)\\s*\\.then\\(\\(mod\\) => mod\\.${panel.exportName}\\)\\s*\\.catch\\(\\(\\) => ${panel.failure}\\),`,
    );
    assert.match(
      trigger,
      dynamicCall,
      `${where}: a failed load must fall back to ${panel.failure} — thrown, a tab left open across a deploy replaces the whole page with the error screen`,
    );
    assert.match(trigger, /ssr: false/, `${where}: the body is never rendered on the server, so it is never in the page's first paint`);
    assert.ok(
      trigger.includes(`useEffect(() => preloadWhenIdle(${panel.loader}), []);`),
      `${where}: the body is fetched once the page is idle, so the first click finds it already loaded`,
    );
    assert.ok(
      trigger.includes(`onPointerEnter={() => preloadPanel(${panel.loader})}`) &&
        trigger.includes(`onFocus={() => preloadPanel(${panel.loader})}`),
      `${where}: hover and keyboard focus start the fetch ahead of the click`,
    );
  }

  // ── 2. No static import of a panel body, anywhere ─────────────────────────────────────────────
  // `import type` is erased at build time and costs nothing; any other import of the body puts its
  // code back into every page that draws the topbar.
  const bodies = PANELS.map((panel) => panel.body);
  const staticImports: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("app")]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"@\/components\/layout\/([\w-]+)";/gm)) {
      if (!match[1] && (bodies as readonly string[]).includes(match[2])) staticImports.push(`${file} → ${match[2]}`);
    }
  }
  assert.deepEqual(staticImports, [], "a panel body must never be imported statically; load it through its trigger's next/dynamic loader");

  // "My email" travels with the messages body, never with the envelope.
  const menu = codeOnly(readSource("src/components/layout/internal-messages-menu.tsx"));
  assert.match(
    menu,
    /import type \{ PersonalMailboxOpenRequest \} from "@\/components\/layout\/personal-mailbox-panel";/,
    "the envelope takes only the mailbox's TYPE; the mailbox panel itself loads with the messages body",
  );

  // ── 3. The counts stay with the page ──────────────────────────────────────────────────────────
  const bell = codeOnly(readSource("src/components/layout/in-app-notifications-bell.tsx"));
  assert.match(bell, /subscribePulseNotices\(/, "the bell's list still rides the session pulse from the page itself");
  assert.match(bell, /\{unreadCount > 99 \? "99\+" : unreadCount\}/, "the bell's unread count is drawn by the trigger, before the panel ever loads");
  assert.match(bell, /clearAll: true/, "clear all is the bell's own call, so it never waits for the body");
  assert.match(menu, /subscribePulseNotices\(/, "the envelope's count still rides the session pulse from the page itself");
  assert.match(menu, /usePersonalMailboxAlerts\(/, "the mailbox unread watch runs from the envelope, not the body");
  // The badge's own text, not the button's aria-label, which also names `${badgeLabel}`.
  assert.match(menu, />\s*\{badgeLabel\}\s*<\/span>/, "the envelope's unread count is drawn by the trigger");
  assert.match(menu, /const \[form, setForm\] = useState<InternalMessageForm>\(emptyForm\);/, "a half-typed message lives in the envelope, so closing the panel keeps it");
  const calculator = codeOnly(readSource("src/components/layout/calculator-widget.tsx"));
  assert.match(
    calculator,
    /\{opened \? <CalculatorPanel isAdminMode=\{isAdminMode\} onClose=\{close\} open=\{open\} \/> : null\}/,
    "the calculator stays mounted after its first open, so the figure on its display survives closing it",
  );

  // ── 4. The shared rules ───────────────────────────────────────────────────────────────────────
  const lazy = codeOnly(readSource("src/components/layout/lazy-topbar-panel.tsx"));
  assert.match(lazy, /window\.requestIdleCallback\(run, \{ timeout: IDLE_TIMEOUT_MS \}\)/, "the preload waits for an idle moment, with a deadline");
  assert.match(lazy, /window\.setTimeout\(run, IDLE_FALLBACK_MS\)/, "a browser with no idle callback still preloads, after a short wait");
  assert.match(lazy, /return \(\) => window\.cancelIdleCallback\(handle\);/, "a trigger that unmounts cancels its preload");
  assert.match(lazy, /onClick=\{\(\) => window\.location\.reload\(\)\}/, "the failure offers a reload, which fetches the build that is serving now");
  for (const name of ["in-app-notifications-bell", "internal-messages-menu"]) {
    const trigger = codeOnly(readSource(`src/components/layout/${name}.tsx`));
    assert.match(trigger, /loading: \(\) => <TopbarPanelLoading \/>/, `${name}: the open panel shows a loading line, never a blank box, while its body arrives`);
  }
  for (const panel of PANELS) {
    const body = readSource(`src/components/layout/${panel.body}.tsx`);
    assert.ok(body.startsWith('"use client";'), `${panel.body}: a client component, like the trigger that loads it`);
    assert.doesNotMatch(
      body,
      new RegExp(`from "@/components/layout/${panel.trigger.split("/").pop()!.replace(".tsx", "")}"`),
      `${panel.body}: the body never imports its own trigger`,
    );
  }
}
