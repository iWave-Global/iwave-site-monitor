// Every 4 hours: open each form in a real browser (Chrome), fill in the test
// details, submit, and confirm the thank-you message / document download.
// Records pass / warn / fail, what the issue was, and a screenshot on problems.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, readJson, writeJson, DATA, setOutput, summary, round, discoverProducts, UA } from './lib.mjs';

const cfg = loadConfig();
const F = cfg.forms;
const SUCCESS_SEL = '.elementor-message-success, .wpcf7-mail-sent-ok, form.sent .wpcf7-response-output, .wpforms-confirmation-container, .gform_confirmation_message, .submitted-message, .hs-form__thankyou-message, .fluentform .ff-message-success';
const ERROR_SEL = '.elementor-message-danger, .elementor-error .elementor-message, .wpcf7-not-valid-tip, form.invalid .wpcf7-response-output, form.failed .wpcf7-response-output, form.spam .wpcf7-response-output, .wpforms-error, .gfield_validation_message, .hs-error-msgs, .ff-el-is-error .error';
const HANDLER_RE = /admin-ajax\.php|wp-json\/contact-form-7|wp-json\/wpforms|gravityforms|forms\.hsforms|hubspot|fluentform|wp-json\/elementor/i;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function resolveUrl(url) {
  if (!url.startsWith('auto:product')) return url;
  let list = readJson('products-list.json', { urls: [] }).urls;
  if (!list.length && cfg.products) list = (await discoverProducts(cfg.products)).urls;
  return list[0] || null;
}

// Mark which forms are visible before we click anything, so a form that
// appears in a popup afterwards can be recognised as "new".
const markVisibleForms = (page) => page.evaluate(() => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
  document.querySelectorAll('form').forEach((f) => { f.dataset.monBefore = vis(f) ? '1' : '0'; });
});

// Find and tag the element that opens the form ('floating' contact button, 'download' button, or a CSS selector).
async function findOpener(page, open, textRe) {
  if (open !== 'floating' && open !== 'download') {
    const loc = page.locator(open).first();
    return (await loc.count()) ? { loc, text: open } : null;
  }
  const info = await page.evaluate(({ open, src }) => {
    const re = new RegExp(src, 'i');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; };
    const fixedAncestor = (e) => { for (let n = e, d = 0; n && d < 6; n = n.parentElement, d++) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return n; } return null; };
    const inChrome = (e) => !!e.closest('header, nav, .elementor-location-header, #masthead, .site-header, .menu, .mega-menu');
    const label = (e) => `${e.innerText || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''} ${e.getAttribute('alt') || ''} ${e.className && typeof e.className === 'string' ? e.className : ''}`.replace(/\s+/g, ' ').trim();
    const badHref = (e) => /wa\.me|whatsapp|^tel:|^mailto:|#top$|linkedin|facebook|twitter|youtube/i.test(e.getAttribute('href') || '');
    const all = [...document.querySelectorAll('a, button, [role=button], [onclick], .elementor-button, div[class*=float], div[class*=sticky], img, span')].filter(vis);
    let best = null;
    for (const e of all) {
      if (badHref(e)) continue;
      const r = e.getBoundingClientRect(), txt = label(e);
      if (open === 'floating') {
        const fx = fixedAncestor(e);
        if (!fx || inChrome(e) || r.width > 450 || r.height > 220) continue;
        if (/scroll|back to top|cookie|accept|chat with|close/i.test(txt)) continue;
        const score = (re.test(txt) ? 10 : 0) + (r.left > innerWidth / 2 ? 1 : 0) + (r.top > innerHeight / 2 ? 1 : 0) + (r.left < 80 || r.right > innerWidth - 80 ? 1 : 0);
        if (score >= 2 && (!best || score > best.score)) best = { e, score, txt };
      } else {
        if (inChrome(e) || e.closest('footer') || !re.test(txt) || r.width > 700) continue;
        if (fixedAncestor(e)) continue;
        const score = (e.matches('a, button, [role=button], .elementor-button') ? 2 : 0) + (/datasheet|data sheet|brochure|document/i.test(txt) ? 2 : 0) + (/\.pdf(\?|$)/i.test(e.getAttribute('href') || '') ? -1 : 0);
        if (!best || score > best.score) best = { e, score, txt };
      }
    }
    if (!best) return null;
    let target = best.e.closest('a, button, [role=button]') || best.e;
    target.setAttribute('data-mon-open', '1');
    return { text: best.txt.slice(0, 60), href: target.getAttribute('href') || '' };
  }, { open, src: textRe });
  if (!info) return null;
  return { loc: page.locator('[data-mon-open="1"]').first(), text: info.text, href: info.href };
}

