# Stripe Checkout on celld

This module is the trusted payment boundary for the Pagelove shop. It is a
standard module Worker deployed to celld on the `pagelove-shop` exe.dev VM.

## Configuration

Public variables live in `wrangler.jsonc`:

- `SHOP_ORIGIN`: public Pagelove origin.
- `SHOP_WEBDAV_URL`: private exe.dev proxy for Pagelove WebDAV.
- `STRIPE_API_BASE`: private exe.dev Stripe API proxy.
- `STRIPE_MODE`: `test` until the shop is deliberately moved to live mode.

The exe.dev `stripe-api` and `pagelove-webdav` integrations inject their
authorization headers. celld never receives either API key. The Stripe webhook
signing secret is supplied as `CELLD_VAR_STRIPE_WEBHOOK_SECRET` in the VM's
root-owned `/etc/pagelove-shop/worker.env` file.

For direct local development only, copy `.dev.vars.example` to `.dev.vars` and
replace its placeholders. `.dev.vars` is ignored by Git.

## Deploy on exe.dev

The VM setup in `../ops/install-celld.sh` installs celld, esbuild, a private
loopback-only S3-compatible store, and systemd units. From the copied project:

```sh
./ops/install-celld.sh .
set -a
. /etc/pagelove-shop/celld.env
set +a
celld deploy ./worker \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"
sudo systemctl restart pagelove-celld.service
```

The public routes are:

- `GET /health`: non-secret deployment health and configured Stripe mode.
- `POST /checkout`: exact-origin CORS endpoint used by the storefront.
- `POST /webhook`: Stripe-only endpoint with raw-body signature verification.

## Stripe test mode

Create an exe.dev Stripe integration named `stripe-api`, attach it to the
`pagelove-shop` VM, and use a Stripe test secret or restricted key with Checkout
Session write access and Balance read access. The Balance permission lets the
service fail closed if a live key is accidentally attached while `STRIPE_MODE`
is `test`. Register this webhook destination:

`https://pagelove-shop.exe.xyz/webhook`

Subscribe it to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

After storing its `whsec_...` signing secret in `worker.env`, restart celld.
Use Stripe's documented test card `4242 4242 4242 4242`, any future expiry,
and any CVC. Confirm that the order changes from `pending` to `paid`, the basket
clears only on a successful return, and cancellation preserves it.
