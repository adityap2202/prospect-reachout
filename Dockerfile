FROM node:20-bullseye-slim

WORKDIR /app

# Native deps for better-sqlite3 (in case prebuild isn't available)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/

RUN npm ci
RUN npm ci --prefix client

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Railway injects PORT at runtime; do not hardcode it here.
# EXPOSE is informational only, but keep 3001 as local default.
EXPOSE 3001

CMD ["npm", "start"]

