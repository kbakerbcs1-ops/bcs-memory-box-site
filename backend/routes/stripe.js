// ============================================================================
// Stripe integration — Checkout Session creation + webhook handler.
//
// Two endpoints:
//   POST /api/customer/create-checkout-session  → creates a hosted Checkout Session
//   POST /api/stripe/webhook                    → receives checkout.session.completed
//
// Both are exported as separate routers because the webhook needs the raw
// request body for signature verification, whereas the checkout-session
// creator wants normal JSON parsing.
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const db = require('../lib/db');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const FRONTEND_BASE = 'https://www.bcsmemorybox.com';
const YOUR_STORY_PRICE_CENTS = 12500; // $125.00

// ----------------------------------------------------------------------------
// Router 1: checkout session creator (JSON-parsed body)
// ----------------------------------------------------------------------------
const checkoutRouter = express.Router();
checkoutRouter.use(express.json());

// POST /api/customer/create-checkout-session
// Body: { token: "<access_token>" }
// Returns: { ok: true, checkoutUrl: "https://checkout.stripe.com/..." }
//
// Idempotent on the customer level: if they already paid, we send them to
// their portal. If their account doesn't exist, 404.
checkoutRouter.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured on this server (missing STRIPE_SECRET_KEY).' });
    }
    const token = (req.body && req.body.token) || req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, email, name, status, paid_at, access_token FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    // Already paid? Skip checkout, send them to their portal.
    if (customer.paid_at) {
      return res.json({
        ok: true,
        alreadyPaid: true,
        portalUrl: FRONTEND_BASE + '/yourstory.html?token=' + encodeURIComponent(customer.access_token),
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customer.email,
      client_reference_id: customer.access_token,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: YOUR_STORY_PRICE_CENTS,
            product_data: {
              name: 'Your Story — BCS Memory Box',
              description: 'A polished memoir document in your own voice. Two rounds of revisions included.',
            },
          },
        },
      ],
      success_url: FRONTEND_BASE + '/yourstory.html?token=' + encodeURIComponent(customer.access_token) + '&checkout=success',
      cancel_url: FRONTEND_BASE + '/signup.html?checkout=cancelled',
      metadata: {
        customer_id: String(customer.id),
        access_token: customer.access_token,
      },
    });

    res.json({ ok: true, checkoutUrl: session.url });
  } catch (err) {
    console.error('[stripe/create-checkout-session] error:', err);
    res.status(500).json({ error: err.message || 'Could not create checkout session.' });
  }
});

// ----------------------------------------------------------------------------
// Router 2: webhook receiver (RAW body — mounted before any json parser)
// ----------------------------------------------------------------------------
const webhookRouter = express.Router();

// POST /api/stripe/webhook
// Receives Stripe events. We care about 'checkout.session.completed':
//   - Look up the customer by client_reference_id (= access_token)
//   - Flip status from 'awaiting_payment' to 'recording'
//   - Save paid_at = NOW, stripe_customer_id, stripe_payment_intent_id
// Idempotent: if the customer is already paid, this is a no-op.
webhookRouter.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    console.error('[stripe/webhook] STRIPE_SECRET_KEY not configured');
    return res.status(500).send('Stripe not configured');
  }
  if (!webhookSecret) {
    console.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe/webhook] signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed: ' + err.message);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const accessToken = session.client_reference_id;
      const stripeCustomerId = session.customer || null;
      const paymentIntentId = session.payment_intent || null;

      if (!accessToken) {
        console.error('[stripe/webhook] checkout.session.completed without client_reference_id', session.id);
        return res.status(200).send('No client_reference_id, ignoring');
      }

      const customer = await db.queryOne(
        'SELECT id, status, paid_at FROM customers WHERE access_token = $1',
        [accessToken]
      );
      if (!customer) {
        console.error('[stripe/webhook] no customer found for access_token', accessToken);
        // Return 200 so Stripe stops retrying; this is a config/data issue, not transient.
        return res.status(200).send('No matching customer');
      }

      if (customer.paid_at) {
        console.log('[stripe/webhook] customer ' + customer.id + ' already paid; ignoring duplicate event');
        return res.status(200).send('Already paid (idempotent)');
      }

      await db.query(
        `UPDATE customers
         SET status = 'recording',
             paid_at = NOW(),
             stripe_customer_id = COALESCE(stripe_customer_id, $2),
             stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $3)
         WHERE id = $1`,
        [customer.id, stripeCustomerId, paymentIntentId]
      );

      console.log('[stripe/webhook] customer ' + customer.id + ' marked paid');
    } else {
      console.log('[stripe/webhook] received event ' + event.type + ' — not handled, ignoring');
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe/webhook] handler error:', err);
    // 500 so Stripe retries
    res.status(500).send('Handler error: ' + err.message);
  }
});

module.exports = { checkoutRouter, webhookRouter };
