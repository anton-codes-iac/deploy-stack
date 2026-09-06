FROM node:22-alpine

# 1. DevSecOps: Patch underlying Alpine OS vulnerabilities and update global npm
RUN apk update && apk upgrade --no-cache && \
    npm install -g npm@latest

# 2. Set production environment (optimizes Node and prevents dev dependencies)
ENV NODE_ENV=production

WORKDIR /app

# 3. Copy dependency manifests with non-root ownership
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# 4. Copy application code with non-root ownership
COPY --chown=node:node . .

# 5. DevSecOps best practice: do not run the container as root
USER node

EXPOSE {{PORT}}

CMD ["npm", "start"]