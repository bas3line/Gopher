FROM ghcr.io/lavalink-devs/lavalink:4-alpine

# Lavalink needs the plugin first-run setup
USER root
RUN mkdir -p /plugins && chown -R lavalink:nogroup /plugins

COPY application.yml /opt/Lavalink/application.yml

USER lavalink
