FROM node:22-bookworm-slim AS build
ARG RELEASE_ID=local
LABEL org.opencontainers.image.revision=$RELEASE_ID
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git jq \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY flue.config.ts vite.config.ts tsconfig.json vitest.config.ts ./
COPY deploy/release.sh ./deploy/release.sh
COPY src ./src
COPY tests ./tests
RUN npm test && npm run check && npm run build

FROM node:22-bookworm-slim AS runtime
ARG RELEASE_ID=local
LABEL org.opencontainers.image.revision=$RELEASE_ID
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io git openssh-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY deploy/start.mjs ./deploy/start.mjs
ENV NODE_ENV=production PORT=3210
EXPOSE 3210
CMD ["node", "deploy/start.mjs"]
