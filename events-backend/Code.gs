/**
 * iWave events dashboard — shared data service (Google Apps Script)
 *
 * Stores Events, Travel and Leads in this Google Sheet and serves them to the
 * dashboard page on GitHub Pages.
 *   - Anyone with the dashboard link can READ, ADD and EDIT.
 *   - Only the owner (whoever knows ADMIN_KEY) can DELETE or REPLACE ALL data.
 *
 * Setup: see SETUP.md next to this file. The only line you must change is ADMIN_KEY.
 */

// >>> CHANGE THIS to your own secret owner password (keep it private) <<<
const ADMIN_KEY = 'CHANGE-ME';

const FIELDS = {
  events: ['name','month','dates','start','end','region','category','attendees','leads','contacts',
           'reg','setup','mkt','logistics','travelCost','booth','rev3','rev6','rev12','feedback','notes'],
  travel: ['person','event','destination','depart','ret','status','flight','hotel','visa','cost','notes','month'],
  leads:  ['company','contact','email','phone','event','interest','owner','stage','value','date','followup','notes']
};
const META = ['id','addedBy','createdAt','updatedAt'];
const ARRAY_FIELDS = { events: ['attendees'] };
const MAX_ROWS_PER_CALL = 2000;
const MAX_TEXT = 5000;

function doGet(e) {
  try {
    return json_({ ok: true, data: readEverything_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request' }); }

  const action = body.action;
  const isOwner = ADMIN_KEY !== 'CHANGE-ME' && body.key === ADMIN_KEY;

  if (action === 'check') return json_({ ok: true, owner: isOwner });

  const coll = body.coll;
  if (!FIELDS[coll]) return json_({ ok: false, error: 'Unknown list' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (action === 'upsert') {
      const rows = clean_(coll, body.rows);
      upsert_(coll, rows, String(body.by || '').slice(0, 80));
    } else if (action === 'delete') {
      if (!isOwner) return json_({ ok: false, error: 'Only the owner can delete.' });
      deleteRow_(coll, String(body.id || ''));
    } else if (action === 'replace') {
      if (!isOwner) return json_({ ok: false, error: 'Only the owner can replace all data.' });
      const rows = clean_(coll, body.rows);
      clearRows_(coll);
      upsert_(coll, rows, String(body.by || '').slice(0, 80));
    } else {
      return json_({ ok: false, error: 'Unknown action' });
    }
    SpreadsheetApp.flush();
    return json_({ ok: true, data: readEverything_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function clean_(coll, rows) {
  if (!Array.isArray(rows)) throw new Error('No rows sent');
  if (rows.length > MAX_ROWS_PER_CALL) throw new Error('Too many rows in one go (max ' + MAX_ROWS_PER_CALL + ')');
  const allowed = FIELDS[coll];
  return rows.map(function (r) {
    const o = {};
    if (r && r.id) o.id = String(r.id).slice(0, 120);
    allowed.forEach(function (k) {
      if (r && r[k] !== undefined && r[k] !== null) {
        let v = r[k];
        if (Array.isArray(v)) v = v.map(String).join(', ');
        if (typeof v === 'string') v = v.slice(0, MAX_TEXT);
        o[k] = v;
      }
    });
    if (r && r._replace) o._replace = true;
    return o;
  });
}

function sheetFor_(coll) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(coll);
  if (!sh) {
    sh = ss.insertSheet(coll);
    const head = META.concat(FIELDS[coll]);
    ensureSize_(sh, 2, head.length);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureSize_(sh, rows, cols) {
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
}

function headers_(sh) {
  const lc = sh.getLastColumn();
  return lc ? sh.getRange(1, 1, 1, lc).getValues()[0].map(String) : [];
}

function readAll_(coll) {
  const sh = sheetFor_(coll);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0].map(String);
  const tz = Session.getScriptTimeZone();
  const arr = ARRAY_FIELDS[coll] || [];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r[0] === '' || r[0] === null) continue;
    const o = {};
    head.forEach(function (k, j) {
      let v = r[j];
      if (v === '' || v === null || v === undefined || !k) return;
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      if (arr.indexOf(k) >= 0) v = String(v).split(',').map(function (s) { return s.trim(); }).filter(String);
      o[k] = v;
    });
    o.id = String(o.id);
    out.push(o);
  }
  return out;
}

function readEverything_() {
  return { events: readAll_('events'), travel: readAll_('travel'), leads: readAll_('leads'), time: new Date().toISOString() };
}

function upsert_(coll, rows, by) {
  if (!rows.length) return;
  const sh = sheetFor_(coll);
  let head = headers_(sh);
  const missing = META.concat(FIELDS[coll]).filter(function (k) { return head.indexOf(k) < 0; });
  if (missing.length) {
    ensureSize_(sh, 2, head.length + missing.length);
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    head = head.concat(missing);
  }
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const now = new Date().toISOString();
  const protectedKeys = ['id', 'addedBy', 'createdAt', 'updatedAt'];
  const appends = [];

  rows.forEach(function (r) {
    const id = r.id || Utilities.getUuid().slice(0, 8);
    const idx = ids.indexOf(String(id));
    if (idx >= 0) {
      const rowN = idx + 2;
      const cur = sh.getRange(rowN, 1, 1, head.length).getValues()[0];
      head.forEach(function (k, j) {
        if (protectedKeys.indexOf(k) >= 0) return;
        if (r[k] !== undefined) cur[j] = r[k];
        else if (r._replace && FIELDS[coll].indexOf(k) >= 0) cur[j] = '';
      });
      cur[head.indexOf('updatedAt')] = now;
      sh.getRange(rowN, 1, 1, head.length).setNumberFormat('@').setValues([cur]);
    } else {
      const rec = Object.assign({}, r, { id: String(id), addedBy: by, createdAt: now, updatedAt: now });
      appends.push(head.map(function (k) { return rec[k] === undefined ? '' : rec[k]; }));
      ids.push(String(id));
    }
  });

  if (appends.length) {
    const start = sh.getLastRow() + 1;
    ensureSize_(sh, start + appends.length - 1, head.length);
    sh.getRange(start, 1, appends.length, head.length).setNumberFormat('@').setValues(appends);
  }
}

function deleteRow_(coll, id) {
  const sh = sheetFor_(coll);
  const last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
  const idx = ids.indexOf(id);
  if (idx < 0) return;
  if (sh.getMaxRows() <= last) sh.insertRowsAfter(last, 1); // a sheet must keep one non-frozen row
  sh.deleteRow(idx + 2);
}

function clearRows_(coll) {
  const sh = sheetFor_(coll);
  const last = sh.getLastRow();
  if (last < 2) return;
  if (sh.getMaxRows() <= last) sh.insertRowsAfter(last, 1);
  sh.deleteRows(2, last - 1);
}
