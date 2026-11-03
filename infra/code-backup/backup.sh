#!/usr/bin/env bash
# The nightly code backup. Every repository the token can see goes into one encrypted file on Drive.
#
# Any failure stops the night before anything is pruned, so the older backups stay, and the Phoenix route
# /api/cron/code-backup-verify raises the alarm when the newest file passes 36 hours. This job never
# reports its own success: the check reads Drive from production.
#
# It holds only the PUBLIC age key, so nothing on this service can decrypt a backup. It covers pushed
# code only: unpushed commits and .env files are not in it. README.md has the restore.
set -euo pipefail
shopt -s nullglob

: "${GITHUB_BACKUP_TOKEN:?}"
: "${CODE_BACKUP_AGE_RECIPIENT:?}"
: "${CODE_BACKUP_MIN_REPOS:?}"
: "${GOOGLE_DRIVE_OAUTH_CLIENT_ID:?}"
: "${GOOGLE_DRIVE_OAUTH_CLIENT_SECRET:?}"
: "${GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN:?}"

OWNER="${CODE_BACKUP_OWNER:-gawishtheit}"
FOLDER="${CODE_BACKUP_DRIVE_FOLDER:-phoenix-code-backup}"
# Those APKs are in no clone, so a clone alone would lose them.
RELEASE_REPOS="${CODE_BACKUP_RELEASE_REPOS:-hmdm-android}"
KEEP_DAILY=7
KEEP_WEEKLY=4

# rclone reads its Drive remote from these. drive.file sees only what this app itself created.
export RCLONE_CONFIG_BACKUP_TYPE=drive
export RCLONE_CONFIG_BACKUP_SCOPE=drive.file
export RCLONE_CONFIG_BACKUP_CLIENT_ID="$GOOGLE_DRIVE_OAUTH_CLIENT_ID"
export RCLONE_CONFIG_BACKUP_CLIENT_SECRET="$GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"
RCLONE_CONFIG_BACKUP_TOKEN="$(jq -cn --arg r "$GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN" '{access_token:"",token_type:"Bearer",refresh_token:$r,expiry:"2000-01-01T00:00:00Z"}')"
export RCLONE_CONFIG_BACKUP_TOKEN
# A pruned backup is really gone: the trash counts against Drive's storage and would fill it.
export RCLONE_DRIVE_USE_TRASH=false

# The token travels in git's config through the environment, never in a URL or an argument.
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_BACKUP_TOKEN" | base64 -w0)"
export GIT_CONFIG_VALUE_0

github() {
  curl -fsSL --retry 3 -H "Authorization: Bearer $GITHUB_BACKUP_TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/backup"
mkdir -p "$OUT/bundles" "$OUT/releases"
MANIFEST="$OUT/manifest.tsv"
printf 'repository\trefs\tbytes\tstate\n' > "$MANIFEST"

repos=()
page=1
while :; do
  names="$(github "https://api.github.com/user/repos?per_page=100&page=$page" | jq -r --arg o "$OWNER" '.[] | select(.owner.login == $o) | .name')"
  [ -n "$names" ] || break
  while IFS= read -r name; do repos+=("$name"); done <<< "$names"
  page=$((page + 1))
done
echo "repositories visible: ${#repos[@]}"
# A token that lost access would otherwise back up less and less, in silence.
if [ "${#repos[@]}" -lt "$CODE_BACKUP_MIN_REPOS" ]; then
  echo "refused: the token sees ${#repos[@]} repositories, fewer than the $CODE_BACKUP_MIN_REPOS expected" >&2
  exit 1
fi

for name in "${repos[@]}"; do
  mirror="$WORK/$name.git"
  git clone --quiet --mirror "https://github.com/$OWNER/$name.git" "$mirror"
  refs="$(git -C "$mirror" for-each-ref | wc -l)"
  if [ "$refs" -eq 0 ]; then
    # An empty repository is recorded as empty, never counted as backed up.
    echo "EMPTY: $name has no refs"
    printf '%s\t0\t0\tEMPTY\n' "$name" >> "$MANIFEST"
    rm -rf "$mirror"
    continue
  fi
  bundle="$OUT/bundles/$name.bundle"
  git -C "$mirror" bundle create --quiet "$bundle" --all
  git -C "$mirror" bundle verify --quiet "$bundle"
  printf '%s\t%s\t%s\tOK\n' "$name" "$refs" "$(stat -c %s "$bundle")" >> "$MANIFEST"
  echo "bundled: $name refs=$refs"
  rm -rf "$mirror"
done

for name in $RELEASE_REPOS; do
  dir="$OUT/releases/$name"
  mkdir -p "$dir"
  github "https://api.github.com/repos/$OWNER/$name/releases?per_page=100" \
    | jq -r '.[] | .tag_name as $t | .assets[] | [$t, .name, .url] | @tsv' \
    | while IFS=$'\t' read -r tag asset url; do
        mkdir -p "$dir/$tag"
        github -H "Accept: application/octet-stream" -o "$dir/$tag/$asset" "$url"
      done
done

DATE="$(date -u +%F)"
FILE="code-backup-$DATE.tar.age"
TARGET="backup:$FOLDER/daily/$FILE"
tar -C "$OUT" -cf - . | age -r "$CODE_BACKUP_AGE_RECIPIENT" | rclone rcat --drive-chunk-size 64M "$TARGET"
size="$(rclone lsf --format s "$TARGET")"
if ! [ "${size:-0}" -gt 0 ]; then
  echo "refused: the file on Drive reads as empty" >&2
  exit 1
fi
echo "uploaded: $FILE bytes=$size"

# Everything above succeeded, so only now is anything old removed.
if [ "$(date -u +%u)" = "7" ]; then
  rclone copyto "$TARGET" "backup:$FOLDER/weekly/$FILE"
fi
prune() {
  rclone lsf --files-only "backup:$FOLDER/$1" | sort -r | tail -n +"$(($2 + 1))" | while IFS= read -r old; do
    rclone deletefile "backup:$FOLDER/$1/$old"
    echo "pruned: $1/$old"
  done
}
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"
echo "done"
