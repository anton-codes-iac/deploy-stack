# --- Stage 1: Build ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-alpine
# DevSecOps: Patch Alpine OS and update npm
RUN apk update && apk upgrade --no-cache && npm install -g npm@latest
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node --from=builder /app/dist ./dist
USER node
# Expose the port defined by Terraform
EXPOSE {{PORT}}
CMD ["node", "dist/main.js"]