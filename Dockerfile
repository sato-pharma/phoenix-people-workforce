# 🔴 THE BASE IMAGE IS PULLED FROM A MIRROR, NOT FROM DOCKER HUB, AND MUST STAY THAT WAY.
# On 2026-10-09 four consecutive merges to main failed to deploy — #5711, #5712, #5713, #5714,
# 23:43 to 23:58 Cairo — every one of them on the same line:
#   failed to solve: node:24-alpine: failed to resolve source metadata for
#   docker.io/library/node:24-alpine: 429 Too Many Requests
# Railway builds on shared metal, so the anonymous Docker Hub pull limit belongs to the builder's IP
# and not to this project: nothing in the repository was wrong, the merges were green, and production
# simply stopped moving while the service kept serving the previous revision. Four code and docs
# changes sat merged-but-not-live with nothing red anywhere except the Railway build log.
# public.ecr.aws/docker/library/* is AWS's copy of the Docker Official Images and does not fall back
# to Docker Hub, so a Hub rate limit cannot reach this build. It is the SAME image, proven by digest
# on 2026-10-09: Docker Hub, mirror.gcr.io and public.ecr.aws all answered
# sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 for 24-alpine.
# Pinned by tests/railway-deploy-config.test.ts in the required `validate` job.
#
# 🔴 AND IT IS PINNED BY DIGEST, NOT BY TAG ALONE (audit F-22 / S-INT-16, 2026-10-23). `24-alpine` is a
# moving tag: the image behind it changes whenever Node or Alpine ships a patch, so two builds of the same
# commit could run different bases with nothing in the repository saying so. The tag stays for the reader;
# the digest is what is pulled. Read 2026-10-23 from public.ecr.aws, Docker Hub and mirror.gcr.io — all three
# answered the same multi-arch index digest below. To move it on purpose, read the tag's current digest
#   docker buildx imagetools inspect public.ecr.aws/docker/library/node:24-alpine
# and replace the digest here. Pinned by tests/dockerfile-reproducible.test.ts.
FROM public.ecr.aws/docker/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# corepack (bundled with node:24) provisions the exact pnpm pinned in
# package.json's `packageManager` field — no separately-maintained version here.
# These two layers are deliberately BEFORE the COPY so they stay cached across
# lockfile changes; the actual pnpm download happens inside the install layer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# CACHE KEY (do not reorder): this COPY is what keys the `deps` layer — it must name
# pnpm-lock.yaml (NOT package-lock.json, which no longer exists) plus pnpm-workspace.yaml
# (overrides + allowBuilds change resolution/build behavior), so the expensive install below
# is reused until one of those three files changes.
#
# The rule OUTLIVED the reason it was written for. It was originally about cloudbuild.yaml,
# which built this stage alone and pushed it as $_CACHE_REPO:deps-cache; that file and the
# whole Cloud Run path were deleted 2026-09-08 (docs/deployment.md). Railway builds this same
# Dockerfile and caches layers the same way, so reordering still throws away the install —
# do not read the dead reference as licence to rearrange these lines.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Copy package.json first and bake the pinned pnpm into its own cached layer
# (`corepack install` reads packageManager) so `pnpm run build` below does not
# re-download pnpm on every source change.
COPY package.json ./
RUN corepack enable && corepack install
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are inlined into the client bundle at `next build` time, not read from
# the container's runtime env, so they must arrive as --build-arg. Declared here and re-exported
# as ENV so `RUN pnpm run build` below can see them.
#
# This is the trap the removed Cloud Run comment used to describe, and it is NOT specific to
# GCP: a builder that sets these as runtime variables leaves them undefined at build time, and
# the app ships with an empty NEXT_PUBLIC_* baked into the client bundle — no build error, just
# a broken value in the browser. Railway passes its service variables as build args for a
# Dockerfile build, which is why this works there; anything else must pass them explicitly.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
ARG NEXT_PUBLIC_SMI_USE_FACT_TABLES
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_ONESIGNAL_APP_ID
# Sentry (sentry.io) browser DSN — production only. Empty on any service that does not set it, which is the OFF switch:
# sentry-client.ts also refuses to start anywhere but the production host.
ARG NEXT_PUBLIC_SENTRY_DSN
# 🔴 NO `NEXT_PUBLIC_COMMIT_SHA` HERE, AND RE-ADDING ONE WOULD TAG NOTHING. It sat in this list as an inert slot — declared,
# re-exported, and read by ZERO call sites across src/, app/ and lib/ — under a comment claiming it tagged which revision a client
# error came from. It never did: what identifies a release is `getDeployRevision()` in src/lib/observability/deploy-identity.ts,
# reading the NON-prefixed COMMIT_SHA || RAILWAY_GIT_COMMIT_SHA || K_REVISION, server-side. Removed 2026-09-30 with its
# docs/environment.md row. Client-side release tagging needs a CALL SITE first; the ARG is the last step, not the first.
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ENV NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
ENV NEXT_PUBLIC_SMI_USE_FACT_TABLES=$NEXT_PUBLIC_SMI_USE_FACT_TABLES
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_ONESIGNAL_APP_ID=$NEXT_PUBLIC_ONESIGNAL_APP_ID
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Sentry source maps and release — BUILD-TIME ONLY. next.config.ts runs the upload plugin solely when
# SENTRY_AUTH_TOKEN is non-empty, so a service that sets none builds exactly as before. These ARGs are not
# re-exported into the runner stage below, so the token never reaches the running image. The commit sha is what
# names the release; Railway passes it as a build arg, and an empty value just leaves the release unnamed.
ARG SENTRY_AUTH_TOKEN
ARG RAILWAY_GIT_COMMIT_SHA
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA

