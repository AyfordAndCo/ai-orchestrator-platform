FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.19.0

RUN corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && groupadd --gid 1000 orchestrator \
  && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin orchestrator

ENV CI=true
ENV HOME=/tmp

WORKDIR /workspace
USER 1000:1000

CMD ["pnpm", "validate"]
