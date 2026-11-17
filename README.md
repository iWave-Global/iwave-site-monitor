# iWave Global – Website Monitor

Free, automatic monitoring for iwave-global.com, with a live dashboard.

| What | How often | What gets recorded |
|---|---|---|
| Homepage uptime + speed | Every hour | HTTP status, DNS / connect / SSL / server response (TTFB) / total time, page size, cache HIT/MISS |
| Homepage Google PageSpeed (mobile + desktop) | Every hour | Score, LCP, FCP, TBT, CLS, server time |
| **All product pages** (200+), found automatically from the sitemap | Every hour | Server response time, HTTP status, cache, errors (404, 504…) for every product page |
| Product page PageSpeed (mobile) | 8 pages per hour, rotating | Every product page gets a PageSpeed score about once a day |
| Downtime | Every hour | Start, end, duration, and the cause in plain English (timeout, 504, SSL, DNS, firewall block, blank page…) |
| Forms: homepage floating contact form, product page contact form, product document download form | Every 4 hours | Real test submission → Working / Warning / Broken, what's wrong, screenshot when something fails |

**Cost: ₹0.** Checks run on GitHub Actions and the dashboard is hosted on GitHub Pages. Both are free for a public repository.

---

## One-time setup (about 15 minutes, no coding)

### 1. Create the repository
1. Sign in at https://github.com. If the company doesn't have an account, create a free one.
2. Click **+ → New repository**. Name it `iwave-site-monitor` and choose **Public** (GitHub Pages is free only for public repos; the repo holds only speed data and page URLs, never passwords).
3. Click **uploading an existing file**, drag in **everything inside this folder** (including the hidden `.github` folder; on Mac press `Cmd+Shift+.` to show it), then click **Commit changes**.
   - If drag-and-drop skips `.github`, create the two files by hand: **Add file → Create new file**, name it `.github/workflows/speed-check.yml`, paste in the content, and do the same for `form-check.yml`.

### 2. Allow the checks to save results
**Settings → Actions → General → Workflow permissions →** select **Read and write permissions → Save**.

### 3. Turn on the dashboard
**Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/docs` → Save.**
After a minute your dashboard is live at:
`https://<your-github-username>.github.io/iwave-site-monitor/`

### 4. (Recommended) Free PageSpeed API key
Without a key, Google sometimes rate-limits PageSpeed tests.
1. Go to https://developers.google.com/speed/docs/insights/v5/get-started and click **Get a Key**.
2. In the repo, open **Settings → Secrets and variables → Actions → New repository secret**. Set the name to `PSI_API_KEY` and paste the key as the value.

### 5. Forms: nothing to set up (adjust only if a check can't find a form)
The three forms are found automatically:
- **Homepage floating contact form:** the monitor clicks the floating contact button (fixed on screen, ignoring WhatsApp / back-to-top buttons) and fills in the popup form.
- **Product page contact form:** uses the first product page in the sitemap and fills in its contact form.
- **Product document download form:** on the same product page, it clicks the *Download / Datasheet / Brochure* button and fills in the form that appears, then confirms the thank-you message or the file download.

Test details used: name and every other text field `test`, email `test@gmail.com`, phone `1234568`, message `test` (change under `testData` in `config.json`).

If a check reports "button not found" or picks the wrong form, open `config.json` (✏️ pencil) and:
- set `"url"` to a fixed product page instead of `"auto:product"`;
- set `"open"` to the button's CSS selector, for example `"#elementor-popup-btn"` or `"text=Download Datasheet"`;
- set `"formSelector"` to the form, for example `".elementor-form"`.

### 6. Run it for the first time
**Actions → Hourly speed & uptime check → Run workflow**, then do the same for **4-hourly contact form check**.
After each run finishes (green ✓), refresh the dashboard. From then on everything runs by itself.

---

## Using the dashboard
- **Run speed check now / Run form check now** buttons open GitHub's *Run workflow* page for an on-demand test.
- **Time range:** 24 h / 7 d / 30 d / 90 d. All times are shown in IST.
- **Downtime & issue log:** every outage with its cause. Tick the box to also see slow responses (over 3 s) and brief failures that recovered on retry.
- **Download CSV** on every table, ready for Excel or reports.
- **Edit pages & forms** opens `config.json` for editing.

