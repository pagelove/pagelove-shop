# Pagelove Shop

Pagelove Shop is a complete storefront built from Pagelove HTML documents. It
provides a product catalogue, session baskets, Stripe Checkout, order tracking
and an authenticated admin area.

[Open the demo storefront](https://barn-hair-4926.onpagelove.com/).

## What the shop does

Customers can:

- browse products that are currently available
- view product images, options and prices
- add products to a basket that belongs to their browser session
- change quantities or remove products
- enter delivery details and pay through Stripe Checkout
- return to a private order confirmation page

Administrators can:

- view orders and payment status
- open the matching Checkout Session in Stripe
- mark orders as paid, fulfilled or cancelled
- create, edit and remove products
- upload and reorder product images

## Pagelove documents store the shop data

The shop does not use a separate catalogue database. Each product is an HTML
document under `data/products/`. Microdata fields hold the product name, stock
status, price, options and images.

Pagelove resource bindings find these records and render collections. The shop
home page uses a binding to list products that are available. The admin pages
use bindings to list products and orders.

The shared navigation is stored once in `partials.html`. Each page includes it
with `p:include`.

## Stamped elements build detail pages

Stamped elements let one route template display many records.

The product route at `products/:slug.html` finds the product whose slug matches
the URL. It stamps that product into the page with `p:stamp`. The browser then
uses the stamped microdata to build the image gallery, option selector and buy
panel.

Order confirmation and admin order pages work in the same way. They find an
order by its random reference and stamp the matching record into a shared page
template.

This approach provides:

- one route template for every product
- one route template for every order
- data that remains separate from presentation
- private source records with controlled public views

Raw order documents under `data/orders/` are not public. Pagelove composition
can stamp the matching order into its confirmation page without giving the
customer direct access to the source document.

## Transient elements hold each basket

The basket is the `#basket` element in `basket.html`. Its `p:transient`
attribute gives each visitor a separate session copy.

A basket update changes only that visitor session. It does not change the
default basket document or another customer basket.

The browser reads the current transient element, changes it and writes the
complete element back with `PUT`. A targeted `DELETE` empties the session
basket.

Transient content is not available to server-side resource bindings. The
browser therefore sends product references and quantities to the checkout
service. It does not send a price that the service trusts.

## Checkout uses current product data

[celld](https://celld.dev/) is a self-hosted runtime for Cloudflare-compatible
Workers and distributed Durable Objects. It runs application code on
infrastructure you control and stores durable state in an S3-compatible bucket
you own.

Checkout follows this sequence.

1. The browser sends basket references, quantities and delivery details to the celld service.
2. celld checks that the request came from the configured shop origin.
3. celld reads each current product document from Pagelove.
4. celld checks availability, options, quantities and prices, then calculates delivery.
5. celld creates an idempotent Stripe Checkout Session.
6. celld writes a server-priced pending order to Pagelove through WebDAV.
7. The browser sends the customer to the Stripe-hosted payment page.
8. Stripe sends the payment result to the webhook after checkout.
9. The confirmation page stamps the order and shows its current payment status.

The basket clears only after the customer returns from a successful checkout.
A cancelled checkout leaves the basket unchanged.

## The webhook has a durable responsibility

The webhook must keep working after the customer closes their browser. In
architectural terms, it has the responsibility of a durable object. It has a
stable address, owns payment updates and outlives any one page request.

This describes the service boundary, not a dependency on a particular cloud
product.

The concrete implementation uses celld on an exe.dev virtual machine:

- exe.dev exposes `https://pagelove-shop.exe.xyz` and sends requests to celld
- celld runs the JavaScript module that provides `/checkout` and `/webhook`
- a private S3-compatible MinIO service stores the celld deployment state
- systemd restarts celld and MinIO if either process stops
- private exe.dev integrations add Stripe and Pagelove credentials to outbound requests

Stripe sends signed events to `/webhook`. celld verifies the signature before
reading the event. It also checks the order reference, Checkout Session,
currency and total against the stored order.

celld updates the order through Pagelove WebDAV. It uses the document ETag to
avoid overwriting another update. Repeated or late events cannot move a paid or
fulfilled order back to cancelled.

The Stripe webhook signing secret lives in a root-owned file on the virtual
machine. Stripe and Pagelove API credentials stay in private exe.dev
integrations.

## Admin access protects customer data

The admin pages use HTTP Basic authentication. A Pagelove trigger compares the
browser `Authorization` header with the value in `private/admin.html`.

The real credential file is ignored by Git. The committed
`private/admin.example.html` contains only an invalid placeholder.

Rules deny public access to private configuration and raw order records. A
separate trigger checks the same admin credential before product, image or
order updates.

## Set up the admin credential

1. Generate a strong password and its complete Basic authorization value.

   ```sh
   ADMIN_PASSWORD=$(openssl rand -hex 24)
   ADMIN_BASIC=$(printf 'owner:%s' "$ADMIN_PASSWORD" | base64 | tr -d '\n')
   printf 'Username: owner\nPassword: %s\nAuthorization: Basic %s\n' \
     "$ADMIN_PASSWORD" "$ADMIN_BASIC"
   unset ADMIN_PASSWORD ADMIN_BASIC
   ```

2. Save the generated password in a password manager.

3. Add the complete `Basic ...` value to the `production` GitHub Environment as
   a secret named `PAGELOVE_ADMIN_AUTHORIZATION`.

GitHub Actions creates `private/admin.html` temporarily during deployment. The
value is not written to the repository. If the secret is not set, an existing
admin credential on Pagelove is left unchanged.

For a terminal deployment, copy `private/admin.example.html` to
`private/admin.html`, replace the placeholder with the complete value, and add
`private/admin.html` to `PAGELOVE_DEPLOY_FILES`. The real file remains ignored
by Git.

Base64 is encoding, not encryption. Never commit or share the generated header
value.

## Test the checkout service locally

Install the worker dependencies and run the checks:

```sh
cd worker
npm install
npm run check
```

The checks cover input validation, authoritative pricing, order documents,
Stripe form data, dashboard links and webhook signature verification.

## Deploy the application

The repository includes a GitHub Actions workflow that deploys the Pagelove
application through WebDAV. It runs after every push to `main`. You can also run
it manually from the repository's **Actions** page.

### Set up a fork

You must own the fork, or have admin access to it, to configure its environment.
Have these values ready:

- the WebDAV URL for your Pagelove host
- a Pagelove API key beginning with `pk_`
- the complete admin `Basic ...` authorization value, if you want to use the
  admin area

#### Create the environment

1. [Fork this repository](https://github.com/pagelove/pagelove-shop/fork).

2. Open the main page of your fork on GitHub.

3. Select **Settings** below the repository name. If **Settings** is hidden,
   open the repository navigation dropdown and select **Settings**.

4. Select **Environments** in the left sidebar.

5. Select **New environment**.

6. Enter `production` as the environment name. The workflow expects this exact
   name.

7. Select **Configure environment**.

You can add required reviewers or restrict deployment branches on this screen.
These protections are optional. If you restrict branches, allow `main` because
that is the branch the automatic deployment uses.

#### Add the WebDAV URL

1. On the `production` environment page, find **Environment variables**.

2. Select **Add variable**.

3. Enter `PAGELOVE_WEBDAV_URL` in the **Name** field.

4. Paste the complete WebDAV URL from the Pagelove console into the **Value**
   field.

5. Select **Add variable**.

The WebDAV URL is configuration, not a password. Add it as a variable, not a
secret.

#### Add the Pagelove API key

1. On the same environment page, find **Environment secrets**.

2. Select **Add secret**.

3. Enter `PAGELOVE_API_KEY` in the **Name** field.

4. Paste the Pagelove API key into the **Value** field. It must begin with
   `pk_`.

5. Select **Add secret**.

Do not add the API key as an environment variable. Variables are not masked in
workflow output.

#### Add the admin credential

This secret is optional. Without it, a new deployment has no usable admin
login. An existing admin credential on Pagelove is left unchanged.

1. Under **Environment secrets**, select **Add secret** again.

2. Enter `PAGELOVE_ADMIN_AUTHORIZATION` in the **Name** field.

3. Paste the complete generated value, including the `Basic ` prefix, into the
   **Value** field.

4. Select **Add secret**.

#### Run the first deployment

1. Select **Actions** below the repository name.

2. If GitHub says workflows are disabled for the fork, use the button on that
   page to enable them.

3. Select **Deploy to Pagelove** in the workflow list on the left.

4. If the workflow itself is disabled, open its menu and select **Enable
   workflow**.

5. Select **Run workflow** above the list of workflow runs.

6. Select the `main` branch, then select **Run workflow**.

Open the new workflow run to follow its progress. A successful run backs up the
existing application files, deploys the new versions and verifies them by
reading them back. Later pushes to `main` deploy automatically.

GitHub only makes
[environment secrets and variables](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
available to jobs that use that environment. The workflow does not run for
pull requests. The API key is sent to Pagelove as a Bearer authorization header
and is not printed or stored in the repository.

### What gets deployed

[`ops/pagelove-files.txt`](ops/pagelove-files.txt) lists the application files
that GitHub Actions deploys. [`ops/pagelove-directories.txt`](ops/pagelove-directories.txt)
lists empty writable collections that a new shop needs, including the order and
image collections.

The deployment script:

- creates missing WebDAV collections
- backs up files that already exist
- uploads the complete replacement files
- reads every file back and checks that it matches

It does not deploy local order data. The live `data/orders/` collection contains
customer orders and is deliberately ignored by Git.

### Deploy from a terminal

You can run the same deployment script without GitHub Actions. Set the WebDAV
URL, enter the API key without putting it in shell history, then run:

```sh
export PAGELOVE_WEBDAV_URL='https://YOUR-WEBDAV-URL/'
printf 'Pagelove API key: '
read -r -s PAGELOVE_API_KEY
printf '\n'
export PAGELOVE_API_KEY
./ops/deploy-pagelove.sh \
  . \
  .deployment-backups/manual
unset PAGELOVE_API_KEY PAGELOVE_WEBDAV_URL
```

Use the [celld deployment guide](worker/README.md) to install or update the
checkout service on exe.dev. The scripts in [`ops/`](ops/) configure celld,
MinIO, systemd and the Stripe webhook. The GitHub Actions workflow deploys the
Pagelove application only; each fork must configure its own checkout service to
take payments.

## Project structure

The main directories and files are:

- `data/products/` contains product records
- `products/:slug.html` stamps a product into its public route
- `basket.html` contains the transient basket element
- `orders/:id.html` stamps an order into its confirmation route
- `admin/` contains order and product management pages
- `js/shop.mjs` provides the storefront and admin browser behaviour
- `worker/` contains the celld checkout and webhook module
- `ops/` contains exe.dev installation and deployment scripts
- `.github/workflows/` contains the automatic Pagelove deployment workflow
- `rules.html` defines access rules
- `constraints.html` limits the accepted order document shape
- `admin-auth.html` applies the admin credential checks
