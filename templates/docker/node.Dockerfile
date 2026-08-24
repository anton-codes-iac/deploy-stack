FROM node:20-alpine

# 1. Set production environment (optimizes Node and prevents dev dependencies)
ENV NODE_ENV=production

WORKDIR /app

# 2. Copy only dependency files first to cache the npm install layer
COPY package*.json ./

# 3. Use npm ci for strict, deterministic, and faster CI/CD installs
RUN npm ci

# 4. Copy the rest of the application source code
COPY . .

# 5. DevSecOps best practice: do not run the container as root
USER node

EXPOSE {{PORT}}

CMD ["npm", "start"]