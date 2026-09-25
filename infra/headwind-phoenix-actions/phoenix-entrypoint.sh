#!/bin/sh
# Seed Headwind's WAR cache with the WAR that carries the Phoenix actions add-on, then hand over to
# Headwind's own entrypoint untouched.
#
# 🔴 WHY THIS RUNS AT START AND NOT AT BUILD. Headwind's entrypoint downloads the application WAR
# into $BASE_DIR/cache on first start, and $BASE_DIR is inside /usr/local/tomcat/work — which
# docker-compose.headwind.yml mounts a named volume over (`headwind-work`). Anything baked into that
# directory at image build time is therefore INVISIBLE the moment a volume exists: the entrypoint
# would find an empty cache, download a clean WAR, and the add-on would be silently absent while the
# server looked perfectly healthy. Copying here, after mounts, is the only placement that holds on
# both paths — Railway (no volume) and compose (volume).
#
# The add-on's own WAR lives in /opt/phoenix-war, which nothing mounts over.
#
# FORCE_RECONFIGURE=true still re-downloads a clean WAR over this, by Headwind's own design. That is
# the deliberate way out of the pin, and it removes the add-on until the next start.
set -eu

TOMCAT_DIR=/usr/local/tomcat

# Read BASE_DIR out of Headwind's own entrypoint rather than repeating it here, so a future image
# that moves the cache does not leave us writing confidently into the wrong folder.
RAW="$(grep -m1 '^BASE_DIR=' /docker-entrypoint.sh | cut -d= -f2-)"
BASE_DIR="$(eval printf '%s' "\"$RAW\"")"

if [ -z "$BASE_DIR" ]; then
  echo "phoenix-entrypoint: cannot resolve BASE_DIR from /docker-entrypoint.sh — refusing to guess" >&2
  exit 1
fi

WAR="$(cat /opt/phoenix-war/NAME)"

mkdir -p "$BASE_DIR/cache"
if cmp -s "/opt/phoenix-war/$WAR" "$BASE_DIR/cache/$WAR"; then
  echo "phoenix-entrypoint: $BASE_DIR/cache/$WAR already carries the add-on"
else
  cp "/opt/phoenix-war/$WAR" "$BASE_DIR/cache/$WAR"
  echo "phoenix-entrypoint: seeded $BASE_DIR/cache/$WAR with the add-on"
fi

exec /docker-entrypoint.sh "$@"
