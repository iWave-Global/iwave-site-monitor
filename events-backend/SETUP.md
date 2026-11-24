# iWave events dashboard: one-time setup for shared data

The dashboard lives at **https://iwave-global.github.io/iwave-site-monitor/events/**.
Its data is kept in a Google Sheet that you own. A small Google Apps Script (`Code.gs`, in this folder) connects the Sheet to the page.

| Who | Can do |
|---|---|
| Anyone with the link | View, search, filter, export, **add** and **edit** events, trips and leads, and import Excel |
| You (owner password) | All of the above, plus **delete** records and **replace all data** on import |

Setup takes about 10 minutes and only needs doing once.

## 1. Create the Google Sheet
1. Go to https://sheets.google.com and create a **Blank spreadsheet**.
2. Name it, for example, `iWave Events Dashboard Data`.
3. Leave it empty. The script creates the `events`, `travel` and `leads` tabs itself.

## 2. Add the script
1. In the Sheet, open **Extensions → Apps Script**.
2. Delete the sample code, then paste in **everything** from `Code.gs` (this folder).
3. On the line `const ADMIN_KEY = 'CHANGE-ME';`, replace `CHANGE-ME` with your own owner password, for example `const ADMIN_KEY = 'iWave#Events!7731';`. Keep it private, because anyone who knows it can delete.
4. Click **Save** (the disk icon).

## 3. Publish it as a web app
1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set **Execute as:** `Me`.
4. Set **Who has access:** `Anyone`. This lets the dashboard page reach it. People still only get the access listed in the table above.
5. Click **Deploy**, then **Authorize access**, choose your Google account and allow it. If Google shows "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. This is your own script.
6. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.

## 4. Connect the dashboard
1. On GitHub, open `docs/events/config.json` and click the pencil icon (**Edit**).
2. Put your URL between the quotes:
   ```json
   { "apiUrl": "https://script.google.com/macros/s/AKfy…/exec" }
   ```
3. Click **Commit changes**. After about 1–2 minutes, the dashboard link becomes a shared, editable dashboard.

## 5. Load your data and sign in as owner
1. Open the dashboard, click **Import Excel** and choose your file (data exported earlier, or the Excel template filled in).
2. Click **Owner login** and enter your `ADMIN_KEY`. The Delete buttons appear for you only. The browser remembers your login until you click **Sign out**.

## Good to know
- **Everyone sees the same data.** The page refreshes every minute and whenever someone switches back to the tab.
- **"Added by".** The first time someone adds or imports, the page asks for their name and saves it with each new record.
- **You can edit the Google Sheet directly.** Changes show on the dashboard at its next refresh. Keep the first row (the column names) and the `id` column as they are.
- **Backups.** Use **Export Excel** on the dashboard, or **File → Download** in the Sheet. Sheets also keeps version history under **File → Version history**.
- **Changed the script later?** Use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same.
- **Privacy.** Anyone who has the dashboard link can read the data. Share the link only with the people who should see it.
