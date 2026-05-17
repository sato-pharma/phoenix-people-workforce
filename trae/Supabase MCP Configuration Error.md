# Supabase MCP Configuration Error

> **Workspace:** f:\Phoenix Workforce\phoenix-workforce

---

## User
mcp.config.usrlocalmcp.supabase-mcp  Configuration error 
 { 
   "command": "" 
 } failed

## Assistant
That error means your MCP client is trying to start a **local/stdio** MCP server named `supabase-mcp`, but its config is invalid because `"command"` is an empty string.

You can fix it in either of these ways:

**Option A (Recommended): use the hosted Supabase MCP (no command needed)**
- Remove/disable the broken `usrlocalmcp.supabase-mcp` entry (the one with `"command": ""`).
- Keep (or add) a URL-based server entry for Supabase.
- This repo already has the correct hosted config in [.mcp.json](file:///f:/Phoenix%20Workforce/phoenix-workforce/.mcp.json):
  - `https://mcp.supabase.com/mcp`
- Reload the MCP servers list; if prompted, complete the Supabase OAuth sign-in in your browser.

**Option B: keep a local MCP server (fix the command)**
- Replace the empty command with a real command. On Windows, a safe default is:

```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--read-only",
        "--project-ref=<your-project-ref>"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "<your-supabase-personal-access-token>"
      }
    }
  }
}
```

- Node + npx are available on this machine (`node v24.15.0`, `npx 11.12.1`), so this should start once the config is saved and MCP is reloaded.

If you tell me where Trae stores `mcp.config.usrlocalmcp` on your setup (file path or a screenshot of that settings JSON), I’ll give you the exact edit for that file/section.

## User
failed

## User
The syntax of the command is incorrect. supabase

## Assistant
Removed the broken local MCP entry `supabase-mcp` from Trae’s user MCP config so Trae stops trying to launch a command-based server (the one erroring with `"command": ""`).

- Updated: `C:\Users\satoh\AppData\Roaming\Trae\User\mcp.json` (deleted only the `supabase-mcp` server entry; left your other MCP servers unchanged)
- Workspace Supabase MCP remains configured via [.mcp.json](file:///f:/Phoenix%20Workforce/phoenix-workforce/.mcp.json) as an HTTP server: `https://mcp.supabase.com/mcp`

**Next**
- In Trae, reload/restart the window (so it re-reads MCP configs).
- Open MCP servers/tools and you should see the workspace server named `supabase`.
- If it prompts auth, complete the Supabase OAuth sign-in in the browser, then reload once more.

## User
2026-05-18T00:18:54.180+03:00 [info] [mcp.config.usrlocalmcp.supabase-mcp] MCPClient#onStderr [Server Internal Log] The syntax of the command is incorrect. 
 
 2026-05-18T00:18:54.188+03:00 [error] [mcp.config.usrlocalmcp.supabase-mcp] MCPClient#onClose The syntax of the command is incorrect. 
 
 2026-05-18T00:18:54.188+03:00 [info] [mcp.config.usrlocalmcp.supabase-mcp] MCPServerManager#onClose Disconnected. 
 2026-05-18T00:18:54.188+03:00 [error] [mcp.config.usrlocalmcp.supabase-mcp] MCPClient#startFailed Connection closed 
 2026-05-18T00:18:54.188+03:00 [error] [mcp.config.usrlocalmcp.supabase-mcp] ExtHostMCPService#$start Fail to start

## User
connect supabase mcp

## Assistant
Fixed the `supabase-mcp` MCP server config so Trae uses the hosted Supabase MCP endpoint (HTTP) instead of a broken stdio command.

- Updated config: [mcp.json](file:///C:/Users/satoh/AppData/Roaming/Trae/User/mcp.json)
- `supabase-mcp` is now:

```json
"supabase-mcp": {
  "url": "https://mcp.supabase.com/mcp"
}
```

**Connect**
- Restart / Reload Trae window (important so it re-reads MCP configs).
- Open MCP Servers and connect `supabase-mcp`.
- Complete the Supabase OAuth login in the browser prompt, then reload once more.

**Sanity check**
- The endpoint is reachable; unauthenticated requests return `401` (expected) until you finish OAuth.

## User
2026-05-18T00:30:51.276+03:00 [error]  [mcp.config.usrlocalmcp.supabase-mcp] ExtHostMCPService#$start Fail to start

## Assistant
That `ExtHostMCPService#$start Fail to start` at `00:30:51` is a transient reconnect failure, not a config problem.

From your `mcp-servers-host.log`:

- `00:30:45` `supabase-mcp` **connected** and **listed tools successfully**
- `00:30:46` the HTTP “streamable” connection **closed**, then Trae retried
- `00:30:49` / `00:30:51` Trae tried `listTools` but had **“No client found”**, so it logged **“Fail to start”**
- `00:31:44` it **connected again** and listed tools successfully
- Later it reconnects again and is **connected** (log shows `MCPServerManager#start Connected.` at `00:34:24`)

**What to do**
- In Trae’s MCP Servers UI, click **Restart/Reconnect** for `supabase-mcp` (or just wait ~30–60s; it auto-retries).
- If it keeps flapping: restart the Trae window once, then reconnect `supabase-mcp` again (OAuth token is already present, so it should come up fast).

