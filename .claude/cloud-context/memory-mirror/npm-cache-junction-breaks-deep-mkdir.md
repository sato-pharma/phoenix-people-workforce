---
name: npm-cache-junction-breaks-deep-mkdir
description: "npm installs failed with \"tarball seems to be corrupted\" then ENOENT mkdir _cacache\\tmp because the npm cache sat behind a C:→D: junction; fixed by pointing npm's cache straight at D: in ~/.npmrc"
metadata:
  node_type: memory
  type: project
  originSessionId: 064562b1-9f20-4a2a-907e-cfb2495337fd
  modified: 2026-11-13T12:32:30.188Z
---

On 2026-11-12 08:50 `C:\Users\satoh\AppData\Local\npm-cache` became a JUNCTION to `D:\C-Offload\Local\npm-cache` (disk offload). On Node 24, `fs.mkdirSync(..., {recursive:true})` creating two or more missing levels THROUGH that junction fails with ENOENT (one level works; the same depth directly on D: works). npm's cacache nests folders, so every `npm ci` failed: tarballs reported "seems to be corrupted", then `ENOENT mkdir ...\_cacache\tmp`.

Fixed 2026-11-13 ~13:25 Cairo: `npm config set cache D:\C-Offload\Local\npm-cache --location=user` (~/.npmrc), proved by `npm cache add` + `npm cache verify`.

**Re-probed 2026-11-13 ~15:00 Cairo, all 35 C:→D: junctions:** the npm-cache junction now passes at every depth (the fault came and went). The five under `AppData\Local\Programs` (Python, Microsoft VS Code, Trae, TRAE SOLO, ai.opencode.desktop) refuse EVERY new folder — even one level — with Windows error 183 "already exists" for Node, Python and cmd alike, while new FILES work and the same mkdir straight on D: works. So `pip install` into Python 3.13 and those editors' self-updates cannot create folders. The 25 others pass; the four under C:\Program Files answer EPERM on C: and D: alike (admin rights, not the fault). **Fixed the same day on his choice ("Move all five back to C:")**: each copied back to its real `AppData\Local\Programs\<name>` folder, file count and bytes matched, junction removed, new folders proved creatable; Python 3.13 and pip run from C:. On his word ("delete the five old program copies on D:") the D:\C-Offload\Programs copies were removed (5.98 GB freed); their 1,929 HTML/SVG/PDF program files were MOVED ASIDE, never deleted, to `D:\C-Offload\_documents-kept-from-program-copies-2026-11-13` (127 MB).

**Why:** the other folders moved to D: on 12 Nov use the same junction kind; any Node tool that creates deep folders through one can fail the same way.
**How to apply:** an ENOENT mkdir from a Node tool under AppData\Local → check `Get-Item <path>` LinkType=Junction first; point the tool at the D: target, never delete the cache.
