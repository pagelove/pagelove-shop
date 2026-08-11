import assert from 'node:assert/strict';
import test from 'node:test';
import { stripeCheckoutDashboardUrl } from '../../js/shop.mjs';
import { normalizeCheckoutInput, orderDocument, parseProductHtml, priceCart, stripeFormBody, stripeModeMatches, verifyStripeSignature } from '../src/index.js';

const rawInput = {
  requestId: '0123456789abcdef01234567',
  email: 'SHOPPER@example.com',
  customerName: 'Ada Lovelace',
  line1: '12 Analytical Way',
  city: 'London',
  postcode: 'N1 9GU',
  country: 'United Kingdom',
  lines: [{ slug: 'tee', variant: 'L', quantity: 2 }],
};

test('normalizes checkout input and combines duplicate lines', () => {
  const input = normalizeCheckoutInput({
    ...rawInput,
    lines: [
      { slug: 'tee', variant: 'L', quantity: 1 },
      { slug: 'tee', variant: 'L', quantity: 2 },
    ],
  });
  assert.equal(input.email, 'shopper@example.com');
  assert.deepEqual(input.lines, [{ slug: 'tee', variant: 'L', quantity: 3 }]);
});

test('parses authoritative product microdata', () => {
  const product = parseProductHtml(`
    <meta content="tee" itemprop="slug">
    <meta itemprop="sku" content="PL-TEE">
    <meta itemprop="price" content="2800">
    <meta itemprop="currency" content="GBP">
    <meta itemprop="available" content="yes">
    <meta itemprop="variant" content="M"><meta itemprop="variant" content="L">
    <h1 class="product" itemprop="name">Pagelove &amp; Co T-shirt</h1>
  `);
  assert.equal(product.name, 'Pagelove & Co T-shirt');
  assert.equal(product.price, 2800);
  assert.deepEqual(product.variants, ['M', 'L']);
});

test('reprices the cart and applies free shipping from the server catalogue', () => {
  const input = normalizeCheckoutInput(rawInput);
  const products = new Map([['tee', {
    slug: 'tee', sku: 'PL-TEE', name: 'Pagelove T-shirt', price: 2800,
    currency: 'gbp', available: 'yes', variants: ['S', 'M', 'L'],
  }]]);
  const cart = priceCart(input.lines, products);
  assert.equal(cart.subtotal, 5600);
  assert.equal(cart.shipping, 0);
  assert.equal(cart.amountTotal, 5600);
});

test('rejects a variant that is not in the server catalogue', () => {
  const input = normalizeCheckoutInput(rawInput);
  const products = new Map([['tee', {
    slug: 'tee', sku: 'PL-TEE', name: 'Pagelove T-shirt', price: 2800,
    currency: 'gbp', available: 'yes', variants: ['S', 'M'],
  }]]);
  assert.throws(() => priceCart(input.lines, products), /Unknown variant/);
});

test('generates escaped, server-priced order HTML', () => {
  const input = normalizeCheckoutInput({ ...rawInput, customerName: 'Ada & Charles' });
  const cart = priceCart(input.lines, new Map([['tee', {
    slug: 'tee', sku: 'PL-TEE', name: 'Pagelove T-shirt', price: 2800,
    currency: 'gbp', available: 'yes', variants: ['L'],
  }]]));
  const html = orderDocument(input, cart, 'cs_test_123', '2026-08-11T08:00:00.000Z');
  assert.match(html, /itemprop="paymentStatus" content="pending"/);
  assert.match(html, /itemprop="paymentReference" content="cs_test_123"/);
  assert.match(html, /itemprop="amountTotal" content="0?5600"/);
  assert.match(html, /Ada &amp; Charles/);
  assert.doesNotMatch(html, /content="Ada & Charles"/);
});

test('links stored Checkout Session ids to the matching Stripe Dashboard mode', () => {
  assert.equal(
    stripeCheckoutDashboardUrl('cs_test_123'),
    'https://dashboard.stripe.com/test/checkout/sessions/cs_test_123',
  );
  assert.equal(
    stripeCheckoutDashboardUrl('cs_live_456'),
    'https://dashboard.stripe.com/checkout/sessions/cs_live_456',
  );
  assert.equal(stripeCheckoutDashboardUrl('pi_123'), '');
  assert.equal(stripeCheckoutDashboardUrl('https://example.com'), '');
});

test('encodes nested Stripe Checkout parameters', () => {
  const form = stripeFormBody({
    mode: 'payment',
    line_items: [{ quantity: 2, price_data: { currency: 'gbp', unit_amount: 2800 } }],
    metadata: { pagelove_order_id: '0123456789abcdef01234567' },
  });
  assert.equal(form.get('line_items[0][quantity]'), '2');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '2800');
  assert.equal(form.get('metadata[pagelove_order_id]'), '0123456789abcdef01234567');
});

test('verifies Stripe HMAC signatures and rejects stale timestamps', async () => {
  const body = '{"id":"evt_test","type":"checkout.session.completed"}';
  const secret = 'whsec_test_value';
  const timestamp = 1_786_435_200;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = Buffer.from(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`),
  )).toString('hex');
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret, timestamp), true);
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret, timestamp + 301), false);
  assert.equal(await verifyStripeSignature(`${body} `, `t=${timestamp},v1=${signature}`, secret, timestamp), false);
});

test('refuses Stripe credentials from the wrong payment mode', () => {
  assert.equal(stripeModeMatches('test', false), true);
  assert.equal(stripeModeMatches('test', true), false);
  assert.equal(stripeModeMatches('live', true), true);
  assert.equal(stripeModeMatches('live', false), false);
  assert.equal(stripeModeMatches('unexpected', false), false);
});
