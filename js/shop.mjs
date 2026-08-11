// Pagelove Shop — storefront, transient basket, and checkout.
//
// THE BASKET IS A TRANSIENT ELEMENT (#basket on /basket.html). Every visitor,
// signed in or not, gets their own copy of that element keyed to their session
// cookie. Two platform facts shape everything here:
//
//   • Writes are read-modify-write PUTs scoped to #basket. Appending with POST
//     into a transient element is NOT documented, so we never do it.
//   • Transient content is invisible to Resource Binding, so the server cannot
//     see a basket. Checkout reads it here and sends it as the order body.
//
// Money is in PENCE everywhere, which is also Stripe's convention — an order line
// can be handed to Stripe without re-deriving amounts.

const BASKET_URL = '/basket.html';
const BASKET_SEL = '#basket';
const ORDER_TYPE = 'https://shop.example/Order';
const CHECKOUT_ENDPOINT = typeof document === 'undefined'
  ? ''
  : document.querySelector('meta[name="stripe-checkout-endpoint"]')?.content || '';

const money = (pence) => '£' + (pence / 100).toFixed(2);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};

// ---- basket storage ---------------------------------------------------------
// A line is one <li> of data-* attributes: enough to render the basket without
// re-reading the catalogue, and enough to build an order.
function lineEl(l) {
  return el('li', {
    'data-sku': l.sku, 'data-slug': l.slug, 'data-name': l.name,
    'data-variant': l.variant || '', 'data-emoji': l.emoji || '',
    'data-price': String(l.price), 'data-qty': String(l.qty),
  });
}
function readLines(root) {
  return [...root.querySelectorAll('li')].map((li) => ({
    sku: li.dataset.sku, slug: li.dataset.slug, name: li.dataset.name,
    variant: li.dataset.variant || '', emoji: li.dataset.emoji || '',
    price: Number(li.dataset.price) || 0, qty: Number(li.dataset.qty) || 0,
  })).filter((l) => l.sku && l.qty > 0);
}
export async function getBasket() {
  // A plain read of the transient element returns THIS session's copy.
  const res = await fetch(BASKET_URL, {
    headers: { Range: 'selector=' + BASKET_SEL }, credentials: 'same-origin', cache: 'no-store',
  });
  if (!res.ok) return [];
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const ul = doc.querySelector('#basket') || doc.body;
  return readLines(ul);
}
async function putBasket(lines) {
  // The replacement must still match #basket or the platform answers 422 —
  // that is the documented "preserve the element's identity" rule.
  const ul = el('ul', { id: 'basket' });
  for (const l of lines) ul.append(lineEl(l));
  const res = await fetch(BASKET_URL, {
    method: 'PUT', credentials: 'same-origin', cache: 'no-store',
    headers: { Range: 'selector=' + BASKET_SEL, 'Content-Type': 'text/html' },
    body: ul.outerHTML,
  });
  if (!res.ok) throw new Error('basket write failed (' + res.status + ')');
  paintCount(lines);
  return lines;
}
export async function addToBasket(item) {
  const lines = await getBasket();
  const key = (l) => l.sku + '|' + (l.variant || '');
  const found = lines.find((l) => key(l) === key(item));
  if (found) found.qty += item.qty; else lines.push({ ...item });
  return putBasket(lines);
}
async function setQty(sku, variant, qty) {
  const lines = (await getBasket())
    .map((l) => (l.sku === sku && l.variant === variant ? { ...l, qty } : l))
    .filter((l) => l.qty > 0);
  return putBasket(lines);
}
async function emptyBasket() {
  // DELETE on a transient element drops the session copy back to the document default.
  await fetch(BASKET_URL, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
    headers: { Range: 'selector=' + BASKET_SEL } });
  paintCount([]);
}
const subtotal = (lines) => lines.reduce((n, l) => n + l.price * l.qty, 0);
const SHIPPING = 495;
const shippingFor = (lines) => (lines.length === 0 || subtotal(lines) >= 5000 ? 0 : SHIPPING);

function paintCount(lines) {
  const n = lines.reduce((t, l) => t + l.qty, 0);
  for (const b of document.querySelectorAll('[data-basket-count]')) b.textContent = String(n);
}