// Pick the form to test. Prefers a form that just appeared (popup), and for
// pick:'download' a form that talks about downloads.
async function findForm(page, item) {
  if (item.formSelector) {
    const loc = page.locator(item.formSelector).first();
    return (await loc.count()) ? loc : null;
  }
  const idx = await page.evaluate(({ pick, src }) => {
    const re = new RegExp(src, 'i');
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
    const forms = [...document.querySelectorAll('form')];
    let best = -1, bestScore = -1;
    forms.forEach((f, i) => {
      if (!vis(f) || f.getAttribute('role') === 'search' || f.querySelector('input[type=search], input[name=s]')) return;
      const hasEmail = !!f.querySelector('input[type=email], input[name*=email i]');
      const hasSubmit = !!f.querySelector('button[type=submit], input[type=submit], button:not([type])');
      if (!hasEmail && !hasSubmit) return;
      let s = (hasEmail ? 2 : 0) + (f.dataset.monBefore === '0' || f.dataset.monBefore === undefined ? 4 : 0);
      if (pick === 'download') {
        const btn = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
        if (btn && re.test(btn.innerText || btn.value || '')) s += 3;
        const ctx = (f.innerText + ' ' + (f.parentElement?.parentElement?.innerText || '').slice(0, 400));
        if (re.test(ctx)) s += 2;
      }
      if (s > bestScore) { bestScore = s; best = i; } // ties keep the first in page order
    });
    return best;
  }, { pick: item.pick || 'first', src: F.openText.download });
  return idx >= 0 ? page.locator('form').nth(idx) : null;
}

async function describe(form) {
  return form.evaluate((el) => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const fields = [...el.querySelectorAll('input, textarea, select')].filter((e) => !['hidden', 'submit', 'button'].includes(e.type) && vis(e));
    const req = fields.filter((e) => e.required || e.getAttribute('aria-required') === 'true' || e.closest('.elementor-field-required, .gfield_contains_required') || e.classList.contains('wpcf7-validates-as-required'));
    const btn = el.querySelector('button[type=submit], input[type=submit], button:not([type])');
    const cls = `${el.className} ${el.parentElement?.className || ''}`;
    const plugin = /elementor/i.test(cls) ? 'Elementor' : /wpcf7/i.test(cls) || el.closest('.wpcf7') ? 'Contact Form 7' : /wpforms/i.test(cls) ? 'WPForms' : /gform/i.test(el.id + cls) ? 'Gravity Forms' : /hs-form|hbspt/i.test(cls) ? 'HubSpot' : /fluent/i.test(cls) ? 'Fluent Forms' : 'Unknown';
    return {
      plugin, fieldCount: fields.length, requiredCount: req.length,
      fields: fields.map((e) => e.name || e.id || e.type).slice(0, 15),
      button: btn ? { text: (btn.innerText || btn.value || '').trim().slice(0, 40), disabled: btn.disabled, visible: vis(btn) } : null,
      recaptcha: !!document.querySelector('script[src*="recaptcha"], iframe[src*="recaptcha"], .g-recaptcha, script[src*="hcaptcha"], .cf-turnstile'),
    };
  });
}

// Fill every visible field: email -> test email, phone -> test phone, everything else -> "test".
async function fill(form, td) {
  const inputs = form.locator('input, textarea, select');
  const n = await inputs.count();
  const radiosDone = new Set();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    if (!(await el.isVisible().catch(() => false))) {
      // custom-styled checkboxes are often hidden; still tick consent boxes
      const t = await el.getAttribute('type').catch(() => null);
      if (t === 'checkbox') await el.check({ force: true }).catch(() => {});
      continue;
    }
    const info = await el.evaluate((e) => ({ tag: e.tagName, type: e.type, name: e.name, key: `${e.name} ${e.id} ${e.placeholder || ''} ${e.labels?.[0]?.innerText || ''}`.toLowerCase() }));
    try {
      if (info.tag === 'SELECT') { await el.selectOption({ index: 1 }).catch(() => {}); continue; }
      if (info.type === 'checkbox') { await el.check({ force: true }).catch(() => {}); continue; }
      if (info.type === 'radio') { if (!radiosDone.has(info.name)) { radiosDone.add(info.name); await el.check({ force: true }).catch(() => {}); } continue; }
      if (['file', 'submit', 'button', 'hidden', 'image', 'reset'].includes(info.type)) continue;
      let v = td.default;
      if (info.type === 'email' || /e-?mail/.test(info.key)) v = td.email;
      else if (info.type === 'tel' || /phone|mobile|tel|contact no|whatsapp/.test(info.key)) v = td.phone;
      else if (info.tag === 'TEXTAREA' || /message|comment|requirement|query|enquiry|inquiry/.test(info.key)) v = td.message;
      else if (info.type === 'number') v = '1';
      else if (info.type === 'url') v = 'https://example.com';
      else if (info.type === 'date') v = new Date().toISOString().slice(0, 10);
      await el.fill(v);
    } catch { /* ignore individual field problems */ }
  }
}

