const ORDER_TYPE = 'https://shop.example/Order';
const ORDER_LINE_TYPE = 'https://shop.example/OrderLine';
const SHIPPING_PENCE = 495;
const FREE_SHIPPING_PENCE = 5000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_DISTINCT_LINES = 20;
const MAX_ITEM_QUANTITY = 20;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const ORDER_ID_RE = /^[a-f0-9]{24}$/;

class HttpError extends Error {
  constructor(status, message, publicMessage = message) {
    super(message);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders, ...headers },
  });
}

function normalizedOrigin(value, name) {
  if (!value) throw new HttpError(500, `${name} is not configured`, 'Checkout is not configured.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(500, `${name} is invalid`, 'Checkout is not configured.');
  }
  if (url.protocol !== 'https:') throw new HttpError(500, `${name} must use HTTPS`, 'Checkout is not configured.');
  return url.origin;
}

function checkoutCors(request, env) {
  const requestOrigin = request.headers.get('Origin');
  const shopOrigin = normalizedOrigin(env.SHOP_ORIGIN, 'SHOP_ORIGIN');
  if (requestOrigin !== shopOrigin) {
    throw new HttpError(403, `Origin ${requestOrigin || '(missing)'} is not allowed`, 'Checkout request refused.');
  }
  return {
    'Access-Control-Allow-Origin': shopOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function backendUrl(value, name) {
  if (!value) throw new HttpError(500, `${name} is not configured`, 'Checkout is not configured.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(500, `${name} is invalid`, 'Checkout is not configured.');
  }
  const exeInternal = url.protocol === 'http:' && url.hostname.endsWith('.int.exe.xyz');
  if (url.protocol !== 'https:' && !exeInternal) {
    throw new HttpError(500, `${name} must use HTTPS or an exe.dev internal proxy`, 'Checkout is not configured.');
  }
  return url;
}

function cleanText(value, name, maxLength) {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`, 'Please check your delivery details.');
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new HttpError(400, `${name} is invalid`, 'Please check your delivery details.');
  }
  return cleaned;
}

export function normalizeCheckoutInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Checkout body must be an object', 'The checkout request is invalid.');
  }
  const requestId = String(input.requestId || '').toLowerCase();
  if (!ORDER_ID_RE.test(requestId)) {
    throw new HttpError(400, 'requestId must be 24 hexadecimal characters', 'Please reload checkout and try again.');
  }
  const email = cleanText(input.email, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'email is invalid', 'Please enter a valid email address.');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_DISTINCT_LINES) {
    throw new HttpError(400, 'lines must contain 1 to 20 items', 'Your basket is empty or too large.');
  }

  const combined = new Map();
  for (const raw of input.lines) {
    const slug = String(raw?.slug || '').toLowerCase();
    const variant = typeof raw?.variant === 'string' ? raw.variant.trim() : '';
    const quantity = Number(raw?.quantity);
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug) || variant.length > 100 || !Number.isInteger(quantity)) {
      throw new HttpError(400, 'A basket line is malformed', 'One of the basket items is invalid.');
    }
    const key = `${slug}\u0000${variant}`;
    const totalQuantity = (combined.get(key)?.quantity || 0) + quantity;
    if (quantity < 1 || totalQuantity > MAX_ITEM_QUANTITY) {
      throw new HttpError(400, 'A basket quantity is outside the allowed range', 'Choose between 1 and 20 of each item.');
    }
    combined.set(key, { slug, variant, quantity: totalQuantity });
  }

  return {
    requestId,
    email,
    customerName: cleanText(input.customerName, 'customerName', 120),
    line1: cleanText(input.line1, 'line1', 160),
    city: cleanText(input.city, 'city', 100),
    postcode: cleanText(input.postcode, 'postcode', 24),
    country: cleanText(input.country, 'country', 80),
    lines: [...combined.values()],
  };
}

function decodeHtml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code) => {
    const lower = code.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    const number = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

function attributes(tag) {
  const result = {};
  const pattern = /([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(pattern)) result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? '');
  return result;
}

function metaValues(html, property) {
  const values = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.itemprop === property && Object.hasOwn(attrs, 'content')) values.push(attrs.content);
  }
  return values;
}

export function parseProductHtml(html) {
  const first = (name) => metaValues(html, name)[0] || '';
  const nameMatch = html.match(/<h1\b[^>]*\bitemprop=(?:"name"|'name')[^>]*>([\s\S]*?)<\/h1>/i);
  const name = nameMatch ? decodeHtml(nameMatch[1].replace(/<[^>]*>/g, '').trim()) : '';
  const price = Number(first('price'));
  if (!first('slug') || !first('sku') || !name || !Number.isInteger(price)) {
    throw new HttpError(502, 'Product document is incomplete', 'A product could not be priced.');
  }
  return {
    slug: first('slug'),
    sku: first('sku'),
    name,
    price,
    currency: first('currency').toLowerCase(),
    available: first('available'),
    variants: metaValues(html, 'variant'),
  };
}

async function fetchProduct(env, slug) {
  const shopOrigin = normalizedOrigin(env.SHOP_ORIGIN, 'SHOP_ORIGIN');
  const url = new URL(`/data/products/${slug}.html`, shopOrigin);
  const response = await fetch(url, {
    headers: { Accept: 'text/html' },
    // A redirect remains a non-2xx response below and is never followed.
    redirect: 'manual',
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) throw new HttpError(400, `Unknown product: ${slug}`, 'A product in your basket is no longer available.');
  const product = parseProductHtml(await response.text());
  if (product.slug !== slug || product.available !== 'yes' || product.currency !== 'gbp'
      || product.price < 1 || product.price > 1_000_000) {
    throw new HttpError(400, `Product ${slug} is not purchasable`, 'A product in your basket is no longer available.');
  }
  return product;
}

export function priceCart(lines, products) {
  const pricedLines = lines.map((line) => {
    const product = products.get(line.slug);
    if (!product) throw new HttpError(400, `Unknown product: ${line.slug}`, 'A product in your basket is no longer available.');
    if (product.variants.length && !product.variants.includes(line.variant)) {
      throw new HttpError(400, `Unknown variant for ${line.slug}`, 'A product option in your basket is no longer available.');
    }
    return {
      ...line,
      sku: product.sku,
      name: product.name,
      unitPrice: product.price,
      lineTotal: product.price * line.quantity,
    };
  });
  const subtotal = pricedLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const shipping = subtotal >= FREE_SHIPPING_PENCE ? 0 : SHIPPING_PENCE;
  return { lines: pricedLines, subtotal, shipping, amountTotal: subtotal + shipping, currency: 'GBP' };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function orderDocument(input, cart, sessionId, placedAt = new Date().toISOString()) {
  const metas = [
    ['orderId', input.requestId], ['placedAt', placedAt], ['currency', cart.currency],
    ['subtotal', cart.subtotal], ['shipping', cart.shipping], ['amountTotal', cart.amountTotal],
    ['paymentStatus', 'pending'], ['paymentProvider', 'stripe'], ['paymentReference', sessionId],
    ['email', input.email], ['customerName', input.customerName], ['line1', input.line1],
    ['city', input.city], ['postcode', input.postcode], ['country', input.country],
  ].map(([name, value]) => `<meta itemprop="${name}" content="${escapeHtml(value)}">`).join('');
  const lines = cart.lines.map((line) => {
    const lineMetas = [
      ['sku', line.sku], ['slug', line.slug], ['name', line.name], ['variant', line.variant],
      ['unitPrice', line.unitPrice], ['quantity', line.quantity], ['lineTotal', line.lineTotal],
    ].map(([name, value]) => `<meta itemprop="${name}" content="${escapeHtml(value)}">`).join('');
    return `<li itemscope itemtype="${ORDER_LINE_TYPE}">${lineMetas}</li>`;
  }).join('');
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><title>order ${input.requestId}</title></head>\n<body>\n  <div itemscope itemtype="${ORDER_TYPE}" id="order-${input.requestId}">${metas}<ul itemprop="lines">${lines}</ul></div>\n</body>\n</html>\n`;
}

function webdavUrl(env, orderId) {
  return new URL(`data/orders/${orderId}.html`, backendUrl(env.SHOP_WEBDAV_URL, 'SHOP_WEBDAV_URL'));
}

async function orderRequest(env, orderId, init = {}) {
  const headers = new Headers(init.headers);
  // Direct credentials are supported only for local development. In production,
  // exe.dev's HTTP integration injects this header without exposing the key to celld.
  if (env.PAGELOVE_API_KEY) headers.set('Authorization', `Bearer ${env.PAGELOVE_API_KEY}`);
  return fetch(webdavUrl(env, orderId), { ...init, headers, redirect: 'manual' });
}

async function createOrder(env, input, html, sessionId) {
  const response = await orderRequest(env, input.requestId, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'If-None-Match': '*' },
    body: html,
  });
  if (response.ok) return;
  if (response.status === 409 || response.status === 412) {
    const existing = await orderRequest(env, input.requestId);
    if (existing.ok) {
      const existingHtml = await existing.text();
      if (metaValues(existingHtml, 'paymentReference')[0] === sessionId
          && metaValues(existingHtml, 'email')[0] === input.email) return;
    }
    throw new HttpError(409, `Order id ${input.requestId} already exists`, 'This checkout has already been used. Please reload and try again.');
  }
  throw new HttpError(502, `Pagelove order write failed (${response.status})`, 'The order could not be saved. Nothing has been charged.');
}