// ---- product page -----------------------------------------------------------
function productPage() {
  const root = document.querySelector('[data-product-page]');
  if (!root) return;
  const p = root.querySelector('[itemtype="https://shop.example/Product"]');
  if (!p) {
    root.replaceChildren(el('div', { class: 'empty' }, el('h1', { text: 'Not found' }),
      el('p', { text: 'We do not stock that one.' }), el('a', { href: '/index.html', text: '← Back to the shop' })));
    return;
  }
  const c = (n) => p.querySelector(`[itemprop="${n}"]`)?.getAttribute('content') || '';
  const variants = [...p.querySelectorAll('[itemprop="variant"]')].map((m) => m.getAttribute('content')).filter(Boolean);
  const item = { sku: c('sku'), slug: c('slug'), name: p.querySelector('[itemprop="name"]')?.textContent.trim() || '',
                 emoji: c('emoji'), price: Number(c('price')) || 0 };

  const vSel = el('select', { 'aria-label': 'Variant' });
  for (const v of variants) vSel.append(el('option', { value: v, text: v }));
  const qty = el('input', { type: 'number', min: '1', max: '20', value: '1', 'aria-label': 'Quantity' });
  const note = el('p', { class: 'note' });
  const add = el('button', { class: 'btn btn-wide', type: 'button', text: 'Add to basket' });
  add.addEventListener('click', async () => {
    add.disabled = true; note.removeAttribute('data-tone'); note.textContent = 'Adding…';
    try {
      await addToBasket({ ...item, variant: vSel.value || '', qty: Math.max(1, Number(qty.value) || 1) });
      note.setAttribute('data-tone', 'ok'); note.textContent = 'Added. ';
      note.append(el('a', { href: '/basket.html', text: 'View basket →' }));
    } catch (err) {
      note.setAttribute('data-tone', 'err'); note.textContent = 'Could not add that — please try again.';
    }
    add.disabled = false;
  });

  const shots = [...p.querySelectorAll('[itemprop="image"]')].map((m) => m.getAttribute('content')).filter(Boolean);
  let stage;
  if (shots.length) {
    const main = el('img', { src: shots[0], alt: item.name, class: 'shot-main' });
    const rail = el('div', { class: 'rail' }, ...shots.map((u, i) => {
      const b = el('button', { type: 'button', class: 'rail-b' + (i === 0 ? ' on' : ''), 'aria-label': 'View image ' + (i + 1) },
        el('img', { src: u, alt: '' }));
      b.addEventListener('click', () => {
        main.src = u;
        for (const o of rail.children) o.classList.toggle('on', o === b);
      });
      return b;
    }));
    stage = el('div', { class: 'shot shot-gallery' }, main, shots.length > 1 ? rail : null);
  } else {
    stage = el('div', { class: 'shot', text: item.emoji });
  }
  root.replaceChildren(el('div', { class: 'product' },
    stage,
    el('div', {},
      el('p', { class: 'cat', text: c('category') }),
      el('h1', { text: item.name }),
      el('p', { class: 'price', text: money(item.price) }),
      el('p', { class: 'desc', text: p.querySelector('[itemprop="description"]')?.textContent.trim() || '' }),
      variants.length > 1 ? el('label', { text: 'Options', for: '' }) : null,
      variants.length > 1 ? vSel : null,
      el('label', { text: 'Quantity' }), qty,
      el('div', { style: 'margin-top:1.2rem' }, add),
      note,
      el('p', { class: 'note' }, el('a', { href: '/index.html', text: '← All products' })))));
}

