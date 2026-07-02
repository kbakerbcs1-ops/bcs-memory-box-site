// Customer-facing endpoints: signup, lookup own data via access_token.
// No password — the access_token in the URL IS the credential.

const express = require('express');
const db = require('../lib/db');
const mailer = require('../lib/mailer');

const router = express.Router();
router.use(express.json());

// ----------------------------------------------------------------------------
// POST /api/customer/signup
// Creates a new customer in 'awaiting_payment' status. Returns an access_token.
// The frontend then redirects the customer to Stripe checkout with this token
// as the client_reference_id, and after payment lands them at /yourstory/<token>.
// ----------------------------------------------------------------------------
router.post('/signup', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();

    if (!name || name.length < 1) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // If a customer already exists for this email and hasn't paid yet, reuse the
    // existing access_token (so they can retry checkout instead of getting blocked).
    // If they've already paid, send them back to their existing portal URL.
    const existing = await db.queryOne(
      'SELECT id, access_token, status, paid_at FROM customers WHERE email = $1',
      [email]
    );

    if (existing) {
      if (existing.paid_at) {
        // Already a paying customer — just send them their portal URL again.
        return res.json({
          ok: true,
          alreadyExists: true,
          alreadyPaid: true,
          accessToken: existing.access_token,
          portalUrl: '/yourstory.html?token=' + encodeURIComponent(existing.access_token),
          message: 'Welcome back. You already have an account — heading you to your story.',
        });
      }
      // Has account but hasn't paid yet — resume checkout with the same token.
      return res.json({
        ok: true,
        alreadyExists: true,
        alreadyPaid: false,
        accessToken: existing.access_token,
        message: 'Welcome back — taking you to checkout.',
      });
    }

    const accessToken = db.randomToken(24);
    const result = await db.queryOne(
      `INSERT INTO customers (email, name, access_token, status)
       VALUES ($1, $2, $3, 'awaiting_payment')
       RETURNING id, access_token`,
      [email, name, accessToken]
    );

    res.json({
      ok: true,
      alreadyExists: false,
      accessToken: result.access_token,
      message: 'Account created. Heading to checkout.',
    });
  } catch (err) {
    console.error('[customer/signup] error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/customer/me?token=<access_token>
// Returns the customer's own data (status, recordings, photos, drafts).
// Used by the customer's personal portal page.
// ----------------------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      `SELECT id, email, name, status, paid_at, created_at
       FROM customers
       WHERE access_token = $1`,
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const { rows: recordings } = await db.query(
      `SELECT id, original_filename, size_bytes, duration_seconds,
              transcript_status, created_at, title
       FROM recordings
       WHERE customer_id = $1
       ORDER BY created_at ASC`,
      [customer.id]
    );

    const { rows: photos } = await db.query(
      `SELECT id, original_filename, size_bytes, content_type, caption, created_at
       FROM photos
       WHERE customer_id = $1
       ORDER BY created_at ASC`,
      [customer.id]
    );

    const { rows: drafts } = await db.query(
      `SELECT id, version, status, approved_at, delivered_at, created_at
       FROM drafts
       WHERE customer_id = $1
       ORDER BY version DESC`,
      [customer.id]
    );

    res.json({
      ok: true,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        status: customer.status,
        paidAt: customer.paid_at,
        createdAt: customer.created_at,
      },
      recordings,
      photos,
      drafts,
    });
  } catch (err) {
    console.error('[customer/me] error:', err);
    res.status(500).json({ error: 'Could not load your account data.' });
  }
});



// ---------------------------------------------------------------------------
// GET /api/customer/download?token=<access_token>
// Streams the latest approved (or ready_for_review) .docx for this customer.
// ---------------------------------------------------------------------------
const storage = require('../lib/storage');

router.get('/download', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, name FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await db.queryOne(
      `SELECT id, version, docx_storage_key, status
       FROM drafts
       WHERE customer_id = $1 AND docx_storage_key IS NOT NULL
         AND status IN ('delivered', 'approved', 'ready_for_review')
       ORDER BY version DESC, created_at DESC
       LIMIT 1`,
      [customer.id]
    );
    if (!draft) return res.status(404).json({ error: 'No memoir document available yet.' });

    const { stream, contentType, contentLength } =
      await storage.getObjectStream(draft.docx_storage_key);
    const safeName = (customer.name || 'memoir').replace(/[^A-Za-z0-9 _-]/g, '_');
    res.setHeader('Content-Type',
      contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition',
      'attachment; filename="' + safeName + ' - Memory Box.docx"');
    stream.pipe(res);
  } catch (err) {
    console.error('[customer/download] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/customer/photo/:id?token=<access_token>
// Streams a single photo inline so it can be shown in an <img> tag on the
// customer's own story page. Scoped to the photo's owner via the access token.
// ---------------------------------------------------------------------------
router.get('/photo/:id', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const photo = await db.queryOne(
      `SELECT p.storage_key, p.content_type
       FROM photos p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const { stream, contentType, contentLength } = await storage.getObjectStream(photo.storage_key);
    res.setHeader('Content-Type', photo.content_type || contentType || 'image/jpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    console.error('[customer/photo] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/customer/photo/:id?token=<access_token>
// Lets the customer remove a photo they added by mistake.
// ---------------------------------------------------------------------------
router.delete('/photo/:id', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const photo = await db.queryOne(
      `SELECT p.id, p.storage_key
       FROM photos p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    await db.query('DELETE FROM photos WHERE id = $1', [photo.id]);
    storage.deleteObject(photo.storage_key)
      .catch(e => console.warn('[customer/photo delete] storage cleanup failed:', e.message));

    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[customer/photo delete] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/customer/recording/:id/title?token=<access_token>
// Body: { title } — lets the customer label/rename one of their recordings.
// ---------------------------------------------------------------------------
router.put('/recording/:id/title', async (req, res) => {
  try {
    const token = req.query.token || (req.body && req.body.token);
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    let title = (req.body && typeof req.body.title === 'string') ? req.body.title.trim() : '';
    if (title.length > 80) title = title.slice(0, 80);
    const rec = await db.queryOne(
      `SELECT r.id FROM recordings r
       JOIN customers c ON c.id = r.customer_id
       WHERE r.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!rec) return res.status(404).json({ error: 'Recording not found' });
    await db.query('UPDATE recordings SET title = $1 WHERE id = $2', [title || null, rec.id]);
    res.json({ ok: true, title: title || null });
  } catch (err) {
    console.error('[customer/recording title] error:', err);
    res.status(500).json({ error: 'Could not update the title. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/customer/photo/:id/caption?token=<access_token>
// Body: { caption } — lets the customer name/caption a photo after uploading
// (name + date, e.g. "Mom & Dad, Christmas 1975").
// ---------------------------------------------------------------------------
router.put('/photo/:id/caption', async (req, res) => {
  try {
    const token = req.query.token || (req.body && req.body.token);
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    let caption = (req.body && typeof req.body.caption === 'string') ? req.body.caption.trim() : '';
    if (caption.length > 500) caption = caption.slice(0, 500);
    const photo = await db.queryOne(
      `SELECT p.id FROM photos p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    await db.query('UPDATE photos SET caption = $1 WHERE id = $2', [caption || null, photo.id]);
    res.json({ ok: true, caption: caption || null });
  } catch (err) {
    console.error('[customer/photo caption] error:', err);
    res.status(500).json({ error: 'Could not save the caption. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/request-revision?token=<access_token>
// Body: { feedback: "What I want changed..." }
// Saves the feedback on the most recent draft, flips customer status, emails Ken.
// ---------------------------------------------------------------------------
router.post('/request-revision', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const feedback = (req.body.feedback || '').trim();
    if (!feedback) return res.status(400).json({ error: 'Please tell us what you would like changed.' });
    if (feedback.length > 5000) return res.status(400).json({ error: 'Feedback is too long (5000 character max).' });

    const customer = await db.queryOne(
      'SELECT id, name, email FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await db.queryOne(
      `SELECT id, version FROM drafts WHERE customer_id = $1
       ORDER BY version DESC, created_at DESC LIMIT 1`,
      [customer.id]
    );
    if (!draft) return res.status(400).json({ error: 'No draft to request revision on yet.' });

    await db.query(
      `UPDATE drafts SET customer_feedback = $1, feedback_received_at = NOW(), status = 'revision_requested'
       WHERE id = $2`,
      [feedback, draft.id]
    );
    await db.query(`UPDATE customers SET status = 'revision_requested' WHERE id = $1`, [customer.id]);

    // Email Ken
    const subject = 'Revision request from ' + customer.name;
    const adminLink = 'https://www.bcsmemorybox.com/admin.html';
    const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Revision request</h2>' +
'<p><strong>' + escapeHtml(customer.name) + '</strong> (' + escapeHtml(customer.email) + ') has requested a revision on their draft v' + draft.version + '.</p>' +
'<div style="background:#faf7f0;border-left:4px solid #8b5a2b;padding:16px 22px;margin:20px 0;white-space:pre-wrap;font-family:Georgia,serif;">' +
escapeHtml(feedback) +
'</div>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'</div>';

    await sendEmail('kbakerbcs1@gmail.com', subject, html);

    res.json({ ok: true, message: 'Your revision request has been sent. Ken will work on it soon.' });
  } catch (err) {
    console.error('[customer/request-revision] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/order-book?token=<access_token>
// Body: { name, address1, address2, city, state, zip, country, copies, notes }
// V1: emails Ken the customer's hardcover book request; Ken confirms payment
// and places the order on Lulu (flow proven manually). No charge taken here.
// ---------------------------------------------------------------------------
router.post('/order-book', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, name, email FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const b = req.body || {};
    const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
    const shipName = clean(b.name, 120);
    const address1 = clean(b.address1, 200);
    const address2 = clean(b.address2, 120);
    const city     = clean(b.city, 120);
    const state    = clean(b.state, 80);
    const zip      = clean(b.zip, 40);
    const country  = clean(b.country, 80) || 'USA';
    const notes    = clean(b.notes, 1000);
    let copies = parseInt(b.copies, 10);
    if (!(copies >= 1)) copies = 1;
    if (copies > 50) copies = 50;

    if (!shipName || !address1 || !city || !state || !zip) {
      return res.status(400).json({ error: 'Please fill in your name and full shipping address.' });
    }

    const priceNote = copies === 1 ? '$99' : ('$99 + ' + (copies - 1) + ' x $49 = $' + (99 + (copies - 1) * 49));
    const subject = 'Hardcover book order from ' + (customer.name || shipName);
    const adminLink = 'https://www.bcsmemorybox.com/admin.html';
    const rows = [
      ['Customer', (customer.name || '') + ' (' + customer.email + ')'],
      ['Ship to', shipName],
      ['Address', address1 + (address2 ? ', ' + address2 : '')],
      ['City / State / Zip', city + ', ' + state + ' ' + zip],
      ['Country', country],
      ['Copies', copies + '  (' + priceNote + ')'],
    ];
    if (notes) rows.push(['Notes', notes]);
    const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Hardcover book order</h2>' +
'<p><strong>' + escapeHtml(customer.name || shipName) + '</strong> would like to order <strong>' + copies + '</strong> hardcover ' + (copies === 1 ? 'copy' : 'copies') + ' of their memoir.</p>' +
'<table style="border-collapse:collapse;margin:16px 0;">' +
rows.map((r) => '<tr><td style="padding:4px 14px 4px 0;color:#8b5a2b;vertical-align:top;"><strong>' + escapeHtml(r[0]) + '</strong></td><td style="padding:4px 0;">' + escapeHtml(r[1]) + '</td></tr>').join('') +
'</table>' +
'<p style="color:#5a4a3a;">Next: confirm details + payment with the customer, then place it on Lulu (template: 8.5x11 hardcover casewrap, color).</p>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'</div>';

    await sendEmail('kbakerbcs1@gmail.com', subject, html);
    res.json({ ok: true, message: "Your book request is in! Ken will email you to confirm the details and arrange payment." });
  } catch (err) {
    console.error('[customer/order-book] error:', err);
    res.status(500).json({ error: 'Something went wrong sending your request. Please try again, or email Ken directly at kbakerbcs1@gmail.com.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/request-link
// Body: { email }
// A returning customer who lost their story link asks for it again. We email
// the link to the address on file. Always responds the same way whether or not
// the email matches an account, so it can't be used to discover who has one.
// ---------------------------------------------------------------------------
router.post('/request-link', async (req, res) => {
  const GENERIC = 'If that email has a Memory Box story, we just sent the link to it. Please check your inbox (and your spam folder).';
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const customer = await db.queryOne(
      'SELECT name, access_token, paid_at FROM customers WHERE email = $1',
      [email]
    );

    // Only paying customers have a story page to return to.
    if (customer && customer.paid_at) {
      try {
        await mailer.sendStoryLink(email, customer.name, customer.access_token, false);
        console.log('[customer/request-link] link re-sent to ' + email);
      } catch (mailErr) {
        // Log only — still return the generic message so the endpoint never
        // reveals whether an email is registered.
        console.error('[customer/request-link] email send failed:', mailErr.message);
      }
    } else {
      console.log('[customer/request-link] no paid account for ' + email + ' (generic response)');
    }

    res.json({ ok: true, message: GENERIC });
  } catch (err) {
    console.error('[customer/request-link] error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function sendEmail(to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'BCS Memory Box <ops@bcsmemorybox.com>',
      to: to,
      reply_to: 'kbakerbcs1@gmail.com',
      subject: subject,
      html: html,
    }),
  });
  if (!resp.ok) throw new Error('Resend error: ' + await resp.text());
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

module.exports = router;


// ----------------------------------------------------------------------------
// POST /api/customer/reopen-recording?token=<access_token>
// Lets a customer who already has a finished (delivered) or draft-ready memoir
// go back into recording mode to add more stories. Flips status back to
// 'recording'. Existing recordings + transcripts are preserved; when they click
// "I'm done" again, the cleanup pipeline re-runs over everything and produces an
// updated draft for the admin to review and re-deliver.
// NOTE: registered after module.exports on purpose — the router is exported by
// reference, so routes added here are still part of the exported router.
// ----------------------------------------------------------------------------
router.post('/reopen-recording', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, status, paid_at FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });
    if (!customer.paid_at) {
      return res.status(403).json({ error: 'Payment is required before recording.' });
    }

    // Reopen only from a finished state. From other states this is a safe no-op,
    // so we never interrupt an in-flight processing run or an unpaid account.
    if (customer.status === 'delivered' || customer.status === 'draft_ready' || customer.status === 'revision_requested') {
      await db.query("UPDATE customers SET status = 'recording' WHERE id = $1", [customer.id]);
      return res.json({ ok: true, reopened: true, message: 'You can add more to your story now.' });
    }
    if (customer.status === 'processing') {
      return res.json({ ok: true, reopened: false, message: 'Your memoir is being prepared right now. Once it is ready you can add more.' });
    }
    // Already recording (or revision_requested / error) — just let them in.
    return res.json({ ok: true, reopened: false, message: 'You can add to your story now.' });
  } catch (err) {
    console.error('[customer/reopen-recording] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});


// ----------------------------------------------------------------------------
// GET /api/customer/recording-audio?token=<access_token>&id=<recording_id>
// Streams one of the customer's OWN recordings back so they can listen to it
// on their story page. Ownership is enforced: the recording must belong to the
// customer that owns the access token. (Registered after module.exports on
// purpose — same reason as reopen-recording above.)
// ----------------------------------------------------------------------------
router.get('/recording-audio', async (req, res) => {
  try {
    const token = req.query.token;
    const id = req.query.id;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    if (!id) return res.status(400).json({ error: 'Missing recording id' });

    const customer = await db.queryOne(
      'SELECT id FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const recording = await db.queryOne(
      'SELECT storage_key, original_filename FROM recordings WHERE id = $1 AND customer_id = $2',
      [id, customer.id]
    );
    if (!recording) return res.status(404).json({ error: 'Recording not found' });

    const { stream, contentType, contentLength } = await storage.getObjectStream(recording.storage_key);
    res.setHeader('Content-Type', contentType || 'audio/mpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    console.error('[customer/recording-audio] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});
