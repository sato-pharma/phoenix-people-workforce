FROM node:24-alpine AS base

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

# CACHE KEY (do not reorder): cloudbuild.yaml builds this `deps` stage alone and
# pushes it as $_CACHE_REPO:deps-cache. This COPY is what keys that layer — it
# must name pnpm-lock.yaml (NOT package-lock.json, which no longer exists) plus
# pnpm-workspace.yaml (overrides + allowBuilds change resolution/build behavior),
# so the expensive install below is reused until one of these three files changes.
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
ENV NEXT_TELEMETRY_DISABLED 1

# NEXT_PUBLIC_* values are inlined into the client bundle at `next build` time, not read
# from the container's runtime env, so they must arrive as --build-arg (see cloudbuild.yaml
# — gcloud run deploy --source's --set-build-env-vars only reaches the build when Cloud
# Build picks the Buildpacks path; a Dockerfile like this one gets a plain `docker build`
# with no --build-arg at all unless the caller passes it explicitly). Declared here and
# re-exported as ENV so `RUN pnpm run build` below can see them.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
ARG NEXT_PUBLIC_SMI_USE_FACT_TABLES
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ENV NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
ENV NEXT_PUBLIC_SMI_USE_FACT_TABLES=$NEXT_PUBLIC_SMI_USE_FACT_TABLES
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL

# SENTRY_AUTH_TOKEN (source-map upload auth) is deliberately NOT an ARG/ENV like the
# NEXT_PUBLIC_* values above — those persist in image layer history (including the
# :deps-cache/:latest-cache tags cloudbuild.yaml pushes to Artifact Registry), which
# would leak a real credential into a long-lived cached image. A BuildKit secret mount
# only exists for this one RUN step and is never written to any layer. Missing/empty
# is fine (Sentry's webpack plugin just skips the source-map upload without one).
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" pnpm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

# Chromium + fonts for server-side PDF generation of offer letters (puppeteer-core drives this
# system Chromium — we deliberately do NOT bundle Puppeteer's own Chromium, which is a glibc
# binary that cannot run on Alpine/musl). puppeteer-core reads PUPPETEER_EXECUTABLE_PATH.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont
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
# import so it never enters a client bundle), so install it — JS only — into the runtime
# node_modules for server-side offer-letter PDF generation. Chromium itself is the system
# package installed above; PUPPETEER_SKIP_DOWNLOAD prevents a browser download. Installed in a
# temp dir and merged in so the existing traced node_modules is not pruned. Keep the version in
# sync with package.json.
# DELIBERATELY still npm (repo package manager is pnpm): this is an isolated throwaway
# install of ONE pinned package into /tmp with its own generated package.json — no repo
# lockfile or workspace settings are involved, npm ships inside node:24-alpine anyway,
# and pnpm here would need corepack + a store for zero benefit in this final image layer.
RUN cd /tmp && npm init -y >/dev/null 2>&1 \
 && npm install --omit=dev puppeteer-core@23.11.1 >/dev/null 2>&1 \
 && cp -R /tmp/node_modules/. /app/node_modules/ \
 && rm -rf /tmp/node_modules /tmp/package.json /tmp/package-lock.json

USER nextjs

EXPOSE 8080

ENV PORT 8080
# set hostname to 0.0.0.0
ENV HOSTNAME "0.0.0.0"

CMD ["node", "server.js"]