// ---- basket page ------------------------------------------------------------
async function basketPage() {
  const root = document.querySelector('[data-basket-view]');
  if (!root) return;
  const lines = await getBasket();
  paintCount(lines);
  if (!lines.length) {
    root.replaceChildren(el('div', { class: 'empty' }, el('p', { text: 'Your basket is empty.' }),
      el('p', {}, el('a', { href: '/index.html', text: 'Browse the shop →' }))));
    return;
  }
  const list = el('div');
  for (const l of lines) {
    const dec = el('button', { type: 'button', 'aria-label': 'One fewer', text: '−' });
    const inc = el('button', { type: 'button', 'aria-label': 'One more', text: '+' });
    const rm = el('button', { type: 'button', 'aria-label': 'Remove', text: '×' });
    dec.addEventListener('click', () => setQty(l.sku, l.variant, l.qty - 1).then(basketPage));
    inc.addEventListener('click', () => setQty(l.sku, l.variant, l.qty + 1).then(basketPage));
    rm.addEventListener('click', () => setQty(l.sku, l.variant, 0).then(basketPage));
    list.append(el('div', { class: 'line' },
      el('span', { class: 'em', text: l.emoji }),
      el('span', {}, el('span', { class: 'nm', text: l.name }),
        l.variant ? el('span', { class: 'vr', text: ' · ' + l.variant }) : null),
      el('span', { class: 'qty' }, dec, el('span', { text: String(l.qty) }), inc, rm),
      el('span', { class: 'amt', text: money(l.price * l.qty) })));
  }
  const ship = shippingFor(lines);
  const totals = el('div', { class: 'totals' },
    el('div', {}, el('span', { text: 'Subtotal' }), el('span', { text: money(subtotal(lines)) })),
    el('div', {}, el('span', { text: 'Shipping' }), el('span', { text: ship ? money(ship) : 'Free' })),
    el('div', { class: 'grand' }, el('span', { text: 'Total' }), el('span', { text: money(subtotal(lines) + ship) })));
  const clear = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Empty basket' });
  clear.addEventListener('click', () => emptyBasket().then(basketPage));
  root.replaceChildren(list, totals,
    el('div', { style: 'display:flex;gap:.8rem;flex-wrap:wrap' },
      el('a', { class: 'btn', href: '/checkout.html', text: 'Checkout →' }), clear));
}

// ---- checkout ---------------------------------------------------------------
const token = () => [...crypto.getRandomValues(new Uint8Array(12))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function checkoutPage() {
  const root = document.querySelector('[data-checkout-page]');
  if (!root) return;
  const form = root.querySelector('[data-checkout-form]');
  const summary = root.querySelector('[data-checkout-summary]');
  const note = root.querySelector('[data-checkout-note]');
  let lines = await getBasket();
  paintCount(lines);

  const paint = () => {
    const ship = shippingFor(lines);
    summary.replaceChildren(el('h2', { text: 'Order summary' }),
      ...lines.map((l) => el('div', { class: 'line' },
        el('span', { class: 'em', text: l.emoji }),
        el('span', {}, el('span', { class: 'nm', text: l.name }),
          el('span', { class: 'vr', text: (l.variant ? l.variant + ' · ' : '') + '×' + l.qty })),
        el('span', {}), el('span', { class: 'amt', text: money(l.price * l.qty) }))),
      el('div', { class: 'totals' },
        el('div', {}, el('span', { text: 'Subtotal' }), el('span', { text: money(subtotal(lines)) })),
        el('div', {}, el('span', { text: 'Shipping' }), el('span', { text: ship ? money(ship) : 'Free' })),
        el('div', { class: 'grand' }, el('span', { text: 'Total' }), el('span', { text: money(subtotal(lines) + ship) }))));
  };
  paint();
  if (new URLSearchParams(location.search).get('checkout') === 'cancelled') {
    note.setAttribute('data-tone', 'err');
    note.textContent = 'Payment was cancelled. Your basket is unchanged.';
  }
  if (!lines.length) {
    form.querySelector('button[type=submit]').disabled = true;
    note.textContent = 'Your basket is empty — add something first.';
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; note.removeAttribute('data-tone'); note.textContent = 'Opening secure payment…';
    const f = (n) => form.elements[n].value.trim();
    if (!CHECKOUT_ENDPOINT || CHECKOUT_ENDPOINT.includes('YOUR-SUBDOMAIN')) {
      btn.disabled = false;
      note.setAttribute('data-tone', 'err');
      note.textContent = 'Secure checkout is not configured yet.';
      return;
    }
    try {
      const endpoint = new URL('/checkout', CHECKOUT_ENDPOINT);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: token(),
          email: f('email'),
          customerName: f('name'),
          line1: f('line1'),
          city: f('city'),
          postcode: f('postcode'),
          country: f('country'),
          // Prices, names, and totals are deliberately omitted. The service reads
          // the live Pagelove product documents and calculates them server-side.
          lines: lines.map((line) => ({ slug: line.slug, variant: line.variant, quantity: line.qty })),
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.url) throw new Error(result.error || 'Secure payment could not be opened.');
      location.assign(result.url);
    } catch (error) {
      btn.disabled = false;
      note.setAttribute('data-tone', 'err');
      note.textContent = error.message || 'Secure payment could not be opened. Nothing has been charged.';
    }
  });
}

