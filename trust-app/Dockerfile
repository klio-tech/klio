# Multi-stage build for the Klio trust-app.
#
# Stage 1 (deps): install everything needed to run `next build`,
# including dev deps. Cached on package*.json changes.
#
# Stage 2 (build): copy source, run `next build`. Produces
# .next/standalone (a self-contained server bundle) and .next/static
# (static assets). The standalone build is what ships.
#
# Stage 3 (runner): minimal runtime — copies only the standalone
# output, the static assets, and the public/ directory. Runs as
# the non-root `nextjs` user. Listens on PORT (default 3000).
#
# Total image size with this layout is ~150 MB vs ~600 MB if we
# shipped the full repo + node_modules.

FROM node:20-alpine AS deps
WORKDIR /app
# Next.js 16 + React 19 (stable) resolve cleanly under strict
# peer-dep mode, so no .npmrc workaround is needed.
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Build target — `local` (npm-launched user dashboard) or `public`
# (klio.tech marketing site). Both share this Dockerfile; the
# matching route group ships in each image. The bundle-isolation
# test below greps the standalone bundle for cross-target string
# leaks and fails the build if the wrong route group made it in.
ARG KLIO_BUILD_TARGET=local
ENV KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET}

RUN npm run build
RUN npm run test:bundle-isolation

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Create non-root user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Copy the standalone server bundle (includes its own minimal
# node_modules) and static assets.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
