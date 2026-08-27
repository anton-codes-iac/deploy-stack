FROM node:22-alpine

# 1. Set production environment (optimizes Node and prevents dev dependencies)
ENV NODE_ENV=production

WORKDIR /app

# 2. Copy dependency manifests with non-root ownership
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# 3. Copy application code with non-root ownership
COPY --chown=node:node . .

# 4. DevSecOps best practice: do not run the container as root
USER node

EXPOSE {{PORT}}

CMD ["npm", "start"]