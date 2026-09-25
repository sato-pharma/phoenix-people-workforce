# The company's Headwind MDM image, plus the Phoenix actions add-on.
#
# 🔴 IT EXTENDS THE PINNED TAG, IT DOES NOT REPLACE IT. `HEADWIND_IMAGE_TAG` is the same value the
# running server already uses, passed in by docker-compose. Building against `latest` here would mean
# the add-on silently compiled against one version and ran against another — and the failure mode of
# that is a hook that loads and does nothing.
#
# TWO THINGS BUILD THIS, AND ONLY ONE OF THEM PASSES A BUILD ARG.
#
#  1. Railway — the way it actually runs (see railway.json beside this file). Railway builds a
#     Dockerfile from the repository and does NOT pass docker-compose's build args, which is why the
#     ARG below carries a DEFAULT. Without one the FROM line resolves to `headwindmdm/hmdm:` and the
#     build dies on a line that looks like a typo.
#  2. docker-compose.headwind.yml — the optional self-hosted path, for anyone who later wants to own
#     the RustDesk relay as well. It passes the tag explicitly and overrides the default.
#
#   docker compose --env-file .env.headwind -f docker-compose.headwind.yml build hmdm
#   docker compose --env-file .env.headwind -f docker-compose.headwind.yml up -d hmdm
#
# Then confirm, against wherever it runs:
#   curl -s -H "Authorization: Bearer $JWT" \
#     https://<host>/rest/plugins/phoenix-actions/private/status
# `{"ready":true}` means Phoenix will offer lock, lost mode, factory reset and screen-lock reset.
# Anything else — 404 included — means it will not, and the console says so in words rather than
# offering a button that cannot work.

# 🔴 A PINNED DEFAULT, AND NEVER `latest`. The warning above is about an upgrade nobody chose
# arriving with a restart, and `latest` is exactly that. A pinned default is the opposite: it is one
# known version, written down, that a reader can compare against what is running. Bump it
# deliberately, together with HEADWIND_IMAGE_TAG in .env.headwind.example, never as a drive-by.
ARG HEADWIND_IMAGE_TAG=0.1.9
FROM headwindmdm/hmdm:${HEADWIND_IMAGE_TAG} AS headwind

# ── Build the add-on against the jars that are actually in that image ─────────────────────────────
FROM maven:3.9-eclipse-temurin-11 AS build
WORKDIR /build

# Headwind's own jars, taken from the image above rather than from a repository, so the add-on is
# compiled against the exact code it will run beside.
COPY --from=headwind /usr/local/tomcat/webapps/ROOT/WEB-INF/lib /opt/hmdm-lib

COPY pom.xml .
COPY src ./src

# 🔴 OFFLINE AGAINST A LOCAL REPOSITORY BUILT FROM THE IMAGE. `mvn install:install-file` puts the
# server jar where the pom expects it, at the version the image carries — which is why the pom's
# `hmdm.version` is a property and not a literal scattered through the file.
RUN set -eu; \
    SERVER_JAR="$(find /opt/hmdm-lib -name 'server*.jar' | head -n 1)"; \
    VERSION="$(basename "$SERVER_JAR" .jar | sed 's/^server-//')"; \
    mvn -q -B install:install-file \
      -Dfile="$SERVER_JAR" -DgroupId=com.hmdm -DartifactId=server \
      -Dversion="$VERSION" -Dpackaging=jar; \
    mvn -q -B -Dhmdm.version="$VERSION" package

# ── Drop the jar in beside Headwind's own ─────────────────────────────────────────────────────────
FROM headwindmdm/hmdm:${HEADWIND_IMAGE_TAG}
COPY --from=build /build/target/headwind-phoenix-actions.jar \
     /usr/local/tomcat/webapps/ROOT/WEB-INF/lib/headwind-phoenix-actions.jar