// ---- order confirmation -----------------------------------------------------
async function orderPage() {
  const root = document.querySelector('[data-order-page]');
  if (!root) return;
  const o = root.querySelector('[itemtype="' + ORDER_TYPE + '"]');
  if (!o) {
    root.replaceChildren(el('h1', { text: 'Order not found' }),
      el('p', { text: 'That order reference does not match anything we hold.' }),
      el('p', {}, el('a', { href: '/index.html', text: '← Back to the shop' })));
    return;
  }
  const c = (n) => o.querySelector(`[itemprop="${n}"]`)?.getAttribute('content') || '';
  const lines = [...o.querySelectorAll('[itemtype="https://shop.example/OrderLine"]')].map((li) => {
    const g = (n) => li.querySelector(`[itemprop="${n}"]`)?.getAttribute('content') || '';
    return { name: g('name'), variant: g('variant'), qty: Number(g('quantity')), total: Number(g('lineTotal')) };
  });
  const status = c('paymentStatus');
  const paid = status === 'paid' || status === 'fulfilled';
  const cancelled = status === 'cancelled';
  if (new URLSearchParams(location.search).get('checkout') === 'success') {
    await emptyBasket().catch(() => {});
  }
  root.replaceChildren(
    el('span', { class: 'badge', text: paid ? (status === 'fulfilled' ? 'Fulfilled' : 'Paid') : (cancelled ? 'Cancelled' : 'Confirming payment') }),
    el('h1', { text: paid ? 'Thank you — your order is paid' : (cancelled ? 'Payment cancelled' : 'We’re confirming your payment'), style: 'letter-spacing:-.02em' }),
    el('p', { class: 'desc', text: 'Keep this page — it is your receipt. We have your details as ' + c('email') + '.' }),
    el('dl', { class: 'kv' },
      el('dt', { text: 'Order' }), el('dd', { text: c('orderId') }),
      el('dt', { text: 'Placed' }), el('dd', { text: (c('placedAt') || '').slice(0, 10) }),
      el('dt', { text: 'Deliver to' }), el('dd', { text: [c('customerName'), c('line1'), c('city'), c('postcode'), c('country')].filter(Boolean).join(', ') }),
      el('dt', { text: 'Payment' }), el('dd', { text: paid ? 'Paid in full' : (cancelled ? 'The Stripe Checkout Session expired or the payment failed.' : 'Stripe is still confirming the payment. This page will update automatically.') })),
    el('h2', { class: 'panel-h', text: 'Items', style: 'font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--faint)' }),
    ...lines.map((l) => el('div', { class: 'line' },
      el('span', {}), el('span', {}, el('span', { class: 'nm', text: l.name }),
        el('span', { class: 'vr', text: (l.variant ? l.variant + ' · ' : '') + '×' + l.qty })),
      el('span', {}), el('span', { class: 'amt', text: money(l.total) }))),
    el('div', { class: 'totals' },
      el('div', {}, el('span', { text: 'Subtotal' }), el('span', { text: money(Number(c('subtotal'))) })),
      el('div', {}, el('span', { text: 'Shipping' }), el('span', { text: Number(c('shipping')) ? money(Number(c('shipping'))) : 'Free' })),
      el('div', { class: 'grand' }, el('span', { text: 'Total' }), el('span', { text: money(Number(c('amountTotal'))) }))),
    el('p', { class: 'note' }, el('a', { href: '/index.html', text: '← Continue shopping' })));

  if (!paid && !cancelled && new URLSearchParams(location.search).get('checkout') === 'success') {
    let attempts = 0;
    const check = async () => {
      attempts += 1;
      try {
        const response = await fetch(location.pathname + '?cb=' + Date.now(), { cache: 'no-store' });
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const next = doc.querySelector('[itemprop="paymentStatus"]')?.getAttribute('content');
        if (next && next !== 'pending') {
          location.replace(location.pathname + '?checkout=success&cb=' + Date.now());
          return;
        }
      } catch {}
      if (attempts < 12) setTimeout(check, 2000);
    };
    setTimeout(check, 2000);
  }
}


