#!/bin/sh
set -eu

PROJECT_DIR=${1:-/home/exedev/pagelove-shop}
CONFIG_DIR=/etc/pagelove-shop
CELLD_DATA_DIR=/var/lib/pagelove-celld
MINIO_DATA_DIR=/var/lib/pagelove-minio

sudo apt-get update
sudo apt-get install -y ca-certificates curl nodejs npm openssl

curl -fsSL https://celld.dev/install.sh | sh
sudo install -m 0755 "$HOME/.local/bin/celld" /usr/local/bin/celld
sudo npm install --global esbuild@0.28.1

sudo install -d -m 0750 -o root -g exedev "$CONFIG_DIR"
sudo install -d -m 0750 -o exedev -g exedev "$CELLD_DATA_DIR"
sudo install -d -m 0750 -o root -g root "$MINIO_DATA_DIR"

if ! sudo test -f "$CONFIG_DIR/minio.env"; then
  storage_secret=$(openssl rand -hex 32)
  umask 077
  storage_file=$(mktemp)
  {
    printf 'MINIO_ROOT_USER=celld\n'
    printf 'MINIO_ROOT_PASSWORD=%s\n' "$storage_secret"
  } >"$storage_file"
  sudo install -m 0600 -o root -g root "$storage_file" "$CONFIG_DIR/minio.env"
  {
    printf 'AWS_ACCESS_KEY_ID=celld\n'
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$storage_secret"
    printf 'AWS_REGION=us-east-1\n'
    printf 'S3_ENDPOINT=http://127.0.0.1:9000\n'
    printf 'CELLD_BUCKET=s3://pagelove-celld\n'
  } >"$storage_file"
  sudo install -m 0640 -o root -g exedev "$storage_file" "$CONFIG_DIR/celld.env"
  rm -f "$storage_file"
fi

sudo install -m 0644 "$PROJECT_DIR/ops/minio.service" /etc/systemd/system/pagelove-minio.service
sudo install -m 0644 "$PROJECT_DIR/ops/celld.service" /etc/systemd/system/pagelove-celld.service
sudo docker pull minio/minio:latest
sudo docker pull minio/mc:latest
sudo systemctl daemon-reload
sudo systemctl enable --now pagelove-minio.service

attempt=0
until curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    sudo systemctl status --no-pager pagelove-minio.service
    exit 1
  fi
  sleep 1
done

sudo docker run --rm --network=host --env-file="$CONFIG_DIR/minio.env" --entrypoint=/bin/sh minio/mc:latest -c \
  'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing local/pagelove-celld'

if ! sudo test -f "$CONFIG_DIR/worker.env"; then
  printf '# CELLD_VAR_STRIPE_WEBHOOK_SECRET is added after the Stripe endpoint is created.\n' | \
    sudo tee "$CONFIG_DIR/worker.env" >/dev/null
  sudo chown root:exedev "$CONFIG_DIR/worker.env"
  sudo chmod 0640 "$CONFIG_DIR/worker.env"
fi

sudo systemctl enable pagelove-celld.service
sudo systemctl restart pagelove-celld.service
sudo systemctl --no-pager --full status pagelove-minio.service pagelove-celld.service
