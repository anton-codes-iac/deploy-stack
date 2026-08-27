# Stage 1: Build the Nuxt Nitro output
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT={{PORT}}
ENV HOSTNAME="0.0.0.0"

# Create an unprivileged user and group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nuxtjs -u 1001 -G nodejs

# Copy the standalone output and assign ownership
COPY --from=builder --chown=nuxtjs:nodejs /app/.output ./.output

USER nuxtjs
EXPOSE {{PORT}}

CMD ["node", ".output/server/index.mjs"]