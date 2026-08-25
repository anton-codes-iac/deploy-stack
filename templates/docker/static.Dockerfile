# STAGE 1: Build the static assets
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
# Use clean install for reliable, reproducible builds
RUN npm ci

COPY . .
# Runs the standard build script defined in package.json
RUN npm run build

# STAGE 2: Serve with Hardened Nginx
FROM nginx:alpine

# ⚠️ CRITICAL: Adjust 'dist' to match your framework's output folder!
# Vite/Astro = dist | Create React App/Gatsby = build | Next.js Static = out
COPY --from=builder /app/dist /usr/share/nginx/html

# Dynamically update the Nginx port
RUN sed -i "s/listen       80;/listen       {{PORT}};/g" /etc/nginx/conf.d/default.conf

# Silence unprivileged user directive warning in main config
RUN sed -i 's/^user\s\+nginx;/# user nginx;/' /etc/nginx/nginx.conf

# DevSecOps Hardening: Drop root privileges for the Nginx process
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    chown -R nginx:nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE {{PORT}}
CMD ["nginx", "-g", "daemon off;"]