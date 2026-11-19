# Server image: Node.js plus Chromium (from Microsoft's Playwright image).
# The Playwright tag must match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY server ./server

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "server/index.js"]