// ---- admin: orders ----------------------------------------------------------
// Reached only through the Basic-auth gate in /admin-auth.html; this host has no
// identity provider, so an AuthorizationRule alone could not keep orders private.
const STATUS_LABEL = { pending: 'Awaiting payment', paid: 'Paid', fulfilled: 'Fulfilled', cancelled: 'Cancelled' };

export function stripeCheckoutDashboardUrl(reference) {
  const match = /^cs_(test|live)_[A-Za-z0-9]+$/.exec(reference || '');
  if (!match) return '';
  const mode = match[1] === 'test' ? '/test' : '';
  return `https://dashboard.stripe.com${mode}/checkout/sessions/${encodeURIComponent(reference)}`;
}

function adminOrders() {
  const root = document.querySelector('[data-admin-orders]');
  if (!root) return;
  const rows = [...root.querySelectorAll('.admin-row')].map((li) => ({ ...li.dataset }));
  const list = root.querySelector('.admin-list');
  if (!rows.length) {
    list.replaceWith(el('div', { class: 'empty' }, el('p', { text: 'No orders yet.' })));
    return;
  }
  const revenue = rows.filter((r) => r.status !== 'cancelled').reduce((n, r) => n + Number(r.total || 0), 0);
  root.querySelector('.admin-head').append(
    el('p', { class: 'note', text: rows.length + (rows.length === 1 ? ' order · ' : ' orders · ') + money(revenue) + ' total' }));
  list.replaceChildren(...rows.map((r) => el('li', { class: 'line' },
    el('span', {}, el('a', { class: 'nm', href: '/admin/orders/' + r.order + '.html', text: r.order.slice(0, 12) + '…' }),
      el('span', { class: 'vr', text: ' · ' + (r.name || 'unknown') + ' · ' + (r.email || '') })),
    el('span', { class: 'badge', text: STATUS_LABEL[r.status] || r.status }),
    el('span', { class: 'vr', text: (r.placed || '').slice(0, 10) }),
    el('span', { class: 'amt', text: money(Number(r.total || 0)) }))));
}

function adminOrder() {
  const root = document.querySelector('[data-admin-order]');
  if (!root) return;
  const o = root.querySelector('[itemtype="' + ORDER_TYPE + '"]');
  if (!o) {
    root.replaceChildren(el('p', { class: 'note' }, el('a', { href: '/admin/index.html', text: '← All orders' })),
      el('h1', { text: 'No such order' }));
    return;
  }
  const c = (n) => o.querySelector(`[itemprop="${n}"]`)?.getAttribute('content') || '';
  const id = c('orderId');
  const status = c('paymentStatus');
  const lines = [...o.querySelectorAll('[itemtype="https://shop.example/OrderLine"]')].map((li) => {
    const g = (n) => li.querySelector(`[itemprop="${n}"]`)?.getAttribute('content') || '';
    return { name: g('name'), variant: g('variant'), sku: g('sku'), qty: Number(g('quantity')), total: Number(g('lineTotal')) };
  });

  const note = el('p', { class: 'note' });
  const mark = (next, label) => {
    const b = el('button', { class: 'btn' + (next === 'cancelled' ? ' btn-ghost' : ''), type: 'button', text: label });
    b.addEventListener('click', async () => {
      b.disabled = true; note.removeAttribute('data-tone'); note.textContent = 'Updating…';
      // One selector PUT replaces just the status meta on the stored order.
      const res = await fetch('/data/orders/' + id + '.html', {
        method: 'PUT', credentials: 'same-origin', cache: 'no-store',
        headers: { Range: 'selector=[itemprop="paymentStatus"]', 'Content-Type': 'text/html' },
        body: '<meta itemprop="paymentStatus" content="' + next + '">',
      });
      if (res.ok) { location.reload(); return; }
      b.disabled = false; note.setAttribute('data-tone', 'err');
      note.textContent = 'Could not update the order (' + res.status + ').';
    });
    return b;
  };

  const dl = el('dl', { class: 'kv' });
  const kv = (k, v) => dl.append(el('dt', { text: k }), el('dd', {}, v || '—'));
  kv('Order', id);
  kv('Placed', (c('placedAt') || '').replace('T', ' ').slice(0, 16));
  kv('Customer', c('customerName'));
  kv('Email', c('email'));
  kv('Deliver to', [c('line1'), c('city'), c('postcode'), c('country')].filter(Boolean).join(', '));
  const paymentReference = c('paymentReference');
  const stripeUrl = c('paymentProvider') === 'stripe' ? stripeCheckoutDashboardUrl(paymentReference) : '';
  const payment = el('span', {}, (STATUS_LABEL[status] || status) + ' · ' + c('paymentProvider'));
  if (paymentReference) {
    payment.append(' · ', stripeUrl
      ? el('a', {
        href: stripeUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': `View Stripe checkout session ${paymentReference}`,
        text: 'View in Stripe',
      })
      : paymentReference);
  }
  kv('Payment', payment);

  root.replaceChildren(
    el('p', { class: 'note' }, el('a', { href: '/admin/index.html', text: '← All orders' })),
    el('div', { class: 'admin-head' },
      el('h1', { text: 'Order ' + id.slice(0, 12) + '…' }),
      el('span', { class: 'badge', text: STATUS_LABEL[status] || status })),
    dl,
    el('h2', { class: 'panel-h', style: 'font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--faint)', text: 'Items' }),
    ...lines.map((l) => el('div', { class: 'line' },
      el('span', {}), el('span', {}, el('span', { class: 'nm', text: l.name }),
        el('span', { class: 'vr', text: (l.variant ? l.variant + ' · ' : '') + l.sku + ' · ×' + l.qty })),
      el('span', {}), el('span', { class: 'amt', text: money(l.total) }))),
    el('div', { class: 'totals' },
      el('div', {}, el('span', { text: 'Subtotal' }), el('span', { text: money(Number(c('subtotal'))) })),
      el('div', {}, el('span', { text: 'Shipping' }), el('span', { text: Number(c('shipping')) ? money(Number(c('shipping'))) : 'Free' })),
      el('div', { class: 'grand' }, el('span', { text: 'Total' }), el('span', { text: money(Number(c('amountTotal'))) }))),
    el('div', { style: 'display:flex;gap:.7rem;flex-wrap:wrap;margin-top:1.2rem' },
      status === 'pending' ? mark('paid', 'Mark as paid') : null,
      status === 'paid' ? mark('fulfilled', 'Mark as fulfilled') : null,
      status !== 'cancelled' && status !== 'fulfilled' ? mark('cancelled', 'Cancel order') : null),
    note);
}


