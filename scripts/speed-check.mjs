// Hourly: uptime + response-time check of the homepage and every product page,
// Google PageSpeed Insights for the homepage (+ a few product pages per run, rotating).
// Records results, opens/closes downtime incidents and notes what the issue was.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readJson, writeJson, sleep, round, setOutput, summary, discoverProducts, UA } from './lib.mjs';

const cfg = loadConfig();
const S = cfg.speed;
const P = cfg.products || { enabled: false };

function curl(url, timeoutSec) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'));
  const body = path.join(tmp, 'body'), headers = path.join(tmp, 'headers');
  const args = ['-s', '-L', '--max-redirs', '5', '--compressed', '--max-time', String(timeoutSec), '-A', UA,
    '-o', body, '-D', headers, '-w', '%{json}', url];
  return new Promise((resolve) => {
    execFile('curl', args, { maxBuffer: 1 << 20 }, (_err, stdout) => {
      let w = {};
      try { w = JSON.parse(stdout); } catch { w = { exitcode: 999, errormsg: 'curl produced no output' }; }
      let html = '', hdr = '';
      try { html = fs.readFileSync(body, 'utf8'); } catch {}
      try { hdr = fs.readFileSync(headers, 'utf8'); } catch {}
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ w, html, hdr });
    });
  });
}

function header(hdr, name) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'gim');
  let m, v = null;
  while ((m = re.exec(hdr))) v = m[1].trim(); // last one wins (after redirects)
  return v;
}

// Translate curl / HTTP results into a plain-English issue.
function classify(w, status) {
  const code = w.exitcode ?? 0;
  if (code === 6) return ['DNS failure', 'Domain name did not resolve - check DNS / domain renewal / Sucuri DNS settings.'];
  if (code === 7) return ['Connection refused', 'Server refused the connection - web server or firewall may be down.'];
  if (code === 28) return ['Timeout', `No complete response within ${S.timeoutSec}s - server overloaded or hung (check server load / PHP processes).`];
  if ([35, 51, 53, 54, 58, 59, 60, 77, 83, 90, 91].includes(code)) return ['SSL certificate error', w.errormsg || 'TLS/SSL handshake or certificate problem - check certificate expiry.'];
  if ([52, 55, 56].includes(code)) return ['Connection dropped', w.errormsg || 'Server closed the connection / empty reply.'];
  if (code !== 0) return ['Network error', w.errormsg || `curl exit code ${code}`];
  if (status >= 200 && status < 400) return null;
  const map = {
    403: ['403 Forbidden', 'Blocked - the firewall (Sucuri) may be blocking the page or the monitor. If the site works in a browser, allow the monitor in Sucuri.'],
    404: ['404 Not Found', 'Page missing - URL changed or page deleted (check the sitemap / redirects).'],
    429: ['429 Too Many Requests', 'Rate-limited by the firewall/server.'],
    500: ['500 Internal Server Error', 'WordPress/PHP error - check PHP error log, recent plugin/theme updates.'],
    502: ['502 Bad Gateway', 'Firewall/CDN (Sucuri) could not reach the origin server - origin down or overloaded.'],
    503: ['503 Service Unavailable', 'Server overloaded or in maintenance mode.'],
    504: ['504 Gateway Timeout', 'Origin server too slow - Sucuri gave up waiting (heavy uncached page / high server load).'],
    508: ['508 Resource Limit', 'Hosting account hit its CPU/memory/process limit.'],
  };
  return map[status] || [`HTTP ${status}`, status >= 500 ? 'Server-side error.' : 'Client error response.'];
}

