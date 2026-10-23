# The company's Headwind MDM image, plus the Phoenix actions add-on.
#
# 🔴 IT EXTENDS THE PINNED TAG, IT DOES NOT REPLACE IT. `HEADWIND_IMAGE_TAG` is the same value the
# running server already uses, passed in by docker-compose. Building against `latest` here would mean
# the add-on silently compiled against one version and ran against another — and the failure mode of
# that is a hook that loads and does nothing.
#
# TWO THINGS BUILD THIS, AND ONLY ONE OF THEM PASSES A BUILD ARG.
#
#  1. Railway — the way it actually runs (its settings are the `phoenix-headwind` block of .railway/railway.ts). Railway builds a
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
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# 🔴 THE IMAGE DOES NOT CONTAIN THE WEB APPLICATION. READ THIS BEFORE CHANGING ANY PATH BELOW.
#
# `headwindmdm/hmdm` ships Tomcat, a few tools and an entrypoint — and nothing else. The application
# is a WAR that `/docker-entrypoint.sh` DOWNLOADS on first start, from the `HMDM_URL` baked into the
# image, and Tomcat explodes it. So `/usr/local/tomcat/webapps/ROOT/` exists only inside a RUNNING
# container, never in the image.
#
# This file got that wrong twice, and Railway's first build on 2026-09-26 found the first one:
#
#   1. `COPY --from=headwind /usr/local/tomcat/webapps/ROOT/WEB-INF/lib /opt/hmdm-lib` FAILED the
#      build outright — "/usr/local/tomcat/webapps/ROOT/WEB-INF/lib: not found". Loud, and cheap.
#   2. 🔴 The final stage copied the built jar INTO that same directory. Docker's COPY creates the
#      path, so that one would have SUCCEEDED and produced a broken image: at first start the
#      entrypoint drops `ROOT.war` in beside it and Tomcat, unpacking a newer WAR, deletes the
#      directory our jar was sitting in. The add-on would have been silently absent, the status
#      endpoint would have answered 404, and the console would have reported — correctly, and
#      uselessly — that the four actions were unavailable. That is precisely the "a hook that loads
#      and does nothing" failure the top of this file warns about, arriving by a different door.
#
# Both are fixed the same way, using the entrypoint's OWN mechanism rather than working around it:
# take the WAR, put our jar inside it, and hand the entrypoint the finished WAR through the cache it
# already looks in. Nothing in the exploded webapp is patched and no path is guessed — every path
# below is either read out of the image or proven by the build itself. The one thing that happens at
# start rather than at build is the cache copy, and the final stage says why.
#
# One deliberate consequence: a pre-seeded cache means this server never silently upgrades itself to
# a newer WAR on a restart. That is the same pinning argument as `HEADWIND_IMAGE_TAG` — bump it
# deliberately, never as a drive-by. `FORCE_RECONFIGURE=true` is the entrypoint's own way out.

# 🔴 A PINNED DEFAULT, AND NEVER `latest`. The warning above is about an upgrade nobody chose
# arriving with a restart, and `latest` is exactly that. A pinned default is the opposite: it is one
# known version, written down, that a reader can compare against what is running. Bump it
# deliberately, together with HEADWIND_IMAGE_TAG in .env.headwind.example, never as a drive-by.
ARG HEADWIND_IMAGE_TAG=0.1.9

# ── Fetch the exact WAR this image would deploy ───────────────────────────────────────────────────
# `HMDM_URL` is the image's own environment variable, so the version follows the tag and is never
# written down twice. `wget` is used rather than `curl` because wget is what this image installs.
FROM headwindmdm/hmdm:${HEADWIND_IMAGE_TAG} AS headwind
RUN set -eu; \
    mkdir -p /opt/war; \
    [ -n "${HMDM_URL:-}" ] || { echo "HMDM_URL is not set in the image — cannot resolve the WAR"; exit 1; }; \
    basename -- "$HMDM_URL" > /opt/war/NAME; \
    wget -q -O "/opt/war/$(cat /opt/war/NAME)" "$HMDM_URL"; \
    test -s "/opt/war/$(cat /opt/war/NAME)"

# ── Build the add-on against the jars that are actually in that WAR ───────────────────────────────
FROM maven:3.9-eclipse-temurin-11 AS build
WORKDIR /build

COPY --from=headwind /opt/war /opt/war

