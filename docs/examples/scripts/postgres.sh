#!/usr/bin/env bash
# needs-hosts: deb.debian.org security.debian.org
# note: PostgreSQL 15 binaries are in /usr/lib/postgresql/15/bin (on PATH). The agent runs its own cluster as its own user: `initdb -D /workspace/.pg && pg_ctl -D /workspace/.pg -l /workspace/.pg/log start`, then `psql -h localhost postgres`. No system service is used.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends postgresql postgresql-contrib
# The agent (uid 1000) runs its own cluster under /workspace; the binaries just need to be reachable.
ln -sf /usr/lib/postgresql/15/bin/* /usr/local/bin/
# Verification: the binaries run.
initdb --version
pg_ctl --version
