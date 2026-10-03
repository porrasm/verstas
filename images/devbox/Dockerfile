# Verstas dev box: the image every session container runs.
#
# Build from the repository root after `npm run build`, so the compiled
# worker (dist/src/worker) is available:
#
#   docker build -f images/devbox/Dockerfile -t verstas-devbox:local .
#
# What is in here is what the agent can use without asking: Node 22, git,
# Python 3 with pip, a C toolchain for native modules, and Claude Code. Add
# tools here when the request log shows the same install being approved
# again and again. There is no sudo; the harness installs as root through
# `docker exec` (docs/SANDBOX.md Boundary 7).
#
# The agent runs as uid 1000 (`node`, already present in the base image) with
# HOME=/workspace/.home set by the harness, so every dotfile it writes stays
# in the bind mount.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
# apt over HTTPS: the sandbox proxy allows HTTPS only, so plain-http mirrors
# would never work for setup scripts or approved installs. deb.debian.org
# and security.debian.org are on the default allowlist for the same reason.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq unzip zip less procps lsof psmisc iproute2 \
      python3 python3-pip python3-venv \
      build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, pinned; bump deliberately. The worker drives it with
# `claude -p` and translates its stream-json into Verstas events.
ARG CLAUDE_CODE_VERSION=2.1.287
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# The worker and the board MCP server, dependency-free ESM compiled from
# src/worker. At run time the host mounts its current dist/src/worker over
# this directory read-only, so this copy is a fallback for running the image
# by hand.
COPY dist/src/worker /opt/verstas/
RUN chmod -R a+rX /opt/verstas

# Git inside the box: a fixed identity, no hooks ever, no prompts.
RUN git config --system user.name Verstas \
 && git config --system user.email verstas@localhost \
 && git config --system core.hooksPath /dev/null \
 && git config --system safe.directory '*' \
 && git config --system advice.detachedHead false

ENV GIT_TERMINAL_PROMPT=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_update_notifier=false \
    CI=1

USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
