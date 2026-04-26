FROM node:22.12-alpine AS builder

WORKDIR /app

ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

COPY package*.json ./

RUN npm ci

COPY . .

# Generate Prisma Client during build
RUN npx prisma generate --schema=./prisma/schema.prisma

RUN npm run build

FROM node:22.12-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5001
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

COPY --from=builder /app/package*.json ./

RUN npm ci --include=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=builder /app/dist ./app/dist
COPY --from=builder /app/prisma ./app/prisma
COPY --from=builder /app/prisma.config.ts ./app/
COPY --from=builder /app/node_modules/.prisma ./app/node_modules/.prisma

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:5001/ || exit 1

CMD node dist/main.js