async function checkForm(browser, item) {
  const res = { name: item.name, url: item.url, mode: item.mode || 'submit', status: 'pass', issues: [], notes: [] };
  const fail = (m) => { res.status = 'fail'; res.issues.push(m); };
  const warn = (m) => { if (res.status === 'pass') res.status = 'warn'; res.issues.push(m); };

  const url = await resolveUrl(item.url);
  if (!url || /REPLACE/i.test(url)) { warn('No page URL - set it in config.json (or check the product sitemap is readable)'); return res; }
  res.url = url;

  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, userAgent: UA });
  const page = await ctx.newPage();
  const jsErrors = [], badRequests = [], handlerCalls = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 160)));
  page.on('response', (r) => {
    const u = r.url();
    if (r.request().method() === 'POST' && HANDLER_RE.test(u)) handlerCalls.push({ url: u.split('?')[0], status: r.status() });
    if (r.status() >= 500 && r.request().resourceType() !== 'image') badRequests.push(`${r.status()} ${u.slice(0, 120)}`);
  });

  try {
    const t0 = Date.now();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    res.httpStatus = resp?.status() ?? null;
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => warn('Page did not finish loading within 60s'));
    res.loadSec = round((Date.now() - t0) / 1000, 2);
    if (!resp || resp.status() >= 400) { fail(`Page returned HTTP ${resp?.status() ?? 'no response'}`); return res; }
    await page.waitForTimeout(1500); // let floating buttons / sliders initialise

    await markVisibleForms(page);
    if (item.open) {
      const textRe = F.openText[item.open] || '';
      const opener = await findOpener(page, item.open, textRe);
      if (!opener) {
        fail(item.open === 'floating' ? 'Floating contact button not found on the page' : item.open === 'download' ? 'Document download button not found on the page' : `Button not found (${item.open})`);
        return res;
      }
      res.opener = opener.text;
      await opener.loc.scrollIntoViewIfNeeded().catch(() => {});
      const directDl = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
      await opener.loc.click({ timeout: 15000 });
      await page.waitForTimeout(3000);
      if (await Promise.race([directDl, new Promise((r) => setTimeout(() => r(null), 100))])) {
        warn(`"${opener.text}" downloads the file directly - no form appears`); return res;
      }
    }

    const form = await findForm(page, item);
    if (!form) { fail(item.open ? `Clicked "${res.opener}" but no form appeared` : 'Form not found on the page (removed, hidden, or failed to load)'); return res; }
    await form.scrollIntoViewIfNeeded().catch(() => {});
    const d = await describe(form);
    Object.assign(res, { plugin: d.plugin, fieldCount: d.fieldCount, requiredCount: d.requiredCount, fields: d.fields, recaptcha: d.recaptcha, button: d.button?.text || null });

    if (d.fieldCount === 0) fail('Form has no visible input fields');
    if (!d.button) fail('Submit button missing');
    else if (!d.button.visible) fail('Submit button not visible');
    else if (d.button.disabled) fail('Submit button is disabled');
    if (d.recaptcha) {
      const rc = await page.evaluate(() => typeof window.grecaptcha !== 'undefined' || typeof window.hcaptcha !== 'undefined' || typeof window.turnstile !== 'undefined');
      if (!rc) warn('reCAPTCHA/captcha element present but its script did not load');
    }
    if (res.status === 'fail') return res;

    const submit = form.locator('button[type=submit], input[type=submit], button:not([type])').first();

    if (res.mode === 'submit') {
      await fill(form, F.testData);
      const thanksRe = new RegExp(F.successText.join('|'), 'i');
      const countThanks = async () => (await page.locator('body').innerText().catch(() => '')).split(/\n+/).filter((l) => l.length < 200 && thanksRe.test(l)).length;
      const thanksBefore = await countThanks();
      const T = 30000;
      const okWhen = (p, label) => p.then((v) => { if (v === null) throw new Error('none'); return label; });
      const anySuccess = Promise.any([
        okWhen(page.locator(SUCCESS_SEL).first().waitFor({ state: 'visible', timeout: T }), 'success message'),
        okWhen(page.waitForEvent('download', { timeout: T }), 'file download'),
        okWhen(ctx.waitForEvent('page', { timeout: T }), 'document opened in new tab'),
        okWhen(page.waitForURL((u) => /thank|success|download|\.pdf/i.test(u.toString()), { timeout: T }), 'thank-you / document page'),
      ]).catch(() => null);
      // stop waiting early if the form shows an error message
      const errorShown = page.locator(ERROR_SEL).first().waitFor({ state: 'visible', timeout: T }).then(() => null).catch(() => new Promise(() => {}));
      const waiting = Promise.race([anySuccess, errorShown]);
      const handlersBefore = handlerCalls.length;
      await submit.click({ timeout: 15000 });
      let how = await waiting;
      await page.waitForTimeout(1000);
      if (!how && (await countThanks()) > thanksBefore) how = 'thank-you text appeared on page';
      const h = handlerCalls.length > handlersBefore ? handlerCalls.at(-1) : null;
      if (how) res.notes.push(`Test entry submitted - success confirmed by ${how}${h ? ` (server HTTP ${h.status})` : ''}`);
      else {
        const err = (await page.locator(ERROR_SEL).allInnerTexts().catch(() => [])).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' | ');
        const invalid = await form.evaluate((el) => [...el.querySelectorAll(':invalid')].map((e) => e.name || e.type).slice(0, 4)).catch(() => []);
        let msg = 'Submitted the test entry but no thank-you message appeared';
        if (err) msg += ` - form said: "${err.slice(0, 160)}"`;
        else if (invalid.length) msg += ` - browser blocked it, fields not accepted: ${invalid.join(', ')} (test data may not match the field format)`;
        if (h) msg += ` (server HTTP ${h.status})`;
        else if (!invalid.length) msg += ' (no request reached the server)';
        if (d.recaptcha && /captcha|spam|robot/i.test(err + ' ')) msg += ' - reCAPTCHA is blocking automated submissions';
        fail(msg);
      }
    } else {
      // 'check' mode: press Submit with EMPTY required fields - the form must reject it.
      if (d.requiredCount === 0) warn('Form has no required fields, so the empty-submit test was skipped');
      else {
        await submit.click({ timeout: 15000 });
        await page.waitForTimeout(6000);
        const invalidNative = await form.evaluate((el) => el.querySelectorAll(':invalid').length);
        const pluginErr = await page.locator(ERROR_SEL).count();
        const success = await page.locator(SUCCESS_SEL).count();
        const handler = handlerCalls.at(-1);
        if (success) warn('Empty submit was ACCEPTED - required-field validation is not working');
        else if (handler) {
          if (handler.status >= 500) fail(`Form server handler returned HTTP ${handler.status} - submissions are probably failing`);
          else if (handler.status === 403) fail('Form server handler blocked with HTTP 403 - firewall may be blocking submissions');
          else res.notes.push(`Form server handler responded HTTP ${handler.status} and rejected the empty entry (correct)`);
        } else if (invalidNative || pluginErr) res.notes.push('Validation working - empty submit was blocked in the browser');
        else warn('Pressed Submit but saw no validation message and no server response - form JavaScript may be broken');
      }
    }
  } catch (e) {
    fail(`Check crashed: ${String(e.message || e).split('\n')[0].slice(0, 200)}`);
  } finally {
    if (jsErrors.length) { res.jsErrors = jsErrors.slice(0, 5); warn(`${jsErrors.length} JavaScript error(s) on page: ${jsErrors[0]}`); }
    if (badRequests.length) { res.serverErrors = badRequests.slice(0, 5); warn(`${badRequests.length} server error(s) loading page resources`); }
    if (res.status !== 'pass') {
      const shot = `screens/${slug(item.name)}.png`;
      await page.screenshot({ path: path.join(DATA, shot), fullPage: false }).catch(() => {});
      if (fs.existsSync(path.join(DATA, shot))) res.screenshot = shot;
    }
    await ctx.close();
  }
  return res;
}

