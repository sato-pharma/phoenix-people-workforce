# The nightly code backup: a one-shot job. Railway starts it on its schedule and it exits when done.
FROM alpine:3.20

RUN apk add --no-cache age bash ca-certificates coreutils curl git jq rclone tar

COPY backup.sh /usr/local/bin/code-backup
RUN chmod +x /usr/local/bin/code-backup

CMD ["/usr/local/bin/code-backup"]
