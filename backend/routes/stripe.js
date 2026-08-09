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
const mailer = require('../lib/mailer');
const pricing = require('../lib/pricing');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const FRONTEND_BASE = 'https://www.bcsmemorybox.com';

// Pricing tiers live in the single source of truth (lib/pricing.js).
const PLANS = pricing.PLANS;

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
      'SELECT id, email, name, status, paid_at, access_token, plan FROM customers WHERE access_token = $1',
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

    // Resolve to a sellable plan: unknown/retired -> $299 Hardcover (never the old price).
    const planKey = pricing.sellablePlanKey(customer.plan);
    const planInfo = PLANS[planKey];

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      // Show the "Add promotion code" box so beta testers / gifts / launch
      // discounts can use a Stripe coupon (e.g. a 100%-off code = free) and go
      // through the SAME signup->checkout->record flow as a paying customer.
      // Only codes created in the Stripe dashboard work; a made-up code does nothing.
      allow_promotion_codes: true,
      customer_email: customer.email,
      client_reference_id: customer.access_token,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: planInfo.cents,
            product_data: {
              name: planInfo.name,
              description: planInfo.desc,
            },
          },
        },
      ],
      success_url: FRONTEND_BASE + '/yourstory.html?token=' + encodeURIComponent(customer.access_token) + '&checkout=success',
      cancel_url: FRONTEND_BASE + '/signup.html?checkout=cancelled',
      metadata: {
        customer_id: String(customer.id),
        access_token: customer.access_token,
        plan: planKey,
      },
    }, {
      // Audit H6: a stable idempotency key so a senior who opens checkout in two
      // tabs, or retries a slow first attempt, gets the SAME checkout session
      // back instead of a second, separately-chargeable one. Stripe caches the
      // response per key (~24h) and keyed on the customer + plan, so repeat calls
      // return one session that can only be paid once. (Webhook still has a
      // belt-and-suspenders alert if a second distinct charge somehow lands.)
      idempotencyKey: 'checkout_' + customer.access_token + '_' + planKey,
    });

    res.json({ ok: true, checkoutUrl: session.url });
  } catch (err) {
    console.error('[stripe/create-checkout-session] error:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ----------------------------------------------------------------------------
// Router 2: webhook receiver (RAW body — mounted before any json parser)
// ----------------------------------------------------------------------------
const webhookRouter = express.Router();

// Audit H3: a broken/rotated STRIPE_WEBHOOK_SECRET makes EVERY real payment
// event fail verification — the customer pays but is stuck at 'awaiting_payment'
// and (before this) Ken was never told. Alert Ken out-of-band when that happens.
// Throttled to at most once per 30 min so it can't spam, and always best-effort
// (a mail failure here must never affect the webhook response). We only alert
// when a Stripe-signature header is actually present, so random internet probes
// hitting the endpoint don't trigger false alarms.
let lastWebhookAlertAt = 0;
function alertKenWebhookFailure(reason) {
  const now = Date.now();
  if (now - lastWebhookAlertAt < 30 * 60 * 1000) return;
  lastWebhookAlertAt = now;
  mailer.sendEmail(mailer.ADMIN_EMAIL,
    '⚠️ Stripe webhook is failing — payments may not be recorded',
    '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
    '<h2 style="color:#c0392b;">Stripe payments may not be going through</h2>' +
    '<p>The Stripe payment webhook just failed:</p>' +
    '<p><strong>' + mailer.escapeHtml(reason) + '</strong></p>' +
    '<p>While this is happening, a customer can pay but be left stuck at &ldquo;awaiting payment&rdquo; with no way in. ' +
    'This almost always means the <code>STRIPE_WEBHOOK_SECRET</code> needs attention in Render — nothing you did caused it. ' +
    'Anyone who paid during the outage can be fixed from the dashboard once it&rsquo;s sorted.</p>' +
    '</div>').catch(function (e) { console.error('[stripe/webhook] could not alert Ken:', e.message); });
}

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
    if (req.headers['stripe-signature']) alertKenWebhookFailure('STRIPE_WEBHOOK_SECRET is not set on the server');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe/webhook] signature verification failed:', err.message);
    // A real Stripe call carries a stripe-signature header; if that fails to
    // verify, the secret is likely wrong/rotated and real payments are being
    // dropped — alert Ken. Unsigned probes are ignored (no false alarms).
    if (req.headers['stripe-signature']) alertKenWebhookFailure('signature verification failed (' + err.message + ')');
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
        'SELECT id, status, paid_at, email, name, access_token, stripe_payment_intent_id FROM customers WHERE access_token = $1',
        [accessToken]
      );
      if (!customer) {
        console.error('[stripe/webhook] no customer found for access_token', accessToken);
        // Return 200 so Stripe stops retrying; this is a config/data issue, not transient.
        return res.status(200).send('No matching customer');
      }

      if (customer.paid_at) {
        // Audit H6 (belt-and-suspenders): the idempotency key on checkout should
        // stop a second charge from ever being created. But if a genuinely
        // DIFFERENT payment somehow lands for an already-paid customer (a
        // distinct payment_intent, not just Stripe re-delivering the same
        // event), that's a real double-charge — alert Ken to refund it. A
        // matching/absent payment_intent is just a duplicate event: ignore it.
        if (paymentIntentId && customer.stripe_payment_intent_id
            && paymentIntentId !== customer.stripe_payment_intent_id) {
          console.error('[stripe/webhook] POSSIBLE DOUBLE CHARGE for customer ' + customer.id
            + ' (first PI ' + customer.stripe_payment_intent_id + ', second PI ' + paymentIntentId + ')');
          try {
            await mailer.sendEmail(mailer.ADMIN_EMAIL,
              '⚠️ Possible DOUBLE CHARGE — a customer may need a refund',
              '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
              '<h2 style="color:#c0392b;">A customer may have been charged twice</h2>' +
              '<p><strong>' + mailer.escapeHtml(customer.name || customer.email) + '</strong> (' + mailer.escapeHtml(customer.email) + ') ' +
              'was already paid, but a second, different payment just came through. This looks like an accidental double charge.</p>' +
              '<p style="font-size:14px;color:#5a534c;">First payment: ' + mailer.escapeHtml(customer.stripe_payment_intent_id) + '<br>' +
              'Second payment: ' + mailer.escapeHtml(paymentIntentId) + '</p>' +
              '<p>Please open Stripe and <strong>refund the second payment</strong> (' + mailer.escapeHtml(paymentIntentId) + '). ' +
              'Their book and account are unaffected — this is only about returning the extra charge.</p>' +
              '</div>');
            console.log('[stripe/webhook] alerted Ken about possible double charge for ' + customer.email);
          } catch (dupErr) {
            console.error('[stripe/webhook] could not alert Ken about double charge:', dupErr.message);
          }
        } else {
          console.log('[stripe/webhook] customer ' + customer.id + ' already paid; ignoring duplicate event');
        }
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

      // Send the welcome email with the link back to their story. Wrapped so a
      // mail failure can never fail the webhook (Stripe would otherwise retry).
      try {
        await mailer.sendStoryLink(customer.email, customer.name, customer.access_token, true);
        console.log('[stripe/webhook] welcome email sent to ' + customer.email);
      } catch (mailErr) {
        console.error('[stripe/webhook] welcome email failed (non-fatal):', mailErr.message);
        // A paid customer with no link is stranded and (before this) it was
        // silent. Tell Ken so he can resend it in one click. Best-effort; a
        // failure here must never fail the webhook (Stripe would keep retrying).
        try {
          await mailer.sendEmail(mailer.ADMIN_EMAIL,
            '⚠️ A paid customer did NOT get their welcome email — please resend',
            '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
            '<h2 style="color:#c0392b;">A paid customer needs their link resent</h2>' +
            '<p><strong>' + mailer.escapeHtml(customer.name || customer.email) + '</strong> (' + mailer.escapeHtml(customer.email) + ') ' +
            'just paid, but the welcome email carrying their story link failed to send:</p>' +
            '<p><strong>' + mailer.escapeHtml(mailErr.message) + '</strong></p>' +
            '<p>They have paid and cannot get in until they receive their link. Please open the dashboard, find them, ' +
            'and click <strong>&ldquo;Email link&rdquo;</strong> to resend it.</p>' +
            '<p><a href="' + FRONTEND_BASE + '/admin.html" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
            '</div>');
          console.log('[stripe/webhook] alerted Ken about failed welcome email for ' + customer.email);
        } catch (adminErr) {
          console.error('[stripe/webhook] could not alert Ken about failed welcome email:', adminErr.message);
        }
      }

      // Notify Ken that a new customer just paid. Non-fatal: a mail failure here
      // must never make the webhook error (Stripe would keep retrying).
      try {
        const planName = (PLANS[session.metadata && session.metadata.plan] || {}).name
          || 'Memory Box';
        const custName = customer.name || customer.email;
        const subject = '🎉 New customer just paid — ' + custName;
        const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">A new customer just paid 🎉</h2>' +
'<p>Good news, Ken — <strong>' + mailer.escapeHtml(custName) + '</strong> (' + mailer.escapeHtml(customer.email) + ') just paid for the <strong>' + mailer.escapeHtml(planName) + '</strong> and is ready to start recording their story.</p>' +
'<p>I’ve already sent them their welcome email with the link to begin. There’s nothing you need to do right now — I’ll let you know as soon as their draft is ready to review.</p>' +
'<p><a href="' + FRONTEND_BASE + '/admin.html" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'<p style="color:#8b5a2b;margin-top:24px;">— Bullet 🐶</p>' +
'</div>';
        await mailer.sendEmail(mailer.ADMIN_EMAIL, subject, html);
        console.log('[stripe/webhook] "new customer paid" notice sent to Ken');
      } catch (notifyErr) {
        console.error('[stripe/webhook] admin paid-notice failed (non-fatal):', notifyErr.message);
      }
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
