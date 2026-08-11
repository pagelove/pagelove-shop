#!/bin/sh
set -eu

PROJECT_DIR=${1:-/home/exedev/pagelove-shop}
BACKUP_DIR=${2:-/tmp/pagelove-shop-before-stripe}
WEBDAV_URL=${PAGELOVE_WEBDAV_URL:-https://pagelove-webdav.int.exe.xyz/}

FILES=${PAGELOVE_DEPLOY_FILES:-'admin-auth.html
checkout.html
js/shop.mjs
rules.html'}

mkdir -p "$BACKUP_DIR"
for path in $FILES; do
  parent_dir=${path%/*}
  if [ "$parent_dir" != "$path" ]; then
    mkdir -p "$BACKUP_DIR/$parent_dir"
  fi
done

if [ "${PAGELOVE_SKIP_BACKUP:-0}" != 1 ]; then
  for path in $FILES; do
    curl -fsS "${WEBDAV_URL}${path}" -o "$BACKUP_DIR/$path"
  done
fi

if [ "${PAGELOVE_VERIFY_ONLY:-0}" != 1 ]; then
  for path in $FILES; do
    response_file="$BACKUP_DIR/put-response.html"
    content_type='text/html; charset=utf-8'
    case "$path" in
      *.mjs) content_type='text/javascript; charset=utf-8' ;;
    esac
    status=$(curl -sS -o "$response_file" -w '%{http_code}' \
      -X PUT "${WEBDAV_URL}${path}" \
      -H "Content-Type: $content_type" \
      --data-binary "@$PROJECT_DIR/$path")
    case "$status" in
      2??) ;;
      *)
        printf 'PUT %s failed with HTTP %s\n' "$path" "$status" >&2
        sed -n '1,20p' "$response_file" >&2
        exit 1
        ;;
    esac
    printf 'PUT %s -> %s\n' "$path" "$status"
  done
fi

for path in $FILES; do
  verify_file="$BACKUP_DIR/verify-${path##*/}"
  curl -fsS "${WEBDAV_URL}${path}" -o "$verify_file"
  if ! cmp -s "$PROJECT_DIR/$path" "$verify_file"; then
    printf 'Read-back mismatch: %s\n' "$path" >&2
    exit 1
  fi
  printf 'VERIFY %s -> exact match\n' "$path"
done

rm -f "$BACKUP_DIR/put-response.html" "$BACKUP_DIR"/verify-*
printf 'Backup: %s\n' "$BACKUP_DIR"
