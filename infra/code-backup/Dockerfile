# The nightly backups, code then database: a one-shot job. Railway starts it on its schedule and it exits when done.
# Alpine 3.21 because it is the first to carry the PostgreSQL 17 client: pg_dump refuses a server newer than
# itself, and production is 17. .github/workflows/backup-image.yml builds this image and runs it on a pull request.
# restore-drill.sh is deliberately NOT copied in: the service that makes the backups holds nothing that reads them.
FROM alpine:3.21

RUN apk add --no-cache age bash ca-certificates coreutils curl git jq postgresql17-client rclone tar

COPY backup.sh /usr/local/bin/code-backup
COPY db-backup.sh /usr/local/bin/db-backup
COPY run.sh /usr/local/bin/nightly-backup
RUN chmod +x /usr/local/bin/code-backup /usr/local/bin/db-backup /usr/local/bin/nightly-backup

# The job runs as an unprivileged user, never root: both scripts write only under mktemp -d and take every
# credential from the environment. git and rclone want a home they can write to, so the user gets a real one.
# ci/rehearse.sh fails if this image ever runs as root again.
RUN adduser -D -u 10001 -h /home/phoenix phoenix
USER phoenix
ENV HOME=/home/phoenix
WORKDIR /home/phoenix

CMD ["/usr/local/bin/nightly-backup"]
