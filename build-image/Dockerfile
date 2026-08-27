FROM oven/bun:1.4.0

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential clang \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENTRYPOINT ["bun"]