function titleOf(html, url) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (m) return m[1].replace(/&#8211;|&ndash;|&#8212;/g, '-').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;/g, "'").split(/\s+[|\-–]\s+iWave/i)[0].trim();
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || url;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function checkOnce(page) {
  const { w, html, hdr } = await curl(page.url, S.timeoutSec);
  const status = w.http_code ?? w.response_code ?? 0;
  let issue = classify(w, status);
  if (!issue && page.mustContain && !html.toLowerCase().includes(page.mustContain.toLowerCase())) {
    issue = ['Content check failed', `Page loaded (HTTP ${status}) but "${page.mustContain}" was not found - page may be blank, broken or showing an error.`];
  }
  return {
    name: page.name || titleOf(html, page.url), url: page.url, ok: !issue, status,
    dns: round(w.time_namelookup), connect: round(w.time_connect), tls: round(w.time_appconnect),
    ttfb: round(w.time_starttransfer), total: round(w.time_total),
    size: w.size_download ?? null, redirects: w.num_redirects ?? 0,
    cache: header(hdr, 'x-sucuri-cache') || header(hdr, 'x-litespeed-cache') || header(hdr, 'cf-cache-status') || null,
    issue: issue ? issue[0] : null, detail: issue ? issue[1] : null,
  };
}

function markSlow(r) {
  if (r.ok && r.ttfb != null && r.ttfb > S.slowThresholdSec) {
    r.slow = true;
    r.issue = 'Slow response';
    r.detail = `Server took ${r.ttfb.toFixed(2)}s to respond (threshold ${S.slowThresholdSec}s) - page probably not cached or server busy.`;
  }
  return r;
}

async function checkPage(page) {
  let r = await checkOnce(page);
  if (!r.ok) { // confirm the failure before calling it downtime
    await sleep(S.retryDelaySec * 1000);
    const r2 = await checkOnce(page);
    if (r2.ok) { r2.flaky = `First attempt failed (${r.issue}), retry OK`; r = r2; } else r.retried = true;
  }
  return markSlow(r);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Google Lighthouse run on the GitHub server itself - the same engine PageSpeed
// Insights uses, but needs no API key. Used when no PSI_API_KEY is set or PSI fails.
function lighthouseLocal(url, strategy) {
  const args = ['lighthouse', url, '--output=json', '--output-path=stdout', '--quiet', '--only-categories=performance',
    '--max-wait-for-load=60000', '--chrome-flags=--headless=new --no-sandbox --disable-gpu'];
  if (strategy === 'desktop') args.push('--preset=desktop');
  return new Promise((resolve) => {
    execFile('npx', args, { maxBuffer: 64 << 20, timeout: 180000 }, (err, stdout) => {
      try {
        const lhr = JSON.parse(stdout);
        if (lhr.runtimeError?.code) return resolve({ url, strategy, source: 'lighthouse', error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message || ''}`.slice(0, 200) });
        resolve(fromLhr(url, strategy, lhr, null, 'lighthouse'));
      } catch {
        resolve({ url, strategy, source: 'lighthouse', error: String(err?.message || 'Lighthouse failed').split('\n')[0].slice(0, 200) });
      }
    });
  });
}

function fromLhr(url, strategy, lhr, field, source) {
  const a = lhr.audits;
  const num = (id) => a[id]?.numericValue ?? null;
  return {
    url, strategy, source,
    score: Math.round((lhr.categories.performance.score ?? 0) * 100),
    fcp: round(num('first-contentful-paint') / 1000, 2),
    lcp: round(num('largest-contentful-paint') / 1000, 2),
    tbt: Math.round(num('total-blocking-time') ?? 0),
    cls: round(num('cumulative-layout-shift'), 3),
    si: round(num('speed-index') / 1000, 2),
    serverMs: Math.round(num('server-response-time') ?? 0),
    field,
  };
}

async function pagespeed(url, strategy) {
  if (!process.env.PSI_API_KEY) return lighthouseLocal(url, strategy);
  const r = await pagespeedApi(url, strategy);
  return r.error ? lighthouseLocal(url, strategy) : r;
}

async function pagespeedApi(url, strategy) {
  const key = process.env.PSI_API_KEY ? `&key=${encodeURIComponent(process.env.PSI_API_KEY)}` : '';
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${key}`;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(150000) });
    const j = await res.json();
    if (!res.ok) return { url, strategy, error: j?.error?.message?.slice(0, 200) || `HTTP ${res.status}` };
    // Real-user data from Chrome (CrUX, last 28 days) - only Google's API has this
    const m = j.loadingExperience?.metrics || {};
    const real = j.loadingExperience?.overall_category ? {
      category: j.loadingExperience.overall_category,
      lcp: m.LARGEST_CONTENTFUL_PAINT_MS ? round(m.LARGEST_CONTENTFUL_PAINT_MS.percentile / 1000, 2) : null,
      inp: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE ? round(m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100, 3) : null,
      fcp: m.FIRST_CONTENTFUL_PAINT_MS ? round(m.FIRST_CONTENTFUL_PAINT_MS.percentile / 1000, 2) : null,
      ttfb: m.EXPERIMENTAL_TIME_TO_FIRST_BYTE ? round(m.EXPERIMENTAL_TIME_TO_FIRST_BYTE.percentile / 1000, 2) : null,
    } : null;
    return fromLhr(url, strategy, j.lighthouseResult, real, 'pagespeed-api');
  } catch (e) {
    return { url, strategy, error: String(e.message || e).slice(0, 200) };
  }
}

// Open / close incidents. type: 'down' (main pages), 'product' (a product page), 'slow', 'flaky'.
function updateIncidents(incidents, checks, now, type, noteSlow) {
  const opened = [], closed = [];
  for (const c of checks) {
    const open = incidents.find((i) => i.type === type && !i.end && (type === 'product' ? i.url === c.url : i.name === c.name));
    if (!c.ok && !c.suppressed) {
      if (open) { open.lastSeen = now; open.checks += 1; if (open.issue !== c.issue) open.issues = [...new Set([...(open.issues || [open.issue]), c.issue])]; }
      else {
        const inc = { id: `${Date.parse(now)}-${type}-${c.url}`, type, name: c.name, url: c.url, start: now, lastSeen: now, end: null, durationMin: null, issue: c.issue, detail: c.detail, status: c.status, checks: 1 };
        incidents.push(inc); opened.push(inc);
      }
    } else if (open && c.ok) {
      open.end = now; open.durationMin = Math.round((Date.parse(now) - Date.parse(open.start)) / 60000); closed.push(open);
    }
    if (noteSlow && c.ok && (c.slow || c.flaky)) {
      incidents.push({ id: `${Date.parse(now)}-w-${c.url}`, type: c.slow ? 'slow' : 'flaky', name: c.name, url: c.url, start: now, end: now, durationMin: 0, issue: c.slow ? c.issue : 'Brief failure', detail: c.slow ? c.detail : c.flaky, status: c.status, checks: 1 });
    }
  }
  // close outages for pages no longer monitored
  for (const i of incidents) if (i.type === type && !i.end && !checks.some((c) => (type === 'product' ? c.url === i.url : c.name === i.name))) {
    i.end = now; i.durationMin = Math.round((Date.parse(now) - Date.parse(i.start)) / 60000); i.detail += ' (closed: page no longer monitored)';
  }
  return { opened, closed };
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function runProducts(now, siteDown) {
  const { urls, error } = await discoverProducts(P);
  if (!urls.length) return { error: error || 'No product pages found', results: [] };
  let results = await pool(urls, P.concurrency || 4, (u) => checkOnce({ url: u }));
  // confirm failures once
  const failed = results.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0);
  if (failed.length && failed.length <= 40) {
    await sleep(S.retryDelaySec * 1000);
    for (const i of failed) { const r2 = await checkOnce({ url: urls[i] }); if (r2.ok) { r2.flaky = `First attempt failed (${results[i].issue}), retry OK`; results[i] = r2; } }
  }
  results = results.map(markSlow);
  if (siteDown) results.forEach((r) => { if (!r.ok) r.suppressed = true; }); // whole-site outage already logged on the homepage

  // per-page rolling history (compact, aligned arrays)
  const H = readJson('products-pages.json', { t: [], pages: {}, psi: {} });
  const keep = P.historyHours || 168;
  H.t.push(now);
  H.t = H.t.slice(-keep);
  const L = H.t.length;
  const fit = (a, v) => { a.push(v); while (a.length < L) a.unshift(null); return a.slice(-L); };
  const seen = new Set();
  for (const r of results) {
    seen.add(r.url);
    const p = H.pages[r.url] || { name: r.name, ttfb: [], st: [], c: [] };
    p.ttfb = fit(p.ttfb, r.ok ? r.ttfb : null); p.st = fit(p.st, r.status); p.c = fit(p.c, r.cache ? r.cache.slice(0, 4) : null);
    p.name = r.name; p.issue = r.ok ? (r.slow ? r.issue : null) : r.issue; p.detail = r.ok && !r.slow ? null : r.detail; p.size = r.size;
    H.pages[r.url] = p;
  }
  for (const u of Object.keys(H.pages)) if (!seen.has(u)) delete H.pages[u];

  // rotating PageSpeed for product pages (oldest first)
  if (P.pagespeedPerRun > 0) {
    const order = urls.slice().sort((a, b) => Date.parse(H.psi[a]?.t || 0) - Date.parse(H.psi[b]?.t || 0)).slice(0, P.pagespeedPerRun);
    const ps = await pool(order, process.env.PSI_API_KEY ? 4 : 1, (u) => pagespeed(u, P.pagespeedStrategy || 'mobile'));
    ps.forEach((p) => { H.psi[p.url] = { t: now, score: p.score ?? null, lcp: p.lcp ?? null, tbt: p.tbt ?? null, error: p.error || null }; });
    for (const u of Object.keys(H.psi)) if (!seen.has(u)) delete H.psi[u];
  }
  writeJson('products-pages.json', H);

  // per-run summary (kept 90 days)
  const ok = results.filter((r) => r.ok), t = ok.map((r) => r.ttfb).filter((v) => v != null);
  const run = {
    t: now, n: results.length, ok: ok.length, fail: results.length - ok.length, slow: results.filter((r) => r.slow).length,
    avg: t.length ? round(t.reduce((a, b) => a + b, 0) / t.length) : null, median: pct(t, 50), p95: pct(t, 95), max: t.length ? Math.max(...t) : null,
    cached: results.filter((r) => /hit/i.test(r.cache || '')).length,
    slowest: ok.slice().sort((a, b) => b.ttfb - a.ttfb).slice(0, 5).map((r) => ({ name: r.name, url: r.url, ttfb: r.ttfb })),
    error,
  };
  const hist = readJson('products-history.json', []);
  hist.push(run);
  const cutoff = Date.now() - S.retentionDays * 864e5;
  writeJson('products-history.json', hist.filter((r) => Date.parse(r.t) > cutoff));
  return { run, results, error };
}

async function main() {
  const now = new Date().toISOString();
  const checks = [];
  for (const p of S.pages) checks.push(await checkPage(p));

  const psi = [];
  for (const u of S.pagespeed?.urls || []) for (const st of S.pagespeed.strategies || ['mobile']) psi.push(await pagespeed(u, st));

  const runs = readJson('speed.json', []);
  runs.push({ t: now, checks, psi });
  const cutoff = Date.now() - S.retentionDays * 864e5;
  writeJson('speed.json', runs.filter((r) => Date.parse(r.t) > cutoff));

  const incidents = readJson('incidents.json', []);
  const main = updateIncidents(incidents, checks, now, 'down', true);

  let prod = null, prodInc = { opened: [], closed: [] };
  if (P.enabled) {
    prod = await runProducts(now, checks.some((c) => !c.ok));
    prodInc = updateIncidents(incidents, prod.results, now, 'product', false);
  }
  writeJson('incidents.json', incidents.filter((i) => !i.end || Date.parse(i.end) > cutoff));

  summary(`### Speed check ${now}\n| Page | Status | TTFB (s) | Total (s) | Cache | Issue |\n|---|---|---|---|---|---|`);
  for (const c of checks) summary(`| ${c.name} | ${c.status} | ${c.ttfb ?? '-'} | ${c.total ?? '-'} | ${c.cache ?? '-'} | ${c.issue ?? 'OK'} |`);
  for (const p of psi) summary(`- PageSpeed ${p.strategy}: ${p.error ? 'ERROR ' + p.error : p.score + ' (LCP ' + p.lcp + 's, TBT ' + p.tbt + 'ms)'}`);
  if (prod?.run) summary(`- Product pages: ${prod.run.n} checked, ${prod.run.fail} failing, ${prod.run.slow} slow (>${S.slowThresholdSec}s), median ${prod.run.median}s, p95 ${prod.run.p95}s`);
  if (prod?.error) summary(`- Product pages warning: ${prod.error}`);
  for (const o of main.opened) summary(`- DOWN: ${o.name} - ${o.issue}: ${o.detail}`);
  for (const o of prodInc.opened) summary(`- PRODUCT PAGE ERROR: ${o.name} (${o.url}) - ${o.issue}`);
  for (const c of [...main.closed, ...prodInc.closed]) summary(`- RECOVERED: ${c.name} after ~${c.durationMin} min`);

  const alerts = [...main.opened.map((o) => `${o.name}: ${o.issue}`)];
  if (prodInc.opened.length) alerts.push(`${prodInc.opened.length} product page(s) failing (${prodInc.opened.slice(0, 3).map((o) => o.issue).join(', ')})`);
  setOutput('alert', alerts.length ? 'true' : 'false');
  setOutput('alert_text', alerts.join('; '));
}

main().catch((e) => { console.error(e); process.exit(1); });
