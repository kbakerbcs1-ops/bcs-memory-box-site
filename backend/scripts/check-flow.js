#!/usr/bin/env node
// ============================================================================
// Flow guard — refuses to let a deploy break the customer's ability to APPROVE
// their own book. This is the automatic wall behind the Aug 13, 2026 bug where
// the pipeline finalized books into `status='delivered'` — a dead-end state with
// NO approve button — stranding the customer (see the "VERIFY BEFORE YOU TOUCH
// IT" standing rule in the Project Handbook).
//
// It is a STATIC check: it reads the source and asserts a few invariants. It
// needs no database, no API keys, no money, and has no side effects, so it is
// safe to run on every build. Run manually with:
//
//     node backend/scripts/check-flow.js
//
// Exit 0 = all invariants hold; 1 = an invariant broke (with the reason). It is
// also required + run by scripts/check-content.js, so it fires on every deploy.
// ============================================================================

const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(rel, fromRepoRoot) {
  const full = fromRepoRoot ? path.join(REPO_ROOT, rel) : path.join(BACKEND, rel);
  try { return fs.readFileSync(full, 'utf8'); }
  catch (e) { return null; }
}

// Each invariant: { file, mustContain?: [regex|str], mustNotContain?: [regex], why }
const CLEANUP = 'lib/cleanup.js';
const CUSTOMER = 'routes/customer.js';
const YOURSTORY = 'yourstory.html';

const INVARIANTS = [
  {
    label: 'Pipeline finalizes customers into an APPROVABLE state (draft_ready)',
    rel: CLEANUP, fromRepoRoot: false,
    mustContain: [/customers\s+SET\s+status\s*=\s*'draft_ready'/],
    why: "The finish pipeline (lib/cleanup.js) must leave a finished customer at 'draft_ready' — " +
         "the only state whose story page shows the approve button. If this is gone, finished books " +
         "no longer land where the customer can approve them.",
  },
  {
    label: "Pipeline NEVER finalizes a customer/draft into the dead-end 'delivered'",
    rel: CLEANUP, fromRepoRoot: false,
    mustNotContain: [/status\s*=\s*'delivered'/],
    why: "'delivered' is a terminal state with NO customer approve button (it is only ever produced by " +
         "Ken's manual admin \"Approve and Send\"). The pipeline must never set it — doing so strands the " +
         "customer with a finished book they cannot approve. This is exactly the Aug 13, 2026 regression.",
  },
  {
    label: 'The draft_ready story page routes to the memoir + approve controls',
    rel: YOURSTORY, fromRepoRoot: true,
    mustContain: [
      "status === 'draft_ready'",          // the router sends draft_ready -> renderDraftReady
      'function renderDraftReady',          // that screen exists
      'renderDecisionCard(memoir, customer)', // ...and includes the decision/approve card
      'id="approve-btn"',                   // ...which has the approve button
    ],
    why: "yourstory.html must route customer status 'draft_ready' to renderDraftReady, which must render " +
         "renderDecisionCard, which must contain the approve button (id=\"approve-btn\"). If any link in " +
         "this chain is missing, the customer sees their book but has no way to approve it.",
  },
  {
    label: 'The memoir is visible to the customer at draft_ready',
    rel: CUSTOMER, fromRepoRoot: false,
    mustContain: [/status IN \([^)]*ready_for_review/],
    why: "The /me memoir query (routes/customer.js) must include 'ready_for_review' in its status filter, " +
         "or the finished memoir will not load on the draft_ready page and the customer sees an empty book.",
  },
];

function runFlowChecks() {
  const errors = [];
  for (const inv of INVARIANTS) {
    const src = read(inv.rel, inv.fromRepoRoot);
    if (src == null) {
      errors.push('MISSING FILE: ' + inv.rel + ' — cannot verify: ' + inv.label);
      continue;
    }
    for (const needle of (inv.mustContain || [])) {
      const ok = (needle instanceof RegExp) ? needle.test(src) : src.includes(needle);
      if (!ok) {
        errors.push('BROKEN: ' + inv.label + '\n     in ' + inv.rel +
          ' — expected to find: ' + needle + '\n     WHY: ' + inv.why);
      }
    }
    for (const needle of (inv.mustNotContain || [])) {
      if (needle.test(src)) {
        errors.push('BROKEN: ' + inv.label + '\n     in ' + inv.rel +
          ' — must NOT contain: ' + needle + '\n     WHY: ' + inv.why);
      }
    }
  }
  return errors;
}

module.exports = { runFlowChecks };

// Standalone run
if (require.main === module) {
  const errors = runFlowChecks();
  if (errors.length) {
    console.error('❌ Flow guard FAILED — the customer approve path is at risk:\n');
    errors.forEach(e => console.error('   ' + e + '\n'));
    console.error('See the "VERIFY BEFORE YOU TOUCH IT" standing rule in the Project Handbook.');
    process.exit(1);
  }
  console.log('✅ Flow guard passed — customers can still read + approve their book (draft_ready path intact).');
  process.exit(0);
}
