/* ==========================================================================
   closed.js — the "we are closed" notice shown over the customer pages.

   Closed August 31, 2026. Included by index.html, signup.html and
   yourstory.html. To reopen the site, set CLOSED to false here and in
   backend/lib/closed.js.

   Deliberately NOT included by listen.html, so the QR code printed inside
   the hardcover still plays.
   ========================================================================== */
(function () {
  var CLOSED = true;
  if (!CLOSED) return;

  function show() {
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
      'background:#faf6f0;display:flex;align-items:center;justify-content:center;' +
      'padding:28px;overflow:auto;font-family:Georgia,"Times New Roman",serif;color:#2a2520;';
    overlay.innerHTML =
      '<div style="max-width:560px;line-height:1.65;">' +
      '<h1 style="color:#8b5a2b;font-size:30px;margin:0 0 20px;font-weight:bold;">BCS Memory Box</h1>' +
      '<p style="font-size:19px;margin:0 0 16px;">Thank you for coming by.</p>' +
      '<p style="font-size:19px;margin:0 0 16px;">BCS Memory Box is no longer taking new ' +
      'stories, and the recording pages are now closed.</p>' +
      '<p style="font-size:19px;margin:0 0 16px;">If you have a book already on its way, ' +
      'it is still coming. Nothing about that has changed.</p>' +
      '<p style="font-size:17px;margin:28px 0 0;color:#5a534c;">&mdash; Ken Baker</p>' +
      '</div>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }
})();
