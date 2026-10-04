# Verstas dev box: the image every session container runs.
#
# Build from the repository root after `npm run build`, so the compiled
# worker (dist/src/worker) is available:
#
#   docker build -f images/devbox/Dockerfile -t verstas-devbox:local .
#
# What is in here is what the agent can use from the first minute: Node 22,
# git, Python 3 with pip, a C toolchain for native modules, the shared
# libraries and fonts a headless browser needs, Claude Code, and `svc` for
# services. Anything else the agent installs itself with sudo (apt-get,
# npm -g), which is logged; add tools here when the same install shows up in
# session after session.
#
# The agent runs as uid 1000 (`node`, already present in the base image) with
# passwordless sudo. The container is the boundary, not the user inside it
# (docs/SANDBOX.md, "Capability inside, boundary outside").

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
      sudo \
 && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-noto-color-emoji \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 \
      libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libx11-xcb1 \
      libxshmfence1 libxss1 libgtk-3-0 \
 && rm -rf /var/lib/apt/lists/*

# Passwordless sudo for the agent. Every command is logged to a file in the
# workspace, which the session page shows. A log the agent could edit is a
# record, not a control; the controls are the container's flags.
RUN printf '%s\n' \
      'node ALL=(ALL:ALL) NOPASSWD: ALL' \
      'Defaults logfile=/workspace/.verstas/logs/sudo.log' \
      'Defaults !lecture, !syslog' \
      'Defaults env_keep += "HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NO_PROXY DEBIAN_FRONTEND"' \
      > /etc/sudoers.d/verstas \
 && chmod 0440 /etc/sudoers.d/verstas \
 && visudo -cf /etc/sudoers.d/verstas

# The agent's home. The session mounts a named volume here; a new volume is
# initialised from this directory, so it starts owned by the agent.
RUN mkdir -p /home/agent && chown 1000:1000 /home/agent

# svc: start, stop and remember services (Postgres, Redis, dev servers).
COPY images/devbox/svc /usr/local/bin/svc
RUN chmod 0755 /usr/local/bin/svc

# Claude Code CLI, pinned; bump deliberately. The worker drives it with
# `claude -p` and translates its stream-json into Verstas events.
ARG CLAUDE_CODE_VERSION=2.1.287
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# Optional agents (docs/DRIVERS.md): Codex CLI and Cursor CLI. Each install
# is best-effort so a vendor hiccup never breaks the image: a session that
# picks an agent whose binary is missing fails its worker with
# "driver_missing", and sessions on Claude Code are unaffected. Set the
# build arg to 0 to leave one out on purpose.
ARG INSTALL_CODEX=1
ARG CODEX_VERSION=0.160.0
RUN if [ "$INSTALL_CODEX" = "1" ]; then \
      (npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force && codex --version) \
      || echo "WARNING: Codex CLI not installed; the codex driver will report driver_missing"; \
    fi
# The Cursor installer unpacks a self-contained package (a bash launcher plus
# its own node) under ~/.local/share/cursor-agent and symlinks ~/.local/bin;
# the package moves to /opt so the agent user can run it, and the launcher
# finds its files through the symlink's real path.
ARG INSTALL_CURSOR=1
RUN if [ "$INSTALL_CURSOR" = "1" ]; then \
      (curl -fsSL https://cursor.com/install | bash >/dev/null \
       && mv /root/.local/share/cursor-agent /opt/cursor-agent \
       && chmod -R a+rX /opt/cursor-agent \
       && ln -sf "$(ls -d /opt/cursor-agent/versions/*/cursor-agent | head -1)" /usr/local/bin/agent \
       && ln -sf "$(ls -d /opt/cursor-agent/versions/*/cursor-agent | head -1)" /usr/local/bin/cursor-agent \
       && rm -rf /root/.local/bin/agent /root/.local/bin/cursor-agent \
       && su -s /bin/sh node -c "HOME=/tmp agent --version") \
      || echo "WARNING: Cursor CLI not installed; the cursor driver will report driver_missing"; \
    fi

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