function stripeLineItems(cart) {
  const lineItems = cart.lines.map((line) => ({
    quantity: line.quantity,
    price_data: {
      currency: 'gbp',
      unit_amount: line.unitPrice,
      product_data: {
        name: line.variant ? `${line.name} — ${line.variant}` : line.name,
        metadata: { pagelove_slug: line.slug, pagelove_sku: line.sku },
      },
    },
  }));
  if (cart.shipping) {
    lineItems.push({
      quantity: 1,
      price_data: { currency: 'gbp', unit_amount: cart.shipping, product_data: { name: 'Delivery' } },
    });
  }
  return lineItems;
}

function appendStripeForm(form, value, prefix) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendStripeForm(form, item, `${prefix}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => appendStripeForm(form, item, `${prefix}[${key}]`));
    return;
  }
  if (value !== undefined && value !== null) form.append(prefix, String(value));
}

export function stripeFormBody(values) {
  const form = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => appendStripeForm(form, value, key));
  return form;
}

function stripeApiHeaders(env, values = {}) {
  const headers = new Headers({ Accept: 'application/json', ...values });
  if (env.STRIPE_SECRET_KEY) headers.set('Authorization', `Bearer ${env.STRIPE_SECRET_KEY}`);
  return headers;
}

export function stripeModeMatches(configuredMode, livemode) {
  const mode = configuredMode || 'test';
  if (!['test', 'live'].includes(mode) || typeof livemode !== 'boolean') return false;
  return livemode === (mode === 'live');
}

async function assertStripeMode(env) {
  const base = backendUrl(env.STRIPE_API_BASE, 'STRIPE_API_BASE');
  const response = await fetch(new URL('v1/balance', base), {
    headers: stripeApiHeaders(env),
    redirect: 'manual',
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, `Stripe mode check returned non-JSON (${response.status})`, 'Secure payment could not be opened.');
  }
  if (!response.ok) {
    throw new HttpError(502, `Stripe mode check failed (${response.status})`, 'Secure payment could not be opened.');
  }
  if (!stripeModeMatches(env.STRIPE_MODE, payload.livemode)) {
    throw new HttpError(503, `Stripe credential mode does not match STRIPE_MODE=${env.STRIPE_MODE || 'test'}`, 'Checkout is temporarily unavailable.');
  }
}

async function createStripeSession(env, values, idempotencyKey) {
  const base = backendUrl(env.STRIPE_API_BASE, 'STRIPE_API_BASE');
  const headers = stripeApiHeaders(env, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': idempotencyKey,
  });
  // For local development only. The production exe.dev proxy injects this header.
  const response = await fetch(new URL('v1/checkout/sessions', base), {
    method: 'POST',
    headers,
    body: stripeFormBody(values),
    redirect: 'manual',
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, `Stripe returned non-JSON (${response.status})`, 'Secure payment could not be opened.');
  }
  if (!response.ok) {
    throw new HttpError(502, `Stripe session creation failed (${response.status}): ${payload?.error?.message || 'unknown error'}`, 'Secure payment could not be opened.');
  }
  if (!payload?.id || !payload?.url) {
    throw new HttpError(502, 'Stripe did not return a Checkout Session id and URL', 'Secure payment could not be opened.');
  }
  return payload;
}

async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (!contentType.toLowerCase().startsWith('application/json') || contentLength > MAX_BODY_BYTES) {
    throw new HttpError(415, 'Checkout requires a small JSON body', 'The checkout request is invalid.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Checkout body is too large', 'The checkout request is too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Checkout JSON is invalid', 'The checkout request is invalid.');
  }
}

async function checkout(request, env) {
  const cors = checkoutCors(request, env);
  const input = normalizeCheckoutInput(await readJsonBody(request));
  await assertStripeMode(env);
  const productMap = new Map();
  await Promise.all([...new Set(input.lines.map((line) => line.slug))].map(async (slug) => {
    productMap.set(slug, await fetchProduct(env, slug));
  }));
  const cart = priceCart(input.lines, productMap);
  const shopOrigin = normalizedOrigin(env.SHOP_ORIGIN, 'SHOP_ORIGIN');
  const session = await createStripeSession(env, {
    mode: 'payment',
    client_reference_id: input.requestId,
    customer_email: input.email,
    line_items: stripeLineItems(cart),
    success_url: `${shopOrigin}/orders/${input.requestId}.html?checkout=success`,
    cancel_url: `${shopOrigin}/checkout.html?checkout=cancelled`,
    locale: 'en-GB',
    submit_type: 'pay',
    metadata: { pagelove_order_id: input.requestId },
    payment_intent_data: { metadata: { pagelove_order_id: input.requestId } },
  }, `pagelove-shop-${input.requestId}`);
  await createOrder(env, input, orderDocument(input, cart, session.id), session.id);
  return json({ url: session.url, orderId: input.requestId, amountTotal: cart.amountTotal, currency: cart.currency }, 201, cors);
}

function replaceMeta(html, property, value) {
  let replaced = false;
  const result = html.replace(/<meta\b[^>]*>/gi, (tag) => {
    const attrs = attributes(tag);
    if (replaced || attrs.itemprop !== property) return tag;
    replaced = true;
    if (/\bcontent\s*=\s*"[^"]*"/i.test(tag)) return tag.replace(/\bcontent\s*=\s*"[^"]*"/i, `content="${escapeHtml(value)}"`);
    if (/\bcontent\s*=\s*'[^']*'/i.test(tag)) return tag.replace(/\bcontent\s*=\s*'[^']*'/i, `content="${escapeHtml(value)}"`);
    return tag.replace(/>$/, ` content="${escapeHtml(value)}">`);
  });
  if (!replaced) throw new HttpError(500, `Order is missing ${property}`, 'The payment update could not be recorded.');
  return result;
}

async function updateOrderFromSession(env, session, nextStatus, attempt = 0) {
  const orderId = session.metadata?.pagelove_order_id;
  if (!ORDER_ID_RE.test(orderId || '') || session.client_reference_id !== orderId) {
    throw new HttpError(400, 'Stripe session has invalid Pagelove order metadata', 'Invalid Stripe event.');
  }
  const current = await orderRequest(env, orderId);
  if (!current.ok) throw new HttpError(502, `Pagelove order read failed (${current.status})`, 'The payment update could not be recorded.');
  const etag = current.headers.get('ETag');
  let html = await current.text();
  const storedSession = metaValues(html, 'paymentReference')[0];
  const storedTotal = Number(metaValues(html, 'amountTotal')[0]);
  const storedCurrency = (metaValues(html, 'currency')[0] || '').toLowerCase();
  if (storedSession !== session.id || storedTotal !== session.amount_total || storedCurrency !== session.currency) {
    throw new HttpError(409, 'Stripe session does not match the stored order', 'Stripe event did not match the order.');
  }

  const currentStatus = metaValues(html, 'paymentStatus')[0];
  if ((nextStatus === 'paid' && currentStatus === 'fulfilled')
      || (nextStatus === 'cancelled' && ['paid', 'fulfilled'].includes(currentStatus))) return;
  html = replaceMeta(html, 'paymentStatus', nextStatus);
  html = replaceMeta(html, 'paymentReference', session.id);
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (etag) headers['If-Match'] = etag;
  const updated = await orderRequest(env, orderId, { method: 'PUT', headers, body: html });
  if ((updated.status === 409 || updated.status === 412) && attempt === 0) {
    return updateOrderFromSession(env, session, nextStatus, 1);
  }
  if (!updated.ok) throw new HttpError(502, `Pagelove order update failed (${updated.status})`, 'The payment update could not be recorded.');
}

async function webhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(500, 'STRIPE_WEBHOOK_SECRET is not configured', 'Webhook is not configured.');
  const signature = request.headers.get('Stripe-Signature');
  if (!signature) throw new HttpError(400, 'Stripe-Signature is missing', 'Missing Stripe signature.');
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'Stripe webhook is too large', 'Webhook is too large.');
  const rawBody = await request.text();
  if (rawBody.length > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'Stripe webhook is too large', 'Webhook is too large.');
  let event;
  try {
    const verified = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    if (!verified) throw new Error('signature or timestamp did not match');
    event = JSON.parse(rawBody);
  } catch (error) {
    throw new HttpError(400, `Stripe signature verification failed: ${error.message}`, 'Invalid Stripe signature.');
  }

  const session = event.data?.object;
  if (event.type === 'checkout.session.completed' && session?.payment_status === 'paid') {
    await updateOrderFromSession(env, session, 'paid');
  } else if (event.type === 'checkout.session.async_payment_succeeded') {
    await updateOrderFromSession(env, session, 'paid');
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    await updateOrderFromSession(env, session, 'cancelled');
  }
  return json({ received: true });
}

function hexBytes(value) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

export async function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000), tolerance = 300) {
  if (!secret || typeof header !== 'string') return false;
  const fields = header.split(',').map((part) => part.trim().split('='));
  const timestamp = Number(fields.find(([key]) => key === 't')?.[1]);
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => hexBytes(value)).filter(Boolean);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > tolerance || signatures.length === 0) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const signedPayload = encoder.encode(`${timestamp}.${rawBody}`);
  for (const candidate of signatures) {
    if (await crypto.subtle.verify('HMAC', key, candidate, signedPayload)) return true;
  }
  return false;
}

function errorResponse(error, cors = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.publicMessage : 'Checkout failed unexpectedly.';
  console.error(error);
  return json({ error: message }, status, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, stripeMode: env.STRIPE_MODE || 'test' });
    }
    if (url.pathname === '/checkout' && request.method === 'OPTIONS') {
      try {
        return new Response(null, { status: 204, headers: checkoutCors(request, env) });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (url.pathname === '/checkout' && request.method === 'POST') {
      let cors = {};
      try {
        cors = checkoutCors(request, env);
        return await checkout(request, env);
      } catch (error) {
        return errorResponse(error, cors);
      }
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        return await webhook(request, env);
      } catch (error) {
        return errorResponse(error);
      }
    }
    return json({ error: 'Not found.' }, 404);
  },
};