// ---- admin: products --------------------------------------------------------
// Writes go to /data/products/<slug>.html. The admin trigger checks the Basic
// credential the browser already holds for this origin, so no password is stored here.
const slugify = (t) => t.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const pounds = (pence) => (Number(pence || 0) / 100).toFixed(2);

function productDoc(p) {
  const d = document.createElement('div');
  d.setAttribute('itemscope', ''); d.setAttribute('itemtype', 'https://shop.example/Product');
  d.id = 'product-' + p.slug;
  const meta = (k, v) => d.append(el('meta', { itemprop: k, content: String(v) }));
  meta('slug', p.slug); meta('sku', p.sku); meta('price', p.price);
  meta('priceDisplay', '£' + pounds(p.price)); meta('currency', 'GBP');
  meta('category', p.category); meta('emoji', p.emoji); meta('available', p.available);
  for (const v of p.variants) if (v) meta('variant', v);
  // Image order is document order; the first is the one listings use.
  for (const u of (p.images || [])) if (u) meta('image', u);
  d.append(el('h1', { itemprop: 'name', text: p.name }));
  d.append(el('p', { itemprop: 'description', text: p.description }));
  return '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>data: ' + p.slug
    + '</title></head>\n<body>\n  ' + d.outerHTML + '\n</body>\n</html>\n';
}


// ---- product images ---------------------------------------------------------
// Files are uploaded with a BINARY PUT — the body is the file itself and the
// Content-Type is the file's own type. No multipart anywhere.
const IMG_OK = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif'];
const extFor = (type, name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || (type.split('/')[1] || 'bin')).toLowerCase();

async function uploadImage(file, slug) {
  if (!IMG_OK.includes(file.type)) throw new Error(file.name + ' is not an image we accept');
  if (file.size > 4 * 1024 * 1024) throw new Error(file.name + ' is larger than 4MB');
  const stem = (slug || 'product') + '-' + Math.random().toString(36).slice(2, 9);
  const url = '/images/' + stem + '.' + extFor(file.type, file.name);
  const res = await fetch(url, {
    method: 'PUT', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': file.type }, body: file,   // the File IS the body
  });
  if (!res.ok) throw new Error('upload failed (' + res.status + ')');
  return url;
}

