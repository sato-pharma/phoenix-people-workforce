---
name: the-desktop-app-cannot-be-rolled-back-to-an-older-build
description: "The desktop app CAN be rolled back — api.anthropic.com's update feed serves any older build when you pass maxVersion, and Add-AppxPackage -ForceUpdateFromAnyVersion installs it in place without touching the data."
metadata:
  node_type: memory
  type: project
  originSessionId: 707bb928-9fd0-4d3a-ab38-72b7a1cad23c
  modified: 2026-10-15T16:59:26.465Z
---

**He wanted the pre-13-October app back on 2026-10-15. It IS possible — the title of this note is kept only because the earlier half of that session concluded the opposite and was wrong.** Three things make it work, and two blind alleys burned the first hour.

1. 🔴 **THE UPDATE FEED LIVES ON `api.anthropic.com`, NOT `claude.ai`, AND IT HONOURS `maxVersion`.** `https://api.anthropic.com/api/desktop/win32/x64/msix/update?device_id=<any>&version=<any>&os_version=10.0.26300&maxVersion=<the build you want>` returns that build's real download URL as JSON. The same path on `claude.ai` answers a **Cloudflare 403** to plain curl, which is what made a session conclude the feed was latest-only. Without `maxVersion` it returns the newest build (2.42304.0 on 15 Oct, while his app was still 2.37337.1).
2. 🔴 **THE PACKAGE URL CARRIES A COMMIT SHA, SO IT CANNOT BE GUESSED** — `https://downloads.claude.ai/releases/win32/x64/<version>/Claude-<40-hex>.msix` (2.31226.1 = `Claude-8576520051724193e9f74fc538f9ce8125e9ddd2.msix`). Guessing `.../Claude.msix` or a directory listing 404s **even for the version that is installed**, so a 404 there proves nothing about whether the build exists. Always read the URL out of the feed.
3. 🔴 **`Claude Setup.exe` FROM THE DOWNLOAD PAGE IS A 6.8 MB STUB THAT ALWAYS FETCHES THE CURRENT BUILD** — a Go binary (`main.installViaMSIX`, `main.msixDownloadURL`) that calls the same feed with no cap. He downloaded it believing it was the old version; installing it changed nothing because it re-fetched the build he already had. It is never the way to pin a version.
4. 🔒 **INSTALL IT IN PLACE — NEVER UNINSTALL FIRST.** `Add-AppxPackage -Path <msix> -ForceUpdateFromAnyVersion -ForceTargetApplicationShutdown` is the one flag that lets a LOWER version replace a higher one, and because Windows treats it as an update the package data survives. A plain double-click or a bare `Add-AppxPackage` fails (higher version already installed, or 0x80073D02 while the app runs) — and `Remove-AppxPackage` is what the GitHub reports blame for losing the sidebar and the session list. **The app must be closed**, so the command is his to run in his own terminal, not a session's.
5. **`autoUpdate.dangerousMaxVersion` is a forward cap, not a rollback.** Set it to the build he is actually running and `c4t()` disables updates while `u4t()` stays null, so nothing blocks. Set it BELOW the running build and the app shows `version-cap-block-dialog` and **refuses to open**. It is enterprise scope (`3p`), so on his account it may be inert — the honest fallback is re-running the downgrade, which is seconds once the msix is saved.

**Version history is in Sentry, nowhere else.** `~\AppData\Roaming\Claude\sentry\queue\*` carries `"release":"Claude@<version>"` plus the file's mtime: **2.19675.0 (4-6 Oct) → 2.26454.2 (8 Oct) → 2.31226.1 (11-12 Oct) → 2.37337.1 (13 Oct 20:45 Cairo)**. `config.json` keeps only `updaterLastSeenVersion`, and `version_first_launch` is rewritten to the current build, so it lies about first launch. The replaced package folder is deleted from `WindowsApps`, so disk is never the place to look.

**The install is a side-loaded MSIX** — `Claude_<ver>_x64__pzs8sxrjxfjjc`, `SignatureKind: Developer`, `CN="Anthropic, PBC"`. There is **no `%LOCALAPPDATA%\AnthropicClaude`**; a session that looks there wrongly reports the app is not installed. `Get-AppxPackage -Name Claude` reads it (`-AllUsers` fails with Access denied), and `C:\Program Files\WindowsApps\<package>` is readable by path even though its parent will not list.

**The terminal CLI is the other pre-update shape**: `claude` on PATH at `~\AppData\Roaming\npm\claude.cmd` is **2.1.293**, built 8 October. No turn box, and the suggestion box works, because the app is what mounts `mcp__ccd_turn__*` and drops the suggestion request ([[the-turn-box-took-the-ghost-text]]).

**Sizes, before offering a backup:** `Roaming\Claude` 11.9 GB, the package container 12 GB, `~\.claude` 10 GB — and **F: had 8.7 GB free**, so a full copy does not fit. The irreplaceable part is ~460 MB: `claude-code-sessions`, `local-agent-mode-sessions`, `side-session-notes`, `scratch-workspaces`, `Local Storage`, `IndexedDB` and the root `*.json`.
