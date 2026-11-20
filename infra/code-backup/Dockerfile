# The nightly backups, code then database: a one-shot job. Railway starts it on its schedule and it exits when done.
# Alpine 3.21 because it is the first to carry the PostgreSQL 17 client: pg_dump refuses a server newer than
# itself, and production is 17. .github/workflows/backup-image.yml builds this image and runs it on a pull request.
# restore-drill.sh is deliberately NOT copied in: the service that makes the backups holds nothing that reads them.
# Pulled from AWS's copy of Docker Hub, not docker.io, and pinned by digest (Railway audit, 2026-11-18): Railway's
# shared builders hit Docker Hub's anonymous limit, `429 Too Many Requests`, which stopped four website deploys on
# 2026-10-09 (docs/deployment.md, "The base image is pulled from AWS's mirror, not Docker Hub"). The digest is the
# multi-arch index of alpine:3.21, read the same from both registries on 2026-11-18; move it on purpose with
# `docker buildx imagetools inspect public.ecr.aws/docker/library/alpine:3.21`. Dependabot's docker entry
# (.github/dependabot.yml) proposes the tag's current digest monthly; a move off 3.21 stays deliberate.
FROM public.ecr.aws/docker/library/alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab

RUN apk add --no-cache age bash ca-certificates coreutils curl git jq postgresql17-client rclone tar

COPY backup.sh /usr/local/bin/code-backup
COPY db-backup.sh /usr/local/bin/db-backup
COPY run.sh /usr/local/bin/nightly-backup
RUN chmod +x /usr/local/bin/code-backup /usr/local/bin/db-backup /usr/local/bin/nightly-backup

# The night runs as an unprivileged user (14 Nov 2026), never as root. Nothing here needs root: both backups
# write only under mktemp -d, and every credential reaches git, psql and rclone through the environment.
# The user has a real home because rclone and git look for one, and the scripts above stay root-owned, so
# the night can run them and cannot change them. ci/rehearse.sh fails if this image ever runs as root again.
RUN adduser -D -u 10001 -h /home/phoenix phoenix
USER phoenix
ENV HOME=/home/phoenix
WORKDIR /home/phoenix

CMD ["/usr/local/bin/nightly-backup"]