// A drop zone plus a reorderable strip of thumbnails. Returns .urls() in display order.
function imagePanel(initial, getSlug) {
  let urls = [...initial];
  const strip = el('div', { class: 'thumbs' });
  const note = el('p', { class: 'note' });
  const input = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const zone = el('div', { class: 'dropzone', tabindex: '0', role: 'button' },
    el('strong', { text: 'Drop images here' }),
    el('span', { text: ' or click to choose. Drag a thumbnail to reorder — the first one is used in listings.' }));

  let dragFrom = null;
  const paint = () => {
    strip.replaceChildren(...urls.map((u, idx) => {
      const t = el('figure', { class: 'thumb-item', draggable: 'true', title: 'Drag to reorder' },
        el('img', { src: u, alt: '' }),
        el('button', { type: 'button', class: 'thumb-x', 'aria-label': 'Remove image', text: '×' }));
      if (idx === 0) t.append(el('figcaption', { text: 'Main' }));
      t.querySelector('.thumb-x').addEventListener('click', (e) => {
        e.stopPropagation(); urls.splice(idx, 1); paint();
      });
      t.addEventListener('dragstart', (e) => { dragFrom = idx; e.dataTransfer.effectAllowed = 'move'; t.classList.add('dragging'); });
      t.addEventListener('dragend', () => { dragFrom = null; t.classList.remove('dragging'); });
      t.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; t.classList.add('over'); });
      t.addEventListener('dragleave', () => t.classList.remove('over'));
      t.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation(); t.classList.remove('over');
        if (dragFrom == null || dragFrom === idx) return;
        const [moved] = urls.splice(dragFrom, 1);
        urls.splice(idx, 0, moved);
        paint();
      });
      return t;
    }));
    if (!urls.length) strip.append(el('p', { class: 'note', text: 'No images yet — the emoji is used as a placeholder.' }));
  };
  const take = async (files) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    note.removeAttribute('data-tone');
    note.textContent = 'Uploading ' + list.length + ' image' + (list.length > 1 ? 's' : '') + '…';
    for (const f of list) {
      try { urls.push(await uploadImage(f, getSlug())); paint(); }
      catch (err) { note.setAttribute('data-tone', 'err'); note.textContent = err.message; return; }
    }
    note.setAttribute('data-tone', 'ok');
    note.textContent = 'Uploaded. Drag to reorder, then save the product.';
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { take(input.files); input.value = ''; });
  for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); take(e.dataTransfer.files); });
  paint();
  return { node: el('div', {}, el('label', { text: 'Images' }), zone, input, strip, note), urls: () => urls };
}

