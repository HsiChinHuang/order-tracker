FROM node:24-slim

# The responder starts a coding agent in headless mode, so the agent binary has
# to live in this image. Pin the version so a rebuild is reproducible.
ARG PI_VERSION=0.87.1
# @google/genai, esbuild and protobufjs ship install scripts that npm blocks by
# default; pi needs those builds, so allow them explicitly.
RUN npm install -g --omit=dev \
      --allow-scripts=@google/genai,esbuild,protobufjs \
      "@earendil-works/pi-coding-agent@${PI_VERSION}"

WORKDIR /responder
COPY responder.mjs ./
COPY entrypoint.sh ./
COPY prompts ./prompts
RUN chmod +x ./entrypoint.sh

ENV RESOLVER_PORT=8001 \
    PI_AGENT_MOUNT=/opt/pi-agent \
    PI_CODING_AGENT_SESSION_DIR=/tmp/pi-sessions \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0
EXPOSE 8001
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "responder.mjs"]
