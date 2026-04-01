FROM node:25-slim

LABEL org.opencontainers.image.title="Engram" \
      org.opencontainers.image.description="Persistent memory system for AI agents" \
      org.opencontainers.image.url="https://codeberg.org/GhostFrame/engram" \
      org.opencontainers.image.source="https://codeberg.org/GhostFrame/engram" \
      org.opencontainers.image.documentation="https://codeberg.org/GhostFrame/engram" \
      org.opencontainers.image.licenses="Elastic-2.0" \
      org.opencontainers.image.vendor="Syntheos"

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy app files
COPY server.ts ./
COPY src/ ./src/
COPY sign/ ./sign/
COPY engram-gui.html engram-login.html ./

# Data volume
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 4200

ENV ENGRAM_PORT=4200
ENV ENGRAM_HOST=0.0.0.0

CMD ["node", "--experimental-strip-types", "server.ts"]