RUN pnpm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Chromium + fonts for server-side PDF generation of offer letters (puppeteer-core drives this
# system Chromium — we deliberately do NOT bundle Puppeteer's own Chromium, which is a glibc
# binary that cannot run on Alpine/musl). puppeteer-core reads PUPPETEER_EXECUTABLE_PATH.
#
# ARABIC FONTS ARE NOT OPTIONAL HERE, and their absence does not look like a missing font.
# ttf-freefont carries Arabic CODEPOINTS but does not SHAPE them, so Chromium drew every letter in
# its isolated form and the words came apart into separate letters. The metrics are wrong too: a
# three-page employment contract was filed as SIXTEEN pages. Neither symptom names a font, which
# is why this reached a contract a person was meant to sign before anyone noticed.
#
# Noto covers both halves: Arabic for the papers, and Latin so a name or a figure inside them is
# not a different face from the rest of the line.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-arabic
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The Next standalone trace omits puppeteer-core (it is loaded via a turbopackIgnore dynamic
# import so it never enters a client bundle), so it is installed — JS only — into the runtime
# node_modules for server-side offer-letter PDF generation. Chromium itself is the system
# package installed above; PUPPETEER_SKIP_DOWNLOAD prevents a browser download. It had once
# drifted two majors (23.11.1 here against ^25.3.0 in package.json) by the time anything called
# puppeteer, so production would have run a driver nobody ever tested this code against.
#
# sharp is installed by the same step — but it failed differently, so read this before changing
# it. The standalone trace DID copy sharp's JS and its `@img/sharp-linuxmusl-x64` binding; what it
# left behind was `@img/sharp-libvips-linuxmusl-x64`, which ships the `libvips-cpp.so` that the
# binding links against. A JS tracer follows imports, and a DT_NEEDED entry inside a compiled .so
# is not an import — so the trace looked complete and the module threw ERR_DLOPEN_FAILED at
# runtime instead. That took down the whole Hiring Documents page on 2026-08-22, because a
# top-level `import sharp` sat on its render path (now loaded on demand, see
# src/lib/hiring-documents/document-scan.ts). Two live features need it: direct-order invoice
# extraction and hiring-document scanning. Removing the traced copies first matters — copying over
# a pnpm symlink writes THROUGH it into the store instead of replacing it, and leaves the broken
# resolution in place.
#
# 🔴 REPRODUCIBLE, FROM A COMMITTED LOCKFILE (audit F-22 / S-INT-16, 2026-10-23). This used to be
# two `npm install <package>@<hand-typed version>` lines with no lockfile, so every transitive
# package floated to whatever npm served on the day of the build, and the comment here claimed
# "in sync with pnpm-lock.yaml" while the lockfile had already moved sharp two patch releases and
# puppeteer-core two minor releases past the hand-typed pins (no version is written in this file
# any more — the test refuses one). Now `npm ci` installs exactly infra/runtime-extras/package-lock.json —
# every package, transitive ones included, pinned by version and integrity hash. The two direct
# versions MUST equal the ones pnpm-lock.yaml resolves (what every test and the dev server run
# against): tests/dockerfile-reproducible.test.ts fails the required checks the moment they differ,
# and `node scripts/sync-runtime-extras.mjs` rewrites both files from pnpm-lock.yaml.
# DELIBERATELY npm (the repo package manager is pnpm): an isolated install of two packages into
# /tmp, npm ships inside node:24-alpine, and pnpm here would need corepack + a store for zero
# benefit in this final image layer.
COPY infra/runtime-extras/package.json infra/runtime-extras/package-lock.json /tmp/runtime-extras/
RUN cd /tmp/runtime-extras \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
 && rm -rf /app/node_modules/sharp /app/node_modules/@img \
 && cp -R /tmp/runtime-extras/node_modules/. /app/node_modules/ \
 && rm -rf /tmp/runtime-extras

# Fail the BUILD if sharp still cannot load, rather than discovering it as a 500 in production —
# which is exactly how the 2026-08-22 outage was found. This is the check that would have caught it.
RUN cd /app && node -e "const s=require('sharp'); s({create:{width:1,height:1,channels:3,background:'#000'}}).jpeg().toBuffer().then(()=>console.log('sharp loads and encodes OK'))"

USER nextjs

EXPOSE 8080

ENV PORT=8080
# set hostname to 0.0.0.0
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
