# Pagelove Shop

The storefront is a Pagelove HTML application. Payments use Stripe-hosted
Checkout through a celld service running on `pagelove-shop.exe.xyz`.

## Payment flow

1. The browser sends only product slugs, variants, quantities, and delivery
   details. It never supplies an amount that the service trusts.
2. The service reads current product documents from Pagelove and validates
   availability, variants, GBP prices, quantities, and shipping.
3. It creates an idempotent Stripe Checkout Session through an exe.dev private
   proxy, then writes the server-priced pending order to Pagelove WebDAV.
4. Stripe hosts the card form and redirects the shopper to their unguessable
   order URL.
5. The webhook handler verifies Stripe's HMAC over the raw request body and
   checks the Session id, order id, currency, and total before marking an order
   paid.

Stripe and Pagelove API keys live in exe.dev integrations and are never stored
in this repository, the celld VM, or a public Pagelove document. Only the
webhook signing secret is supplied to the celld process.

## Admin credential

The admin pages use HTTP Basic authentication. Pagelove compares the browser's
complete `Authorization` header with the value in `private/admin.html`.

The real `private/admin.html` is ignored by Git because its `authorization`
value is equivalent to the admin password. The committed
`private/admin.example.html` contains only an invalid placeholder.

Create the private file:

```sh
cp private/admin.example.html private/admin.html
```

Generate a strong password and the matching header value without placing the
password in your shell history:

```sh
ADMIN_PASSWORD=$(openssl rand -hex 24)
ADMIN_BASIC=$(printf 'owner:%s' "$ADMIN_PASSWORD" | base64 | tr -d '\n')
printf 'Username: owner\nPassword: %s\nAuthorization: Basic %s\n' \
  "$ADMIN_PASSWORD" "$ADMIN_BASIC"
unset ADMIN_PASSWORD ADMIN_BASIC
```

Save the generated password in a password manager. In `private/admin.html`:

1. replace `Basic REPLACE_WITH_BASE64_OWNER_COLON_PASSWORD` with the complete
   generated `Basic ...` value
2. leave the `username` value as `owner`, or regenerate the header using the
   same username if you change it

Base64 is encoding, not encryption. Never commit, paste into an issue, or share
the generated header value.

Deploy the credential separately from normal application files. From the
project copy on the `pagelove-shop` VM:

```sh
PAGELOVE_DEPLOY_FILES='private/admin.html' ./ops/deploy-pagelove.sh \
  /home/exedev/pagelove-shop \
  /home/exedev/pagelove-deploy-backups/admin-credential
```

Copy the ignored `private/admin.html` to that project directory before running
the command. The deployment script backs up the existing WebDAV document and
verifies the replacement by reading it back. Do not add the credential file to
the default deployment list.

## Local verification

```sh
cd worker
npm install
npm run check
```

See [`worker/README.md`](worker/README.md) for service configuration and
[`ops/`](ops/) for the exe.dev systemd setup.

## Pagelove deployment

Deploy application files through WebDAV, preserving their paths. Never deploy
the live `data/orders/` directory from a source checkout: it contains customer
orders and is deliberately absent locally. The Stripe integration changes these
Pagelove files:

- `admin-auth.html`
- `checkout.html`
- `js/shop.mjs`
- `rules.html`

The checkout endpoint in `checkout.html` is
`https://pagelove-shop.exe.xyz`.
