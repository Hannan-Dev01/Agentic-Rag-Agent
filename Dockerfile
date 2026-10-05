# --- deps: install with yarn ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile

# --- build ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Env vars are injected at runtime, not baked into the image.
RUN corepack enable && yarn build

# --- run: minimal standalone server ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# next.config output:"standalone" emits a self-contained server here.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
