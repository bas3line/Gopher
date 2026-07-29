FROM oven/bun:1.3.14-alpine

WORKDIR /app

RUN apk add --no-cache fontconfig ttf-dejavu

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV XDG_CACHE_HOME=/tmp/.cache
USER bun

CMD ["bun", "src/index.ts"]
