# Stage 1: Install dependencies and build the app
FROM node:22-alpine AS builder
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the Next.js application
# (This requires output: 'standalone' in next.config.ts)
RUN npm run build

# Stage 2: Production environment
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT={{PORT}}
ENV HOSTNAME="0.0.0.0"

# Create an unprivileged user and group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 -G nodejs

# Copy the standalone output and assign ownership to the unprivileged user
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Switch to the unprivileged user before executing
USER nextjs

EXPOSE {{PORT}}

# Start the standalone Node.js server
CMD ["node", "server.js"]