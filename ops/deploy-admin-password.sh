#!/bin/sh
set -eu

if [ -z "${PAGELOVE_ADMIN_PASSWORD:-}" ]; then
  printf 'PAGELOVE_ADMIN_PASSWORD is required\n' >&2
  exit 1
fi

case "$PAGELOVE_ADMIN_PASSWORD" in
  *'
'*)
    printf 'PAGELOVE_ADMIN_PASSWORD must not contain a newline\n' >&2
    exit 1
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
BACKUP_DIR=${1:-"$PROJECT_DIR/.deployment-backups/admin-credential-$(date -u +%Y%m%dT%H%M%SZ)"}
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pagelove-admin.XXXXXX")

cleanup() {
  rm -f "$STAGING_DIR/private/admin.html"
  rmdir "$STAGING_DIR/private" "$STAGING_DIR" 2>/dev/null || true
}
trap cleanup 0
trap 'exit 1' 1 2 15

umask 077
mkdir -p "$STAGING_DIR/private"

admin_basic=$(printf 'owner:%s' "$PAGELOVE_ADMIN_PASSWORD" | base64 | tr -d '\r\n')
ADMIN_BASIC_VALUE=$admin_basic awk '
  {
    placeholder = "Basic REPLACE_WITH_BASE64_OWNER_COLON_PASSWORD"
    replacement = "Basic " ENVIRON["ADMIN_BASIC_VALUE"]
    sub(placeholder, replacement)
    print
  }
' "$PROJECT_DIR/private/admin.example.html" > "$STAGING_DIR/private/admin.html"
unset admin_basic ADMIN_BASIC_VALUE
chmod 0600 "$STAGING_DIR/private/admin.html"

PAGELOVE_DEPLOY_FILES='private/admin.html' \
PAGELOVE_DIRECTORIES_MANIFEST=/dev/null \
  "$SCRIPT_DIR/deploy-pagelove.sh" "$STAGING_DIR" "$BACKUP_DIR"
