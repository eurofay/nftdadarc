# Runs the Telegram bot 24/7. Deliberately a Dockerfile rather than relying on
# buildpack auto-detection: this repo's default `npm start` is the interactive
# CLI, which would idle forever on a server waiting for a prompt that never comes.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Card rendering loads these at runtime; without them text falls back to a
# serif face that isn't in the design.
COPY assets ./assets

# Wallets live here. This MUST be a mounted volume — see DEPLOY.md. On an
# ephemeral filesystem every redeploy silently destroys every stored wallet.
ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "dist/telegram-bot.js"]
