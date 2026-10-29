# Dedicated disposable qualification image; never deploy this as production.
FROM node:22.18-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /srv/devhub
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run db:generate
# Next compilation is performed by the api service after its isolated test DB is up.