# Headwind's own jars, taken from the WAR above rather than from a repository, so the add-on is
# compiled against the exact code it will run beside.
RUN set -eu; \
    mkdir -p /opt/hmdm-lib /tmp/unpacked; \
    cd /tmp/unpacked && jar xf "/opt/war/$(cat /opt/war/NAME)" WEB-INF/lib; \
    cp /tmp/unpacked/WEB-INF/lib/*.jar /opt/hmdm-lib/

COPY pom.xml .
COPY src ./src

# 🔴 OFFLINE AGAINST A LOCAL REPOSITORY BUILT FROM THE WAR. `mvn install:install-file` puts Headwind's
# own jars where the pom expects them, at the versions the image carries — which is why the pom's
# versions are properties and not literals scattered through the file.
#
# 🔴 EACH JAR IS FOUND BY A CLASS IT CONTAINS, NEVER BY ITS NAME, AND THAT IS THE LESSON OF THE SECOND
# FAILED BUILD. This read `find -name 'server*.jar'`, and Headwind ships no such jar: its core is
# eleven small jars named for their area — common, push, audit, deviceinfo, notification, platform,
# messaging, devicelog-core, devicelog-postgres, jwt, xtra — all at 0.1.0 except jwt at 0.2.0, and the
# REST layer that uses them is loose classes in WEB-INF/classes rather than a jar at all. `find`
# returned nothing, `-Dfile=` resolved to a directory, and Maven answered "Is a directory" with an
# empty version in the coordinate: `com.hmdm:server:jar::`. A name can be renamed between versions and
# the next reader gets the same puzzle; a class this add-on compiles against cannot move without the
# add-on breaking anyway, so it is the honest thing to search for.
#
# 🔴 AND `-DpomFile` RATHER THAN BARE COORDINATES, WHICH IS THE LESSON OF THE THIRD FAILED BUILD.
# Given only `-DgroupId/-DartifactId/-Dversion`, `install:install-file` finds the pom Maven left INSIDE
# the jar at META-INF/maven/… and installs that as the artifact's descriptor. Headwind's is a module
# of a reactor build, so it carries `<parent>com.hmdm:root:0.1.0</parent>` — a pom that exists only in
# Headwind's own source tree and is not on Maven Central. The install SUCCEEDED and the next command
# died reading what it wrote:
#
#     Failed to read artifact descriptor for com.hmdm:common:jar:0.1.0
#       Caused by: com.hmdm:root:pom:0.1.0 (absent)
#
# A minimal generated pom replaces it. That also drops the transitive `guava` and `commons-io` the
# embedded pom declared — deliberately, and safely: everything this add-on compiles against is
# declared explicitly in pom.xml, and at runtime both jars are already in the WAR beside ours.
#
# `grep -a` rather than `jar tf` because a zip stores its ENTRY NAMES uncompressed — the name is
# literal bytes in the archive — and 114 JVM startups to ask the same question costs half a minute.
# The `.class` suffix in each marker is load-bearing: it matches the zip ENTRY and not the constant
# pool of some other jar that merely references the type.
RUN set -eu; \
    : > /tmp/hmdm-versions; \
    install_hmdm_jar() { \
      MARKER="$1"; ARTIFACT="$2"; \
      FOUND=""; \
      for J in /opt/hmdm-lib/*.jar; do \
        if grep -aq "$MARKER" "$J"; then FOUND="$J"; break; fi; \
      done; \
      [ -n "$FOUND" ] || { echo "no jar in this WAR carries $MARKER — the add-on has nothing to extend"; exit 1; }; \
      V="$(basename "$FOUND" .jar | sed 's/^.*-\([0-9][0-9.]*\)$/\1/')"; \
      [ -n "$V" ] || { echo "cannot read a version out of $(basename "$FOUND")"; exit 1; }; \
      printf '%s\n' \
        '<project xmlns="http://maven.apache.org/POM/4.0.0">' \
        '  <modelVersion>4.0.0</modelVersion>' \
        '  <groupId>com.hmdm</groupId>' \
        "  <artifactId>$ARTIFACT</artifactId>" \
        "  <version>$V</version>" \
        '  <packaging>jar</packaging>' \
        '</project>' > "/tmp/pom-$ARTIFACT.xml"; \
      mvn -q -B install:install-file -Dfile="$FOUND" -DpomFile="/tmp/pom-$ARTIFACT.xml"; \
      echo "${ARTIFACT}_version=$V" >> /tmp/hmdm-versions; \
      echo "Headwind $ARTIFACT: $(basename "$FOUND") -> com.hmdm:$ARTIFACT:$V"; \
    }; \
    install_hmdm_jar 'com/hmdm/rest/json/SyncResponseHook.class' common; \
    install_hmdm_jar 'com/hmdm/plugin/PluginConfiguration.class' platform; \
    install_hmdm_jar 'com/hmdm/security/jwt/JWTFilter.class' jwt; \
    . /tmp/hmdm-versions; \
    mvn -q -B \
      -Dhmdm.common.version="$common_version" \
      -Dhmdm.platform.version="$platform_version" \
      -Dhmdm.jwt.version="$jwt_version" \
      package

# 🔴 THE CONSOLE'S ACCESS-PASS CHECK IS PROVEN HERE, AGAINST THE CLASSES JUST COMPILED, BEFORE THEY
# ARE PUT INTO THE WAR. AccessVerifierCheck signs its own passes with keys it generates and fails the
# build if the verifier accepts a forgery (another app's pass, an expired one, a stranger's signature,
# alg none, altered claims…) or refuses a genuine one. A verifier that would let a forged pass through
# never reaches the server; see src/…/security/AccessGateFilter.java for why the server checks at all.
COPY AccessVerifierCheck.java /tmp/AccessVerifierCheck.java
RUN java -cp target/classes /tmp/AccessVerifierCheck.java

# ── Put the add-on INSIDE the WAR, and prove it landed ────────────────────────────────────────────
# The last line is not decoration: a `jar uf` that quietly wrote nothing would give us back exactly
# the broken image described at the top of this file, and it would look like a clean build.
RUN set -eu; \
    mkdir -p /tmp/inject/WEB-INF/lib; \
    cp /build/target/headwind-phoenix-actions.jar /tmp/inject/WEB-INF/lib/; \
    jar uf "/opt/war/$(cat /opt/war/NAME)" -C /tmp/inject WEB-INF/lib/headwind-phoenix-actions.jar; \
    jar tf "/opt/war/$(cat /opt/war/NAME)" | grep -qx 'WEB-INF/lib/headwind-phoenix-actions.jar'

# ── Hand the finished WAR to the entrypoint through the cache it already reads ────────────────────
# 🔴 THE SEEDING HAPPENS AT START, NOT HERE, AND THE REASON IS A VOLUME. Headwind's cache lives under
# /usr/local/tomcat/work, and docker-compose.headwind.yml mounts `headwind-work` over exactly that.
# A WAR baked into it at build time is hidden the instant that volume exists — the entrypoint would
# find an empty cache, download a clean WAR, and the add-on would be gone with no error anywhere.
# So the WAR is staged in /opt/phoenix-war, which nothing mounts over, and phoenix-entrypoint.sh
# copies it into place after mounts and before Headwind's own entrypoint runs. Railway has no volume
# here and compose does; this is the one placement that is correct on both.
FROM headwindmdm/hmdm:${HEADWIND_IMAGE_TAG}
COPY --from=build /opt/war /opt/phoenix-war

# 🔴 TOMCAT'S WEB-APPLICATION LOG GOES TO A FILE NOBODY CAN READ, AND THAT COST A WHOLE BUILD CYCLE.
# The fourth build deployed, Railway reported SUCCESS, and Tomcat printed exactly this to stdout:
#
#     SEVERE [main] StandardContext.startInternal One or more Filters failed to start.
#       Full details will be found in the appropriate container log file
#     SEVERE [main] StandardContext.startInternal Context [] startup failed due to previous errors
#
# The context had failed and the server was serving nothing — while Railway's own deploy check, which
# watches the CONTAINER, reported a healthy green deployment. The "appropriate container log file" is
# `logs/localhost.<date>.log` inside the container, which on Railway is unreachable: Railway captures
# stdout and nothing else, and `railway ssh` needs a key registered on the account first.
#
# So the one thing that would have named the failure was written to the one place that cannot be
# read. Tomcat 9 routes that logger to a file handler only:
#
#     org.apache.catalina.core.ContainerBase.[Catalina].[localhost].handlers = 2localhost.…AsyncFileHandler
#
# Appending the console handler to it puts the SAME detail on stdout, where Railway keeps it. A
# duplicate key later in a java.util.logging properties file wins, so this APPENDS rather than
# editing in place — no `sed` escaping of `[Catalina].[localhost]`, and nothing existing is rewritten.
# This is diagnostics, not behaviour: it changes what is printed and nothing else.
RUN set -eu; \
    LOGPROPS="${CATALINA_HOME:-/usr/local/tomcat}/conf/logging.properties"; \
    [ -f "$LOGPROPS" ] || { echo "no $LOGPROPS in this image — Tomcat's layout changed, do not guess"; exit 1; }; \
    printf '\n%s\n' \
      'org.apache.catalina.core.ContainerBase.[Catalina].[localhost].handlers = 2localhost.org.apache.juli.AsyncFileHandler, java.util.logging.ConsoleHandler' \
      >> "$LOGPROPS"; \
    grep -q 'java.util.logging.ConsoleHandler$' "$LOGPROPS"

# 🔴 THE TWO PUBLIC UPLOAD ENDPOINTS ARE REFUSED HERE, BEFORE HEADWIND SEES THE REQUEST (owner,
# 2026-10-22: "close the tablet server's open upload path"). `rewrite.config` beside this file says
# which two and why; docs/devices/headwind-rustdesk.md §8.3 has the account.
#
# Host level, not the web application's own context: the base entrypoint REGENERATES
# conf/Catalina/localhost/ROOT.xml at every start, so a valve put there would be gone on boot, while
# server.xml is copied in at image build and never rewritten. The Host-level valve reads its rules
# from conf/Catalina/localhost/rewrite.config, which nothing at start touches.
#
# 🔴 AND A BAD RULE FAILS THE BUILD, NEVER THE START. A line Tomcat cannot parse stops the whole Host,
# and Railway still calls that deploy green (see the logging note above). RewriteCheck.java runs
# Tomcat's own parser on the file with the image's own jars, so a typo leaves the running server as it
# is. The server.xml edit refuses to guess: exactly one </Host>, no RewriteValve already there.
#
# 🔴 THE SAME FILE CARRIES THE HOST SPLIT (owner, 2026-10-22: "split the Headwind console onto
# mdm-console behind Access"): every name except mdm-console.satopharma.com serves the tablet agent's
# own paths and nothing else. That rule is an ALLOWLIST, so a parse check is not enough — RewriteCheck
# also runs Tomcat's own engine over rewrite-cases.txt, and one tablet path refused fails the build
# rather than the fleet.
COPY rewrite.config /usr/local/tomcat/conf/Catalina/localhost/rewrite.config
COPY RewriteCheck.java /tmp/RewriteCheck.java
COPY rewrite-cases.txt /tmp/rewrite-cases.txt
RUN set -eu; \
    TOMCAT="${CATALINA_HOME:-/usr/local/tomcat}"; \
    SERVER_XML="$TOMCAT/conf/server.xml"; \
    [ "$(grep -c '</Host>' "$SERVER_XML")" = 1 ] || { echo "server.xml does not hold exactly one </Host> — refusing to guess where the upload block goes"; exit 1; }; \
    if grep -q 'valves.rewrite.RewriteValve' "$SERVER_XML"; then echo "server.xml already carries a RewriteValve — refusing to add a second"; exit 1; fi; \
    sed -i 's|</Host>|  <Valve className="org.apache.catalina.valves.rewrite.RewriteValve" />\n      </Host>|' "$SERVER_XML"; \
    [ "$(grep -c 'className="org.apache.catalina.valves.rewrite.RewriteValve"' "$SERVER_XML")" = 1 ]; \
    java -cp "$TOMCAT/lib/*:$TOMCAT/bin/tomcat-juli.jar" /tmp/RewriteCheck.java "$TOMCAT/conf/Catalina/localhost/rewrite.config" 3 /tmp/rewrite-cases.txt; \
    rm -f /tmp/RewriteCheck.java /tmp/rewrite-cases.txt

COPY phoenix-entrypoint.sh /phoenix-entrypoint.sh
# chmod because the repository is checked out on Windows, where the executable bit does not survive.
RUN chmod +x /phoenix-entrypoint.sh

# 🔴 THIS STAGE RUNS AS ROOT — THE BASE IMAGE'S OWN DESIGN, NOT AN OVERSIGHT HERE. `headwindmdm/hmdm`
# (github.com/h-mdm/hmdm-docker, built on `tomcat:9-jdk11-temurin-jammy`) carries no USER directive at
# any layer it ships, and its own `/docker-entrypoint.sh` — which phoenix-entrypoint.sh hands off to —
# writes across paths that are not ours to promise stable: $CATALINA_HOME/work (cache/files/plugins/
# logs, and Tomcat's own logs/temp), webapps/ROOT.war and the webapp it unpacks there, conf/Catalina/
# localhost/ROOT.xml, ssl/hmdm.{p12,jks} when PROTOCOL=https, and — unconditionally, every single
# start — /opt/java/openjdk/conf/security/java.security, a JDK file entirely outside Tomcat's own
# tree. Retrofitting a non-root USER means chowning all of that inside a third-party image whose
# internal layout can change under an upstream tag bump, and the only way to know it still boots is an
# actual container run — which this task has no safe way to rehearse (no local Docker daemon here, and
# a merge to this Dockerfile ships straight to the live MDM console on the next Railway deploy; see
# the watch pattern in .railway/railway.ts). An unverified guess risks a device-management server that will not start, which is a
# worse outcome for the fleet than this finding.
#
# What actually bounds the blast radius here: PROTOCOL=http on Railway means TLS terminates at
# Railway's edge and no certificate or private key material ever reaches this container (§4.2 of
# docs/devices/headwind-rustdesk.md); the connectors it binds (8080/8443, this image's server.xml) are
# all unprivileged ports, so root buys no capability a non-root user would have lacked; and
# .railway/railway.ts pins one replica with `restartPolicyType: "ON_FAILURE"` to limit what a
# compromised process could do before it is noticed. Revisit this if h-mdm/hmdm-docker ever ships its
# own non-root support upstream.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/phoenix-entrypoint.sh"]
