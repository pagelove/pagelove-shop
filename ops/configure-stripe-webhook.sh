#!/bin/sh
set -eu

STRIPE_PROXY=${STRIPE_PROXY:-https://stripe-api.int.exe.xyz/}
WEBHOOK_URL=${WEBHOOK_URL:-https://pagelove-shop.exe.xyz/webhook}
WORKER_ENV=${WORKER_ENV:-/etc/pagelove-shop/worker.env}

response_file=$(mktemp)
secret_file=$(mktemp)
cleanup() {
  rm -f "$response_file" "$secret_file"
}
trap cleanup EXIT HUP INT TERM
chmod 0600 "$response_file" "$secret_file"

status=$(curl -sS -o "$response_file" -w '%{http_code}' \
  -X POST "${STRIPE_PROXY}v1/webhook_endpoints" \
  --data-urlencode "url=$WEBHOOK_URL" \
  --data-urlencode 'description=Pagelove Shop celld checkout' \
  --data-urlencode 'enabled_events[]=checkout.session.completed' \
  --data-urlencode 'enabled_events[]=checkout.session.async_payment_succeeded' \
  --data-urlencode 'enabled_events[]=checkout.session.async_payment_failed' \
  --data-urlencode 'enabled_events[]=checkout.session.expired')

if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  printf 'Stripe webhook creation failed with HTTP %s\n' "$status" >&2
  python3 - "$response_file" <<'PY' >&2
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    payload = json.load(source)
print(payload.get("error", {}).get("message", "Unknown Stripe error"))
PY
  exit 1
fi

webhook_id=$(python3 - "$response_file" "$secret_file" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    payload = json.load(source)
secret = payload.get("secret")
webhook_id = payload.get("id")
if not secret or not webhook_id:
    raise SystemExit("Stripe response did not contain a webhook id and signing secret")
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as output:
    output.write(f"CELLD_VAR_STRIPE_WEBHOOK_SECRET={secret}\n")
print(webhook_id)
PY
)

sudo install -m 0640 -o root -g exedev "$secret_file" "$WORKER_ENV"
sudo systemctl restart pagelove-celld.service
printf 'Created Stripe test webhook %s and restarted celld\n' "$webhook_id"
