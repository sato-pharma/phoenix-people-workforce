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

# Every account whose repositories are backed up. Since 2026-11-06 Phoenix lives on the organization
# sato-pharma while the tablet launcher and the website stayed on the personal account, so one owner
# alone silently dropped the other's repositories from the night.
OWNERS="${CODE_BACKUP_OWNERS:-sato-pharma Omar-3-xx}"
FOLDER="${CODE_BACKUP_DRIVE_FOLDER:-phoenix-code-backup}"
# Those APKs are in no clone, so a clone alone would lose them. Each is <owner>/<repository>.
RELEASE_REPOS="${CODE_BACKUP_RELEASE_REPOS:-Omar-3-xx/hmdm-android}"
# The retired single-owner variable is IGNORED, loudly: refusing the night over a leftover variable would cost
# more than a day of coverage (the alarm only reads Drive after 36 hours). Mapping its one owner onto
# CODE_BACKUP_OWNERS would drop the other. The old bare release names are refused, since they would misread.
if [ -n "${CODE_BACKUP_OWNER:-}" ]; then
  echo "warning: CODE_BACKUP_OWNER is retired and ignored; the owners backed up are: $OWNERS (set CODE_BACKUP_OWNERS to change them)" >&2
fi
for slug in $RELEASE_REPOS; do
  if [[ "$slug" != */* ]]; then
    echo "refused: CODE_BACKUP_RELEASE_REPOS names $slug; each entry is <owner>/<repository>" >&2
    exit 1
  fi
done
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

# One Accept header only: with the JSON one a release file downloads as 1,719 bytes of JSON under its .apk
# name, with no error (measured 2026-11-03; the real file is 6,290,217 bytes).
github_asset() {
  curl -fsSL --retry 3 -H "Authorization: Bearer $GITHUB_BACKUP_TOKEN" -H "Accept: application/octet-stream" -o "$1" "$2"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/backup"
mkdir -p "$OUT/bundles" "$OUT/releases"
MANIFEST="$OUT/manifest.tsv"
printf 'repository\trefs\tbytes\tstate\n' > "$MANIFEST"
RELEASE_MANIFEST="$OUT/releases.tsv"
printf 'repository\ttag\tfile\tbytes\n' > "$RELEASE_MANIFEST"

repos=()
page=1
while :; do
  # One owner/name per line, for every owner listed. An empty page ends the listing.
  listing="$(github "https://api.github.com/user/repos?per_page=100&page=$page")"
  [ "$(jq 'length' <<< "$listing")" -gt 0 ] || break
  slugs="$(jq -r --arg o "$OWNERS" '($o | split(" ") | map(select(length > 0) | ascii_downcase)) as $owners | .[] | select((.owner.login | ascii_downcase) as $l | $owners | index($l)) | .full_name' <<< "$listing")"
  if [ -n "$slugs" ]; then
    while IFS= read -r slug; do repos+=("$slug"); done <<< "$slugs"
  fi
  page=$((page + 1))
done
echo "repositories visible: ${#repos[@]}"
# An owner the token cannot see would otherwise drop out of the night without a word.
for owner in $OWNERS; do
  seen=0
  for slug in "${repos[@]}"; do
    if [[ "${slug,,}" == "${owner,,}/"* ]]; then seen=1; break; fi
  done
  if [ "$seen" -eq 0 ]; then
    echo "refused: the token sees no repository of $owner. A fine-grained token reaches one owner only, so GITHUB_BACKUP_TOKEN must be a classic token (repo scope) that sees every owner in: $OWNERS" >&2
    exit 1
  fi
done
# A token that lost access would otherwise back up less and less, in silence.
if [ "${#repos[@]}" -lt "$CODE_BACKUP_MIN_REPOS" ]; then
  echo "refused: the token sees ${#repos[@]} repositories, fewer than the $CODE_BACKUP_MIN_REPOS expected" >&2
  exit 1
fi

for slug in "${repos[@]}"; do
  # Each bundle sits under its owner, so two owners' repositories of one name never meet.
  mirror="$WORK/mirrors/$slug.git"
  bundle="$OUT/bundles/$slug.bundle"
  mkdir -p "$(dirname "$bundle")"
  git clone --quiet --mirror "https://github.com/$slug.git" "$mirror"
  refs="$(git -C "$mirror" for-each-ref | wc -l)"
  if [ "$refs" -eq 0 ]; then
    # An empty repository is recorded as empty, never counted as backed up.
    echo "EMPTY: $slug has no refs"
    printf '%s\t0\t0\tEMPTY\n' "$slug" >> "$MANIFEST"
    rm -rf "$mirror"
    continue
  fi
  git -C "$mirror" bundle create --quiet "$bundle" --all
  git -C "$mirror" bundle verify --quiet "$bundle"
  printf '%s\t%s\t%s\tOK\n' "$slug" "$refs" "$(stat -c %s "$bundle")" >> "$MANIFEST"
  echo "bundled: $slug refs=$refs"
  rm -rf "$mirror"
done

for slug in $RELEASE_REPOS; do
  dir="$OUT/releases/$slug"
  mkdir -p "$dir"
  github "https://api.github.com/repos/$slug/releases?per_page=100" \
    | jq -r '.[] | .tag_name as $t | .assets[] | [$t, .name, .url, .size] | @tsv' \
    | while IFS=$'\t' read -r tag asset url expected; do
        mkdir -p "$dir/$tag"
        github_asset "$dir/$tag/$asset" "$url"
        bytes="$(stat -c %s "$dir/$tag/$asset")"
        if [ "$bytes" != "$expected" ]; then
          echo "refused: $slug $tag $asset is $bytes bytes where GitHub lists $expected" >&2
          exit 1
        fi
        printf '%s\t%s\t%s\t%s\n' "$slug" "$tag" "$asset" "$bytes" >> "$RELEASE_MANIFEST"
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
# Listing a folder that does not exist fails, and weekly/ has none until the first Sunday.
rclone mkdir "backup:$FOLDER/weekly"
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"
echo "done"