function productEditor(existing) {
  const isNew = !existing;
  const p = existing || { slug: '', name: '', sku: '', price: '', category: '', emoji: '📦',
                          available: 'yes', description: '', variants: 'One size' };
  const f = {};
  const field = (key, label, attrs = {}) => {
    f[key] = el(attrs.tag === 'textarea' ? 'textarea' : 'input', { ...attrs, tag: null, value: undefined });
    if (attrs.tag !== 'textarea') f[key].type = attrs.type || 'text';
    f[key].value = p[key] ?? '';
    return el('div', {}, el('label', { text: label }), f[key]);
  };
  const grid = el('div', { class: 'row2' },
    field('name', 'Name'), field('sku', 'SKU'),
    field('price', 'Price in pence', { type: 'number', min: '0' }), field('category', 'Category'),
    field('emoji', 'Emoji'), field('variants', 'Variants (comma separated)'));
  const slugF = field('slug', 'Slug (the web address)');
  if (!isNew) f.slug.readOnly = true;
  const desc = field('description', 'Description', { tag: 'textarea' });
  const avail = el('select', {}, el('option', { value: 'yes', text: 'On sale' }), el('option', { value: 'no', text: 'Hidden' }));
  avail.value = p.available || 'yes';
  const gallery = imagePanel((p.images || '').split(',').map((u) => u.trim()).filter(Boolean), () => (f.slug.value.trim() || slugify(f.name.value)));
  const note = el('p', { class: 'note' });
  const save = el('button', { class: 'btn', type: 'button', text: isNew ? 'Create product' : 'Save changes' });
  const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel' });
  if (isNew) f.name.addEventListener('input', () => { f.slug.value = slugify(f.name.value); });

  const panel = el('div', { class: 'panel', style: 'max-width:720px;margin:0 auto' },
    el('h2', { text: isNew ? 'New product' : 'Edit ' + p.name }),
    grid, slugF, desc,
    el('div', {}, el('label', { text: 'Availability' }), avail),
    gallery.node,
    note,
    el('div', { style: 'display:flex;gap:.7rem;margin-top:1rem' }, save, cancel));
  const scrim = el('div', { class: 'editor-scrim',
    style: 'position:fixed;inset:0;background:rgba(11,16,32,.45);display:grid;place-items:center;padding:4vh 4vw;overflow:auto;z-index:60' }, panel);
  const close = () => scrim.remove();
  cancel.addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  save.addEventListener('click', async () => {
    const slug = (f.slug.value.trim() || slugify(f.name.value));
    if (!f.name.value.trim() || !slug) { note.setAttribute('data-tone', 'err'); note.textContent = 'Name is required.'; return; }
    save.disabled = true; note.removeAttribute('data-tone'); note.textContent = 'Saving…';
    const body = productDoc({ slug, name: f.name.value.trim(), sku: f.sku.value.trim() || slug.toUpperCase(),
      price: Number(f.price.value) || 0, category: f.category.value.trim(), emoji: f.emoji.value.trim() || '📦',
      available: avail.value, description: f.description.value.trim(),
      variants: f.variants.value.split(',').map((v) => v.trim()), images: gallery.urls() });
    const res = await fetch('/data/products/' + encodeURIComponent(slug) + '.html', {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'text/html; charset=utf-8' }, body });
    if (res.ok) { location.reload(); return; }
    save.disabled = false; note.setAttribute('data-tone', 'err');
    note.textContent = res.status === 401
      ? 'The browser did not send your admin credential — reload the page and sign in again.'
      : 'Could not save (' + res.status + ').';
  });
  document.body.append(scrim);
  f.name.focus();
}

function adminProducts() {
  const root = document.querySelector('[data-admin-products]');
  if (!root) return;
  const rows = [...root.querySelectorAll('.admin-row')].map((li) => ({
    ...li.dataset, variants: (li.dataset.variants || '').split(',').map((v) => v.trim()).filter(Boolean).join(', ') }));
  root.querySelector('[data-new-product]').addEventListener('click', () => productEditor(null));
  const list = root.querySelector('.admin-list');
  if (!rows.length) { list.replaceWith(el('div', { class: 'empty' }, el('p', { text: 'No products yet.' }))); return; }
  list.replaceChildren(...rows.map((r) => {
    const edit = el('button', { type: 'button', text: 'Edit' });
    const del = el('button', { type: 'button', class: 'danger', text: 'Delete' });
    edit.addEventListener('click', () => productEditor({ ...r, variants: r.variants }));
    del.addEventListener('click', async () => {
      if (!confirm('Delete “' + r.name + '”? It disappears from the shop immediately.')) return;
      const res = await fetch('/data/products/' + encodeURIComponent(r.slug) + '.html',
        { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
      if (res.ok || res.status === 416) { location.reload(); return; }
      alert(res.status === 401 ? 'Your admin credential was not sent — reload and sign in again.' : 'Delete failed (' + res.status + ').');
    });
    return el('div', { class: 'line line-admin' },
      el('span', { class: 'em', text: r.emoji }),
      el('span', {}, el('span', { class: 'nm', text: r.name }),
        el('span', { class: 'vr', text: ' · ' + r.sku + ' · ' + (r.variants || 'one variant') })),
      el('span', { class: 'badge', text: r.available === 'yes' ? 'On sale' : 'Hidden' }),
      el('span', { class: 'amt', text: money(Number(r.price || 0)) }),
      el('span', { class: 'actions' }, edit, del));
  }));
}


// ---- wire up ----------------------------------------------------------------
if (typeof document !== 'undefined') {
  productPage();
  orderPage();
  adminOrders();
  adminOrder();
  adminProducts();
  basketPage();
  checkoutPage();
  // Every page shows a basket count; pages that do not render the basket still need it.
  if (!document.querySelector('[data-basket-view],[data-checkout-page]')) getBasket().then(paintCount).catch(() => {});
}
