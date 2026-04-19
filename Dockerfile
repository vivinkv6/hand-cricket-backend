# ============================================
# Stage 1: Dependencies Installation Stage
# ============================================

ARG NODE_VERSION=24.13.0-slim

FROM node:${NODE_VERSION} AS dependencies

WORKDIR /app

COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ============================================
# Stage 2: Build NestJS application
# ============================================

FROM node:${NODE_VERSION} AS builder

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules

COPY . .

ENV NODE_ENV=production

RUN npm run build

# ============================================
# Stage 3: Run NestJS application
# ============================================

FROM node:${NODE_VERSION} AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5001

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

USER nodejs

EXPOSE 5001

# CLIENT_ORIGIN set via Coolify env var

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -qO- http://localhost:5001/ || exit 1

CMD ["node", "dist/main.js"]