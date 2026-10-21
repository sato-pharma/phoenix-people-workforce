---
name: an-image-ref-in-root-directory-kills-every-production-build
description: "A production web build that dies in seconds with 'railpack prepare exited with an error' means the service's Root Directory is wrong — on 2026-10-20 it held an image ref (ghcr.io/…:a661f4dc7) left by an outage-workaround session; read serviceInstance.rootDirectory before anything else."
metadata:
  node_type: memory
  type: project
  originSessionId: 75aff5cb-ca9d-4545-a145-dee6ade795af
  modified: 2026-10-20T20:30:13.626Z
---

On 2026-10-20 at 23:20 Cairo, a `serviceInstanceDeployV2` deploy of `main` (834ab92d7) on the production web service `phoenix-people-workforce` FAILED twelve seconds in, with the build log reading only `using build driver railpack-v0.43.0` / `railpack prepare exited with an error`. The worker service built the same commit fine.

The cause was the service's **Root Directory** setting. It held `ghcr.io/gawish-1997/phoenix-people-workforce:a661f4dc7…`, an image address that the container-deploy session (`codex/container-deploy`, 22:35 Cairo, never opened as a PR) wrote while trying to route around Railway's build pause. With a root directory that does not exist, Railway cannot see the root `Dockerfile`, so it falls back to Railpack and fails at once. Every successful deploy before it built with the Dockerfile and an empty root directory.

**Why:** the build log names Railpack, not the root directory, so it reads like a builder or outage fault. Re-triggering the deploy only fails again the same way.

**How to apply:** when a production build dies at once with `railpack prepare exited`, read `serviceInstance(serviceId, environmentId){ builder rootDirectory source{repo image} }` through the Railway GraphQL API first. With the owner's word (he chose this in an MCQ that night), `serviceInstanceUpdate(… input:{ rootDirectory: null })` restores it. That update by itself started a fresh build, which used the Dockerfile and served at 23:27 Cairo. Never set Root Directory to an image ref, because the image route is a separate source (`source.image`), not a folder. Related: [[a-railway-build-outage-leaves-no-deployment-row]].
