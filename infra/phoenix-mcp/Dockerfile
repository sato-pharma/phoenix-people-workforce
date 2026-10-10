FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS build
WORKDIR /work/infra/phoenix-mcp
COPY infra/phoenix-mcp/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src /work/src
COPY infra/phoenix-mcp/src ./src
COPY infra/phoenix-mcp/build.mjs ./
RUN node build.mjs && npm prune --omit=dev --ignore-scripts

FROM public.ecr.aws/docker/library/node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /work/infra/phoenix-mcp/package.json ./
COPY --from=build --chown=node:node /work/infra/phoenix-mcp/node_modules ./node_modules
COPY --from=build --chown=node:node /work/infra/phoenix-mcp/dist/main.mjs ./dist/main.mjs
RUN mkdir /state && chown node:node /state && chmod 700 /state
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
