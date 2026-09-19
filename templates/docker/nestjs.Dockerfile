# --- Stage 1: Build ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-alpine

# 1. DevSecOps: Patch Alpine OS
RUN apk update && apk upgrade --no-cache

ENV NODE_ENV=production
WORKDIR /app

# 2. Install ONLY production dependencies
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 3. DevSecOps: Nuke all package managers to eliminate base-image CVEs
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# 4. Copy the compiled application
COPY --chown=node:node --from=builder /app/dist ./dist

USER node
# Expose the port defined by Terraform
EXPOSE {{PORT}}
CMD ["node", "dist/main.js"]