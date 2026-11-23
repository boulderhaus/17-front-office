FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
RUN npm run build && npm prune --omit=dev
# The owner app (React + Tailwind), served by the Node server from web/dist.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/web/dist ./web/dist
USER node
EXPOSE 8787
CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/src/server.js"]
