// One-off diagnostic: are the Contact Form 7 forms blocking REAL visitors, or only the robot test?
// Submits the homepage floating contact form in three ways and records what the server says:
//   1. automated  - headless browser, exactly like the 4-hourly monitor
//   2. human-like - real Chrome window (virtual screen), automation flags hidden, slow typing, mouse moves
//   3. human-like + realistic text - same as 2 but without the word "test" and with a 10-digit phone
// Also checks whether the reCAPTCHA keys are valid for this domain.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, writeJson, DATA } from './lib.mjs';

const cfg = loadConfig();
const URL_HOME = cfg.speed.pages[0].url;
const VARIANTS = [
  { id: 'automated', human: false, data: { def: 'test', email: 'test@gmail.com', phone: '1234568', msg: 'test' } },
  { id: 'human-like', human: true, data: { def: 'test', email: 'test@gmail.com', phone: '1234568', msg: 'test' } },
  { id: 'human-like-realistic', human: true, data: { def: 'Website Monitor', email: 'test@gmail.com', phone: '9876543210', msg: 'Diagnostic check from the iWave website monitor. Please ignore this message.' } },
];

const pause = (p, a, b) => p.waitForTimeout(a + Math.random() * (b - a));

async function run(v) {
  const out = { variant: v.id, result: null, message: null, recaptchaToken: null, recaptchaBadge: null, consoleErrors: [], notes: [] };
  const browser = await chromium.launch(v.human
    ? { headless: false, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--window-size=1366,900'] }
    : { headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    ...(v.human ? {} : { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 iWaveSiteMonitor/1.0' }) });
  if (v.human) await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 160)); });
  page.on('request', (r) => {
    if (r.method() === 'POST' && /contact-form-7\/v1\/contact-forms\/\d+\/feedback/.test(r.url())) {
      const body = r.postData() || '';
      const m = body.match(/name="_wpcf7_recaptcha_response"\r?\n\r?\n([^\r\n]*)/);
      out.recaptchaToken = m ? (m[1].length > 20 ? `present (${m[1].length} chars)` : 'EMPTY - reCAPTCHA did not produce a token') : 'field not sent';
    }
  });
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && /contact-form-7\/v1\/contact-forms\/\d+\/feedback/.test(r.url())) {
      try { const j = await r.json(); out.result = j.status; out.message = j.message; out.invalid = j.invalid_fields; } catch {}
    }
  });
  try {
    await page.goto(URL_HOME, { waitUntil: 'load', timeout: 90000 });
    if (v.human) { // behave like a visitor for a while (reCAPTCHA v3 scores behaviour)
      for (let i = 0; i < 6; i++) { await page.mouse.move(200 + Math.random() * 900, 150 + Math.random() * 500, { steps: 12 }); await pause(page, 400, 900); }
      await page.mouse.wheel(0, 600); await pause(page, 1200, 2000); await page.mouse.wheel(0, -600); await pause(page, 1500, 2500);
    } else await page.waitForTimeout(1500);

    // reCAPTCHA badge: shows "ERROR for site owner" text when the keys are wrong
    for (const f of page.frames()) {
      if (/recaptcha\/(api2|enterprise)\/anchor/.test(f.url())) {
        const t = (await f.locator('body').innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
        out.recaptchaBadge = /error/i.test(t) ? `ERROR: ${t.slice(0, 160)}` : 'OK (no error shown)';
      }
    }
    if (!out.recaptchaBadge) out.recaptchaBadge = 'badge not found';

    const btn = page.locator('.contactModal, [class*=floating-btn]').first();
    if (!(await btn.count())) { out.notes.push('floating Contact Us button not found'); return out; }
    await btn.hover().catch(() => {}); await pause(page, 300, 700);
    await btn.click(); await pause(page, 1500, 2500);
    const form = page.locator('form.wpcf7-form:visible').first();
    if (!(await form.count())) { out.notes.push('popup form did not appear'); return out; }
    const fields = form.locator('input:visible, textarea:visible');
    const n = await fields.count();
    for (let i = 0; i < n; i++) {
      const el = fields.nth(i);
      const info = await el.evaluate((e) => ({ type: e.type, key: `${e.name} ${e.placeholder || ''}`.toLowerCase(), tag: e.tagName }));
      if (['submit', 'checkbox', 'radio', 'hidden', 'file'].includes(info.type)) { if (info.type === 'checkbox') await el.check({ force: true }).catch(() => {}); continue; }
      let val = v.data.def;
      if (info.type === 'email' || info.key.includes('mail')) val = v.data.email;
      else if (info.type === 'tel' || /phone|tel|mobile/.test(info.key)) val = v.data.phone;
      else if (info.tag === 'TEXTAREA' || /message/.test(info.key)) val = v.data.msg;
      else if (/company/.test(info.key) && v.human && v.data.def !== 'test') val = 'iWave Systems';
      await el.click();
      if (v.human) { await el.pressSequentially(val, { delay: 60 + Math.random() * 80 }); await pause(page, 300, 900); }
      else await el.fill(val);
    }
    if (v.human) await pause(page, 2000, 3500);
    await form.locator('[type=submit], button').first().click();
    for (let i = 0; i < 30 && !out.result; i++) await page.waitForTimeout(1000);
    if (!out.result) out.notes.push('no reply from the form server within 30 s');
  } catch (e) {
    out.notes.push(`crashed: ${String(e.message).split('\n')[0].slice(0, 160)}`);
  } finally {
    await page.screenshot({ path: path.join(DATA, 'screens', `diagnostic-${v.id}.png`) }).catch(() => {});
    await browser.close();
  }
  return out;
}

const results = [];
for (const v of VARIANTS) { results.push(await run(v)); console.log(JSON.stringify(results.at(-1))); }

const human = results.filter((r) => r.variant !== 'automated');
let verdict;
if (results.some((r) => /^ERROR/.test(r.recaptchaBadge || ''))) verdict = 'BROKEN reCAPTCHA KEYS - the reCAPTCHA badge shows an error. Every visitor submission is probably being rejected as spam. Fix the keys in Contact > Integration.';
else if (human.some((r) => r.result === 'mail_sent')) verdict = 'Forms accept submissions from a normal browser. Only the automated (robot) test is blocked as spam - real visitors are fine.';
else if (human.some((r) => r.result === 'mail_failed')) verdict = 'Form accepted the entry but the WEBSITE COULD NOT SEND THE EMAIL (mail_failed). Real enquiries are probably not reaching the inbox. Check SMTP / mail settings.';
else if (human.every((r) => r.result === 'spam')) verdict = 'Even a normal-looking browser submission is marked as SPAM. Real visitors are very likely being blocked too. Check the reCAPTCHA score threshold / keys, Akismet, and Settings > Discussion > Disallowed Comment Keys, and look in Flamingo > Inbound Messages > Spam.';
else verdict = 'Inconclusive - see the details for each attempt.';

fs.mkdirSync(path.join(DATA, 'screens'), { recursive: true });
writeJson('form-diagnostic.json', { t: new Date().toISOString(), verdict, results });
console.log('VERDICT:', verdict);
