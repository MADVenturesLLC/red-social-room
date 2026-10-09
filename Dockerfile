# Red Social Room app (A1). Untested in Docker on the build box (no Docker there); see README "Run the app".
FROM node:22.19-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.19-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RSR_DATA_DIR=/data \
    RSR_APP_ROOT=/app \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=build /app/package.json /app/next.config.mjs ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/config ./config
# The 10 spike rows are imported into the spend ledger on first start (Amendment 1 item 18; the A1 smoke-call
# seed row is bundled into .next, A1 pin 14).
COPY --from=build /app/spike-results/ledger.json ./spike-results/ledger.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
# Inside the container the app must listen on 0.0.0.0 so Docker can forward to it; compose.yaml publishes the
# port on the host's 127.0.0.1 only (Argus M1 on fa3d359). Same as `npm run start:container`. Outside Docker,
# `npm start` binds 127.0.0.1.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
