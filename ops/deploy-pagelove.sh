#!/bin/sh
set -eu

PROJECT_DIR=${1:-.}
BACKUP_DIR=${2:-"$PROJECT_DIR/.deployment-backups/$(date -u +%Y%m%dT%H%M%SZ)"}

if [ -z "${PAGELOVE_WEBDAV_URL:-}" ]; then
  printf 'PAGELOVE_WEBDAV_URL is required\n' >&2
  exit 1
fi

WEBDAV_URL=${PAGELOVE_WEBDAV_URL%/}/
FILES_MANIFEST=${PAGELOVE_DEPLOY_MANIFEST:-"$PROJECT_DIR/ops/pagelove-files.txt"}
DIRECTORIES_MANIFEST=${PAGELOVE_DIRECTORIES_MANIFEST:-"$PROJECT_DIR/ops/pagelove-directories.txt"}

if [ -n "${PAGELOVE_DEPLOY_FILES:-}" ]; then
  FILES=$PAGELOVE_DEPLOY_FILES
elif [ -f "$FILES_MANIFEST" ]; then
  FILES=$(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$FILES_MANIFEST")
else
  printf 'Deployment manifest not found: %s\n' "$FILES_MANIFEST" >&2
  exit 1
fi

if [ -f "$DIRECTORIES_MANIFEST" ]; then
  DIRECTORIES=$(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$DIRECTORIES_MANIFEST")
else
  DIRECTORIES=
fi

if [ -z "$FILES" ]; then
  printf 'No files selected for deployment\n' >&2
  exit 1
fi

pagelove_curl() {
  if [ -n "${PAGELOVE_API_KEY:-}" ]; then
    curl -H "Authorization: Bearer $PAGELOVE_API_KEY" "$@"
  else
    curl "$@"
  fi
}

validate_relative_path() {
  case "$1" in
    ''|/*|..|../*|*/..|*/../*)
      printf 'Unsafe deployment path: %s\n' "$1" >&2
      exit 1
      ;;
  esac
}

mkdir -p "$BACKUP_DIR"

for path in $FILES; do
  validate_relative_path "$path"
  if [ ! -f "$PROJECT_DIR/$path" ]; then
    printf 'Deployment file not found: %s\n' "$PROJECT_DIR/$path" >&2
    exit 1
  fi

  parent_dir=${path%/*}
  if [ "$parent_dir" != "$path" ]; then
    mkdir -p "$BACKUP_DIR/$parent_dir"
  fi
done

ensure_collection() {
  collection_path=${1%/}
  validate_relative_path "$collection_path"
  current_collection=
  old_ifs=$IFS
  IFS=/
  set -- $collection_path
  IFS=$old_ifs

  for collection_part do
    [ -n "$collection_part" ] || continue
    current_collection="${current_collection}${collection_part}/"
    response_file="$BACKUP_DIR/mkcol-response.html"
    status=$(pagelove_curl -sS -o "$response_file" -w '%{http_code}' \
      -X MKCOL "${WEBDAV_URL}${current_collection}")
    case "$status" in
      2??|405) ;;
      *)
        printf 'MKCOL %s failed with HTTP %s\n' "$current_collection" "$status" >&2
        sed -n '1,20p' "$response_file" >&2
        exit 1
        ;;
    esac
  done
}

for path in $DIRECTORIES; do
  ensure_collection "$path"
done

for path in $FILES; do
  parent_dir=${path%/*}
  if [ "$parent_dir" != "$path" ]; then
    ensure_collection "$parent_dir"
  fi
done

if [ "${PAGELOVE_SKIP_BACKUP:-0}" != 1 ]; then
  for path in $FILES; do
    backup_file="$BACKUP_DIR/$path"
    response_file="$BACKUP_DIR/get-response.html"
    status=$(pagelove_curl -sS -o "$response_file" -w '%{http_code}' \
      "${WEBDAV_URL}${path}")
    case "$status" in
      2??)
        mv "$response_file" "$backup_file"
        printf 'BACKUP %s -> saved\n' "$path"
        ;;
      404)
        rm -f "$response_file"
        printf 'BACKUP %s -> not present\n' "$path"
        ;;
      *)
        printf 'GET %s failed with HTTP %s\n' "$path" "$status" >&2
        sed -n '1,20p' "$response_file" >&2
        exit 1
        ;;
    esac
  done
fi

if [ "${PAGELOVE_VERIFY_ONLY:-0}" != 1 ]; then
  for path in $FILES; do
    response_file="$BACKUP_DIR/put-response.html"
    content_type='text/html; charset=utf-8'
    case "$path" in
      *.css) content_type='text/css; charset=utf-8' ;;
      *.js|*.mjs) content_type='text/javascript; charset=utf-8' ;;
      *.json) content_type='application/json' ;;
    esac
    status=$(pagelove_curl -sS -o "$response_file" -w '%{http_code}' \
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
  verify_file="$BACKUP_DIR/verify-$path"
  verify_parent=${verify_file%/*}
  if [ "$verify_parent" != "$verify_file" ]; then
    mkdir -p "$verify_parent"
  fi
  status=$(pagelove_curl -sS -o "$verify_file" -w '%{http_code}' \
    "${WEBDAV_URL}${path}")
  case "$status" in
    2??) ;;
    *)
      printf 'Read-back GET %s failed with HTTP %s\n' "$path" "$status" >&2
      exit 1
      ;;
  esac
  if ! cmp -s "$PROJECT_DIR/$path" "$verify_file"; then
    printf 'Read-back mismatch: %s\n' "$path" >&2
    exit 1
  fi
  printf 'VERIFY %s -> exact match\n' "$path"
  rm -f "$verify_file"
done

rm -f "$BACKUP_DIR/get-response.html" \
  "$BACKUP_DIR/mkcol-response.html" \
  "$BACKUP_DIR/put-response.html"
printf 'Backup: %s\n' "$BACKUP_DIR"
