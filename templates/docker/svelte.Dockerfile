# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:22-alpine AS builder
WORKDIR /app

# Install all dependencies (including devDependencies)
COPY package*.json ./
RUN npm ci

# Copy source code 
COPY . .

# ZERO-CLICK MAGIC: Automatically inject adapter-node if the user left adapter-auto in their config.
# This ensures the build/ directory is always generated without requiring manual code changes.
RUN npm install -D @sveltejs/adapter-node@latest && \
    sed -i 's/@sveltejs\/adapter-auto/@sveltejs\/adapter-node/g' svelte.config.js 2>/dev/null || true && \
    sed -i 's/@sveltejs\/adapter-auto/@sveltejs\/adapter-node/g' vite.config.ts 2>/dev/null || true && \
    sed -i 's/@sveltejs\/adapter-auto/@sveltejs\/adapter-node/g' vite.config.js 2>/dev/null || true

# Inject the bypass flag and compile the SvelteKit application
RUN DEPLOY_STACK_BYPASS=true npm run build

# ==========================================
# Stage 2: Production (Zero-CVE)
# ==========================================
FROM node:22-alpine

# 1. DevSecOps: Patch underlying Alpine OS vulnerabilities
RUN apk update && apk upgrade --no-cache

# 2. Set production environment
ENV NODE_ENV=production
WORKDIR /app

# 3. Copy manifests and install ONLY production dependencies
COPY --from=builder --chown=node:node /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 4. Copy the compiled SvelteKit server from the builder stage
COPY --from=builder --chown=node:node /app/build/ ./build/

# 5. DevSecOps: Nuke NPM completely to eliminate Trivy vulnerabilities
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE {{PORT}}

# 6. Execute the raw Node server directly
CMD ["node", "build/index.js"]