async function main() {
  fs.mkdirSync(path.join(DATA, 'screens'), { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const t = new Date().toISOString();
  const results = [];
  for (const item of F.items) {
    let r = await checkForm(browser, item);
    // Confirm a failure once - but never re-submit a form that may already have sent an entry.
    const mayHaveSent = r.mode === 'submit' && /server HTTP 2\d\d/.test(r.issues.join(' '));
    if (r.status === 'fail' && !mayHaveSent) {
      const r2 = await checkForm(browser, item);
      if (r2.status !== 'fail') { r2.notes.push(`First attempt failed (${r.issues[0]}), retry passed`); r = r2; }
    }
    results.push(r);
  }
  await browser.close();

  const runs = readJson('forms.json', []);
  runs.push({ t, results });
  writeJson('forms.json', runs.slice(-F.keepRuns));

  summary(`### Form check ${t}\n| Form | Page | Result | Issues / notes |\n|---|---|---|---|`);
  for (const r of results) summary(`| ${r.name} | ${r.url} | ${r.status.toUpperCase()} | ${[...r.issues, ...r.notes].join('; ') || '-'} |`);
  const failed = results.filter((r) => r.status === 'fail');
  setOutput('alert', failed.length ? 'true' : 'false');
  setOutput('alert_text', failed.map((r) => `${r.name}: ${r.issues[0]}`).join('; '));
}

main().catch((e) => { console.error(e); process.exit(1); });
