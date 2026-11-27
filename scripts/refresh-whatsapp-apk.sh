#!/usr/bin/env bash
# Refresh WhatsApp on the rep-tablet server (phoenix-headwind, production) from the laptop.
#
# whatsapp.com answers Railway's servers with a ~49 KB web page instead of the APK, so the server can
# never fetch WhatsApp itself (memory: whatsapp-refuses-railway-so-the-apk-is-copied-onto-the-disk).
# This downloads the official current build HERE, and copies it onto the files disk only when it differs
# from what the server holds — hash-checked on arrival, the old copy kept as WhatsApp.apk.prev.
#
#   bash ~/.claude/scripts/refresh-whatsapp-apk.sh            # refresh if newer
#   DRY_RUN=1 bash ~/.claude/scripts/refresh-whatsapp-apk.sh  # download + compare only, writes nothing
#
# Exit 0 = current or refreshed and verified · 1 = failed (nothing half-written: the swap happens only
# after the hash matches) · 2 = cannot tell (download or server read failed).
set -u

URL="https://www.whatsapp.com/android/current/WhatsApp.apk"
MIN=83886080   # 80 MiB — the same floor the server's entrypoint uses
KEY="$HOME/.ssh/railway_phoenix_ed25519"
DIR="/usr/local/tomcat/work/files"
REPO="/f/Phoenix Workforce/phoenix-workforce"   # the folder linked to the Railway project
NAME="${NAME:-WhatsApp.apk}"   # NAME=other.apk only to test the copy path
PUBLIC="https://mdm.satopharma.com/files/$NAME"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
apk="$work/WhatsApp.apk"

echo "[whatsapp] downloading the official current build"
if ! curl -fsSL --retry 3 -o "$apk" "$URL"; then echo "[whatsapp] CANNOT TELL — download failed"; exit 2; fi
size=$(stat -c %s "$apk")
magic=$(head -c 2 "$apk")
if [ "$size" -lt "$MIN" ] || [ "$magic" != "PK" ]; then
  echo "[whatsapp] CANNOT TELL — got $size bytes, not an APK (whatsapp.com served a page?)"; exit 2
fi
sha=$(sha256sum "$apk" | cut -d' ' -f1)
echo "[whatsapp] downloaded $size bytes, sha256 ${sha:0:16}…"

cd "$REPO" || { echo "[whatsapp] CANNOT TELL — $REPO missing"; exit 2; }
remote=$(railway ssh -i "$KEY" -s phoenix-headwind -e production "sha256sum $DIR/$NAME 2>/dev/null || echo none" 2>/dev/null | tr -d '\r' | grep -Eo '^[0-9a-f]{64}|^none' | head -1)
if [ -z "$remote" ]; then echo "[whatsapp] CANNOT TELL — could not read the server's copy"; exit 2; fi
if [ "$remote" = "$sha" ]; then echo "[whatsapp] CURRENT — the server already holds this build"; exit 0; fi
echo "[whatsapp] server holds ${remote:0:16}…, newer build available"
if [ "${DRY_RUN:-}" = "1" ]; then echo "[whatsapp] DRY RUN — would copy it now; nothing written"; exit 0; fi

# One remote argument (railway ssh joins argv — memory: railway-ssh-joins-argv-and-lands-as-root).
out=$(railway ssh -i "$KEY" -s phoenix-headwind -e production \
  "cd $DIR && cat > .$NAME.part && echo '$sha  .$NAME.part' | sha256sum -c - >/dev/null && cp -f $NAME $NAME.prev 2>/dev/null; [ \"\$(sha256sum .$NAME.part | cut -d' ' -f1)\" = '$sha' ] && mv -f .$NAME.part $NAME && sha256sum $NAME || { rm -f .$NAME.part; echo HASHFAIL; }" \
  < "$apk" 2>&1 | tr -d '\r')
if ! printf '%s' "$out" | grep -q "^$sha"; then echo "[whatsapp] FAILED — the copy did not verify: $(printf '%s' "$out" | tail -2)"; exit 1; fi

[ "${SKIP_PUBLIC:-}" = "1" ] && { echo "[whatsapp] COPIED — public check skipped"; exit 0; }
len=$(curl -sI "$PUBLIC" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)
code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "$PUBLIC")
if [ "$len" != "$size" ]; then echo "[whatsapp] FAILED — public file answers $code with $len bytes, expected $size"; exit 1; fi
echo "[whatsapp] REFRESHED — $PUBLIC serves the new $size-byte build (old copy kept as WhatsApp.apk.prev)"
