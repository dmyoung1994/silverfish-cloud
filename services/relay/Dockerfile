FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci --workspace apps/desktop
COPY apps/desktop apps/desktop
RUN npm run build --workspace apps/desktop

FROM rust:1.96-alpine AS rust
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/protocol crates/protocol
COPY services/relay services/relay
COPY apps/desktop/src-tauri apps/desktop/src-tauri
RUN cargo build --release -p co-dex-relay

FROM alpine:3.22
RUN addgroup -S codex && adduser -S codex -G codex
WORKDIR /app
COPY --from=rust /src/target/release/co-dex-relay /usr/local/bin/co-dex-relay
COPY --from=web /src/apps/desktop/dist /app/web
USER codex
ENV CO_DEX_RELAY_ADDR=0.0.0.0:8787
ENV CO_DEX_WEB_DIR=/app/web
EXPOSE 8787
ENTRYPOINT ["co-dex-relay"]

