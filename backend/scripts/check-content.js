#!/usr/bin/env node
// ============================================================================
// Content guard — refuses to let a RETIRED price token creep back into the
// customer-facing copy or the email templates.
//
// This is the safety net behind lib/pricing.js: even if someone hand-types an
// old price somewhere, this check finds it. Run it before every deploy:
//
//     node backend/scripts/check-content.js
//
// Exit code 0 = clean, 1 = a retired price was found (with file:line printed).
// The list of banned tokens lives in lib/pricing.js (RETIRED_PRICE_TOKENS), so
// there is still exactly ONE place that knows what the retired prices are.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { RETIRED_PRICE_TOKENS } = require('../lib/pricing');
const { runFlowChecks } = require('./check-flow');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.resolve(__dirname, '..');

// Build one regex that matches any retired token as a whole price
// (so "$49" does NOT match inside "$499", and "$175" won't match "17500").
const nums = RETIRED_PRICE_TOKENS.map(t => t.replace(/[^0-9]/g, '')).sort((a, b) => b.length - a.length);
const BANNED = new RegExp('\\$(' + nums.join('|') + ')(?![0-9.])');

// Files we scan: every customer-facing HTML page at the repo root, plus the
// backend JS that builds emails / checkout. We SKIP node_modules, the guard
// itself, and lib/pricing.js (which legitimately lists the banned tokens).
const SKIP_DIRS = new Set(['node_modules', '.git', 'scripts']);
const SKIP_FILES = new Set([path.resolve(BACKEND, 'lib', 'pricing.js')]);

function walk(dir, exts, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, exts, out);
    } else if (exts.some(e => entry.name.endsWith(e)) && !SKIP_FILES.has(full)) {
      out.push(full);
    }
  }
}

const files = [];
// Frontend pages (repo root, non-recursive is fine — they all live at root).
for (const f of fs.readdirSync(REPO_ROOT)) {
  if (f.endsWith('.html')) files.push(path.join(REPO_ROOT, f));
}
// Backend JS.
walk(BACKEND, ['.js'], files);

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (BANNED.test(line)) {
      hits.push(path.relative(REPO_ROOT, file) + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
    }
  });
}

// Flow guard: make sure the customer can still read + APPROVE their own book.
const flowErrors = runFlowChecks();

if (hits.length || flowErrors.length) {
  if (hits.length) {
    console.error('❌ Content guard FAILED — retired price token(s) found:');
    console.error('   (retired prices per lib/pricing.js: ' + RETIRED_PRICE_TOKENS.join(', ') + ')\n');
    hits.forEach(h => console.error('   ' + h));
    console.error('\nUpdate these to the current price, or change RETIRED_PRICE_TOKENS if a price was un-retired.');
  }
  if (flowErrors.length) {
    console.error((hits.length ? '\n' : '') + '❌ Flow guard FAILED — the customer approve path is at risk:\n');
    flowErrors.forEach(e => console.error('   ' + e + '\n'));
    console.error('See the "VERIFY BEFORE YOU TOUCH IT" standing rule in the Project Handbook.');
  }
  process.exit(1);
}

console.log('✅ Content guard passed — no retired price tokens in ' + files.length + ' files.');
console.log('✅ Flow guard passed — customers can still read + approve their book (draft_ready path intact).');
process.exit(0);
