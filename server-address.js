/* ==========================================================================
   server-address.js — the ONE place the website learns where the BCS server is.

   Every page that talks to the backend loads this file first. When the server
   moves, change the address here and nowhere else.

   History: the old server (bcs-memory-box-site.onrender.com) was deleted on
   Sept 5, 2026. The rebuilt server (Sept 15, 2026) was given a new address, and
   the old one was hard-coded in eight places across seven files — so the site
   silently pointed at nothing. This file replaces all eight.
   ========================================================================== */
window.BCS_API_BASE = 'https://bcs-memory-box-site-s0wp.onrender.com';
