# Grada MCP bridge: serves the Streamable HTTP transport for tunnels
# (e.g. Custom GPT Actions) and container hosts.
# NOTE: the HTTP transport has no authentication — never expose this
# container directly to the internet; put it behind a trusted tunnel
# or an authenticated reverse proxy.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src/ ./src/
COPY bin/ ./bin/

# Telemetry degrades silently without an injected key (see publish.yml),
# so the bridge runs fine from a plain checkout.
EXPOSE 3000

CMD ["node", "bin/cli.js", "mcp", "--transport", "http", "--port", "3000", "--host", "0.0.0.0"]