## Email alerts (free)
When the site goes down or a form breaks, that workflow run is marked **failed**, and GitHub emails the repository owner. Make sure **GitHub → Settings → Notifications → Actions → "Send notifications for failed workflows only"** is ticked (email).

## How the form check works
`"mode": "submit"` (current setting): opens the page in a real Chrome browser, checks that the form, fields, Submit button and reCAPTCHA load, fills in the test details, submits, and waits up to 30 s for the thank-you message, a file download, or a thank-you page. If it fails, the log shows the form's own error message (for example "invalid phone number" or a reCAPTCHA rejection), whether the request reached the server, and a screenshot.
- **Expect about 18 test entries a day** (3 forms × 6 checks) in the sales inbox / CRM. Filter them out by the email `test@gmail.com` or the name `test`.
- A failed submission that reached the server is **not** retried, so you never get duplicate test entries.
- If reCAPTCHA starts rejecting the automated entries, switch that form to `"mode": "check"`. That mode presses Submit with empty fields, so nothing is sent, but it still proves the form and its server handler respond.

## Let test entries through reCAPTCHA (needed for full end-to-end form tests)
Your forms use Contact Form 7 with reCAPTCHA v3, which marks entries from an automated browser as spam. The test then shows **Warning: blocked as spam**: the form, fields and server all work, but no email is sent. To test all the way to the inbox:

1. Pick a long random secret (or use the one Claude gave you).
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**, name `MONITOR_KEY`, value = the secret.
3. On the website, add this snippet using the **Code Snippets** plugin (Snippets → Add New → PHP, "Run everywhere"), or in the child theme's `functions.php`, with the same secret:

```php
// iWave website monitor: let automated form tests past reCAPTCHA, only when they carry the secret key.
add_filter( 'wpcf7_spam', function ( $spam ) {
    $key = 'PASTE-THE-SAME-SECRET-HERE';
    if ( $spam && ! empty( $_SERVER['HTTP_X_MONITOR_KEY'] ) && hash_equals( $key, $_SERVER['HTTP_X_MONITOR_KEY'] ) ) {
        return false;
    }
    return $spam;
}, 99 );
```

The monitor sends the secret only to iwave-global.com, in a hidden header, never to Google or other sites. Without the exact secret, reCAPTCHA keeps working as normal for everyone else.

## Things to know
- **Check timing:** GitHub starts scheduled runs at :07 every hour, sometimes 5–15 minutes late at busy times. Downtime is measured to the nearest hourly check, so a 10-minute blip between checks may be missed. For minute-level downtime alerts, add a free UptimeRobot monitor alongside this.
- **Failures are confirmed:** a failed page or form is re-tested once (after 20 s for pages, immediately for forms) before it counts as down. Failures that pass on retry are logged as *Brief failure*.
- **Sucuri firewall:** if every check shows **403 Forbidden** while the site works in your browser, Sucuri is blocking GitHub's servers. Ask Sucuri support (or the account owner) to allow requests whose user-agent contains `iWaveSiteMonitor`. GitHub's server IPs change, so IP whitelisting doesn't work well here.
- **Inactive repos:** GitHub may pause scheduled workflows in a public repo after 60 days without activity. The hourly data commits normally keep it active, and GitHub emails a warning first. If checks ever stop, open **Actions** and click **Enable workflow**.
- **Product pages:** the list is re-read from `sitemap_index.xml` (sitemaps with "product" in the name) every hour, so new products are picked up automatically. They're checked 4 at a time. The check downloads only each page's HTML, so it adds very little load on the server (about 200 page requests per hour). If the whole site is down, product errors are not logged separately; the homepage outage covers them.
- **History:** 90 days for homepage and product summary data; 7 days of per-product hourly detail (change `historyHours`). Form checks keep the last 540 runs (about 90 days).

## Files
```
config.json                  pages, thresholds, forms (the only file you normally edit)
.github/workflows/           the two schedules (hourly, every 4 hours)
scripts/speed-check.mjs      homepage + all product pages: uptime, speed, PageSpeed, downtime log
scripts/form-check.mjs       browser-based form checks
docs/index.html              the dashboard
docs/data/                   recorded results (written by the checks)
```
