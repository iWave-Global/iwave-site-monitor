// Shared helpers for the monitor scripts (no external dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.MONITOR_DATA_DIR || path.join(ROOT, 'docs', 'data');

export function loadConfig() {
  return JSON.parse(fs.readFileSync(process.env.MONITOR_CONFIG || path.join(ROOT, 'config.json'), 'utf8'));
}

export function readJson(name, fallback) {
  const p = path.join(DATA, name);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJson(name, value) {
  fs.mkdirSync(DATA, { recursive: true });
  const p = path.join(DATA, name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, p);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d = 3) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

// Write a GitHub Actions step output (used to fail the job => GitHub emails you).
export function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 iWaveSiteMonitor/1.0';

const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));

// Find every product page URL from the (Yoast) sitemap. Falls back to the last
// saved list if the sitemap can't be read, so one bad fetch doesn't stop checks.
export async function discoverProducts(P) {
  const get = async (u) => {
    const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    return r.text();
  };
  try {
    const index = await get(P.sitemapIndex);
    let maps = locs(index).filter((u) => /\.xml(\?|$)/i.test(u));
    let urls = [];
    if (!maps.length) urls = locs(index); // a plain sitemap, not an index
    else {
      maps = maps.filter((u) => u.toLowerCase().includes(P.sitemapMatch.toLowerCase()));
      for (const m of maps) urls.push(...locs(await get(m)));
    }
    urls = [...new Set([...urls, ...(P.include || [])])]
      .filter((u) => !(P.exclude || []).some((x) => u.includes(x)))
      .slice(0, P.maxPages || 400);
    if (!urls.length) throw new Error(`No URLs found in sitemaps matching "${P.sitemapMatch}"`);
    writeJson('products-list.json', { t: new Date().toISOString(), source: maps, urls });
    return { urls, error: null };
  } catch (e) {
    const cached = readJson('products-list.json', { urls: [] });
    return { urls: cached.urls, error: `Sitemap read failed (${e.message}); using last saved list of ${cached.urls.length} pages` };
  }
}

export function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  console.log(md);
}
