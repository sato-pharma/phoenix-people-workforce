---
name: npm-cache-junction-breaks-deep-mkdir
description: "npm installs failed with \"tarball seems to be corrupted\" then ENOENT mkdir _cacache\\tmp because the npm cache sat behind a C:→D: junction; fixed by pointing npm's cache straight at D: in ~/.npmrc"
metadata:
  node_type: memory
  type: project
  originSessionId: 064562b1-9f20-4a2a-907e-cfb2495337fd
  modified: 2026-11-13T11:18:59.250Z
---

On 2026-11-12 08:50 `C:\Users\satoh\AppData\Local\npm-cache` became a JUNCTION to `D:\C-Offload\Local\npm-cache` (disk offload). On Node 24, `fs.mkdirSync(..., {recursive:true})` creating two or more missing levels THROUGH that junction fails with ENOENT (one level works; the same depth directly on D: works). npm's cacache nests folders, so every `npm ci` failed: tarballs reported "seems to be corrupted", then `ENOENT mkdir ...\_cacache\tmp`.

Fixed 2026-11-13 ~13:25 Cairo: `npm config set cache D:\C-Offload\Local\npm-cache --location=user` (~/.npmrc), proved by `npm cache add` + `npm cache verify`.

**Why:** the other folders moved to D: on 12 Nov use the same junction kind; any Node tool that creates deep folders through one can fail the same way.
**How to apply:** an ENOENT mkdir from a Node tool under AppData\Local → check `Get-Item <path>` LinkType=Junction first; point the tool at the D: target, never delete the cache.
