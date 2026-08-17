FROM node:18-alpine
WORKDIR /app
# Next.js standalone setup requires outputting standalone in next.config.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE {{PORT}}
CMD ["node", "server.js"]