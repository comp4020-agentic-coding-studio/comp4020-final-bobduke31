# syntax = docker/dockerfile:1

# Plain Node 24, no build step: Node runs .ts files directly (erasable-syntax
# type stripping), so the image just needs the runtime deps and the source.
FROM node:24-alpine
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY public ./public
COPY README.md CREDITS.md ./

EXPOSE 8080
CMD ["node", "src/server.ts"]
