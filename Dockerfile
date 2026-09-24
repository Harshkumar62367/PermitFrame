# PermitFrame on Render (web service, Starter+).
# Native Node runtimes don't guarantee an SSH client, and the app reaches
# its DKG edge node over SSH — so we ship an explicit image instead.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Public-only build input: Next.js inlines NEXT_PUBLIC_* values at compile
# time, so the public Privy app id must be visible to the builder (passed as
# a Docker build arg, never baked from a secret file). Every sensitive value
# (PRIVY_APP_SECRET, database URLs, DKG SSH key, Cloudinary credentials, ...)
# stays runtime-only and must never gain an ARG/ENV here.
ARG NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
EXPOSE 10000
# Next honours $PORT; Render injects it (default 10000).
CMD ["sh", "-c", "npm start -- --port ${PORT:-10000}"]
