// Shared email helper for customer-facing "link to your story" messages.
// Used by the Stripe webhook (welcome email on payment) and the
// /api/customer/request-link endpoint (returning customer asks for their link).
//
// Keeps the "from" / "reply_to" identity consistent with the rest of the app:
// sends FROM the branded address, replies go to Ken's Gmail.

const FRONTEND_BASE = 'https://www.bcsmemorybox.com';

function portalUrlFor(accessToken) {
  return FRONTEND_BASE + '/yourstory.html?token=' + encodeURIComponent(accessToken);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Build the subject + HTML for a "here's your story link" email.
// firstTime=true  -> warm welcome right after they pay.
// firstTime=false -> returning customer who asked for their link again.
function storyLinkEmail({ name, portalUrl, firstTime }) {
  const hello = 'Hi ' + escapeHtml((name || '').split(' ')[0] || 'there') + ',';

  const subject = firstTime
    ? 'Welcome to Memory Box — the link to your story'
    : 'Here is the link to your Memory Box story';

  const intro = firstTime
    ? 'Welcome to Memory Box! Your story is ready for you to start recording. '
      + 'Use the button below to open your story page — on this computer or on your phone.'
    : 'Here is the link back to your story. Click it to pick up right where you left off.';

  const keepLine = firstTime
    ? '<p style="margin:22px 0 0;"><strong>Please keep this email.</strong> '
      + 'You can record a little, take a break, and come back whenever you like to add more — '
      + 'just open this email and click the button to return to your story.</p>'
    : '<p style="margin:22px 0 0;">You can come back to your story as often as you like. '
      + 'If you ever lose this link, request it again from the homepage.</p>';

  const ignoreLine = firstTime
    ? ''
    : '<p style="margin:18px 0 0;font-size:13px;color:#7a726a;">'
      + 'If you did not request this, you can safely ignore this email.</p>';

  const html =
    '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">'
    + '<h2 style="color:#8b5a2b;margin:0 0 14px;">Your Memory Box story</h2>'
    + '<p style="margin:0 0 10px;">' + hello + '</p>'
    + '<p style="margin:0 0 8px;">' + intro + '</p>'
    + '<p style="margin:26px 0;text-align:center;">'
    + '<a href="' + portalUrl + '" style="background:#8b5a2b;color:#fff;padding:16px 34px;'
    + 'text-decoration:none;border-radius:6px;display:inline-block;font-family:Georgia,serif;'
    + 'font-weight:bold;font-size:18px;">Open my story</a></p>'
    + '<p style="margin:0 0 4px;font-size:14px;color:#5a534c;">'
    + 'If the button does not work, copy and paste this link into your web browser:</p>'
    + '<p style="margin:0;font-size:14px;"><a href="' + portalUrl + '" '
    + 'style="color:#8b5a2b;word-break:break-all;">' + portalUrl + '</a></p>'
    + keepLine
    + ignoreLine
    + '</div>';

  return { subject, html };
}

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

// Convenience: build + send a story-link email in one call.
async function sendStoryLink(to, name, accessToken, firstTime) {
  const portalUrl = portalUrlFor(accessToken);
  const { subject, html } = storyLinkEmail({ name, portalUrl, firstTime });
  return sendEmail(to, subject, html);
}

module.exports = { sendEmail, sendStoryLink, storyLinkEmail, portalUrlFor, escapeHtml };
