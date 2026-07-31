# syntax=docker/dockerfile:1

FROM postgres:17-alpine

ARG PGVECTOR_VERSION=0.8.5
ARG PGVECTOR_SHA256=6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44

RUN apk add --no-cache --virtual .pgvector-build \
      build-base \
      ca-certificates \
      clang21 \
      curl \
      llvm21-dev \
    && curl -fsSL \
      "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
      -o /tmp/pgvector.tar.gz \
    && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/pgvector.tar.gz -C /tmp \
    && make -C "/tmp/pgvector-${PGVECTOR_VERSION}" clean \
    && make -C "/tmp/pgvector-${PGVECTOR_VERSION}" OPTFLAGS="" \
    && make -C "/tmp/pgvector-${PGVECTOR_VERSION}" install \
    && install -d /usr/share/doc/pgvector \
    && install -m 644 \
      "/tmp/pgvector-${PGVECTOR_VERSION}/LICENSE" \
      "/tmp/pgvector-${PGVECTOR_VERSION}/README.md" \
      /usr/share/doc/pgvector/ \
    && apk del .pgvector-build \
    && rm -rf "/tmp/pgvector-${PGVECTOR_VERSION}" /tmp/pgvector.tar.gz
