/**
 * Channel Command Center — Google Sheet backend
 * =========================================
 * Tabs:
 *   Activities      everything you do — one row per activity (kind is derived from type)
 *   Opportunities   lean customer/deal records that activities link to
 *   Availability    one row per date, one column per 30-minute slot
 *   Partners        partner + distributor master list
 *   Layout          which dashboard panels you show, and in what order
 *   Log             audit trail of writes
 *
 * SECURITY
 *   Every read and every write needs the access token, sent in the POST body.
 *   doGet returns nothing useful, so the URL alone reveals no data.
 *
 * Setup: run setup() once, then Deploy > New deployment > Web app
 *        (Execute as Me, Who has access Anyone). See SETUP.md.
 */

var SH_ACT = 'Activities';
var SH_OPP = 'Opportunities';
var SH_AV  = 'Availability';
var SH_PTR = 'Partners';
var SH_LAY = 'Layout';
var SH_LST = 'Lists';
var SH_LOG = 'Log';

/* Bumped whenever the backend gains features the page relies on. The site
   compares this against what it expects and warns you if the deployment is
   stale — the most common upgrade mistake is editing Code.gs but forgetting
   Deploy > Manage deployments > New version. */
var BACKEND_VERSION = 24;

var ACT_COLS = ['id','date','startTime','endTime','kind','type','level','title','oppId','customer',
                'partner','partnerType','zone','location','veeamStakeholder','se','audience','partnerTier',
                'mode','category','product','link','regs','attendees','uniquePartners','stage','nextAction',
                'followUpDate','status','duration','remarks','outcome','source','updatedAt'];

/* Stops at Partner PreSales Contact, plus Stage. Product, Next Action and
   Follow-up are NOT stored here — the site reads them from the latest activity. */
var OPP_COLS = ['id','name','customer','industry','industryRaw','location','zone','veeamStakeholder',
                'contactPerson','contactNumber','contactEmail','partner','partnerSales','partnerPreSales',
                'partnerPreSalesContact','stage','updatedAt'];

var PTR_COLS = ['key','name','type','tier','owner','zone','sources','notes','updatedAt'];
var LAY_COLS = ['panel','title','on'];
var LST_COLS = ['list','value','order','active'];

/* Keep in step with config.js (dayStart / dayEnd / slotMinutes). */
var DAY_START = '09:00';
var DAY_END   = '18:00';
var SLOT_MIN  = 30;

/* Which types count as which kind — mirrors core.js. */
var ENABLEMENT = ['Training','Webinar','Session','PRT','CRT','Bootcamp','Event','Workshop','Conference'];
var INTERNAL   = ['Internal Sync'];

/* Types you invent on the form are recorded in the Lists tab under
   typeEnablement / typeInternal, so this must consult the Sheet as well as the
   built-ins. Cached per execution: kindOf runs once per row on a full import,
   and re-reading the Lists tab 162 times would be slow for no reason. */
var _KIND_CACHE = null;
function kindLists() {
  if (_KIND_CACHE) return _KIND_CACHE;
  var l = {};
  try { l = readLists() || {}; } catch (e) { l = {}; }
  _KIND_CACHE = { en: l.typeEnablement || [], internal: l.typeInternal || [] };
  return _KIND_CACHE;
}
function clearKindCache() { _KIND_CACHE = null; }
function kindOf(type) {
  var t = String(type == null ? '' : type).trim(), k = kindLists();
  if (k.en.indexOf(t) > -1) return 'Enablement';
  if (k.internal.indexOf(t) > -1) return 'Internal';
  if (ENABLEMENT.indexOf(t) > -1) return 'Enablement';
  if (INTERNAL.indexOf(t) > -1) return 'Internal';
  return 'Deal support';
}

/* ============================ ENTRY POINTS ============================ */

function doGet() {
  return json({ ok: false, error: 'This site is private. Open it and enter your access token.' });
}

/* Actions that change the Sheet. Two of these must never run at the same
   moment: both compute "the next empty row" and would fight over it. */
var WRITES = { saveActivity:1, deleteActivity:1, saveOpportunity:1, deleteOpportunity:1,
               savePartner:1, deletePartner:1, saveAvailability:1, saveLayout:1,
               saveLists:1, renameValue:1, importAll:1, importPart:1,
               bulkSave:1, bulkDelete:1, syncOutlook:1, outlookPush:1 };

function doPost(e) {
  var lock = null;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var authErr = tokenProblem(body.token);
    if (authErr) return json({ ok: false, error: authErr, needsSetup: !storedToken() });
    var p = body.payload || {};

    /* Take the document lock before touching anything. Without this, the page
       saving an activity and its opportunity at the same time produced
       "Service Spreadsheets failed while accessing document" at random — it
       looked like the Sheet was broken, but it was two of our own writes
       colliding. 30s is generous; a write takes well under a second. */
    if (WRITES[body.action]) {
      lock = LockService.getDocumentLock();
      if (!lock.tryLock(30000)) {
        return json({ ok: false, busy: true,
          error: 'The Sheet was busy with another save and did not free up in 30 seconds. ' +
                 'Nothing was written — press Save again.' });
      }
    }

    switch (body.action) {

      case 'ping':
        return json({ ok: true, counts: counts(), backend: BACKEND_VERSION, outlook: hasOutlook() });

      case 'bootstrap':
        return json({ ok: true, updated: new Date().toISOString(), counts: counts(),
                      backend: BACKEND_VERSION, hasOutlook: hasOutlook(),
                      activities: readActivities(), opportunities: readOpportunities(),
                      availability: readAvailability(), partners: readPartners(),
                      layout: readLayout(), lists: readLists(),
                      outlook: safeOutlook(), outlookStatus: safeOutlookStatus() });

      case 'saveActivity':      upsert(SH_ACT, ACT_COLS, p); log('saveActivity', p.id);      return json({ ok: true, id: p.id });
      case 'deleteActivity':    deleteById(SH_ACT, p.id); log('deleteActivity', p.id);        return json({ ok: true });

      case 'saveOpportunity':   upsert(SH_OPP, OPP_COLS, p); log('saveOpportunity', p.id);    return json({ ok: true, id: p.id });
      case 'deleteOpportunity': deleteById(SH_OPP, p.id); unlinkActivities(p.id);
                                log('deleteOpportunity', p.id);                               return json({ ok: true });

      case 'savePartner':       upsert(SH_PTR, PTR_COLS, p, 'key'); log('savePartner', p.key); return json({ ok: true });
      case 'deletePartner':     deleteById(SH_PTR, p.key); log('deletePartner', p.key);       return json({ ok: true });

      case 'saveAvailability':  saveAvailability(p.days || []);
                                log('saveAvailability', (p.days || []).length + ' days');
                                return json({ ok: true, saved: (p.days || []).length });

      case 'saveLayout':        saveLayout(p.layout || []); log('saveLayout', (p.layout || []).length + ' panels');
                                return json({ ok: true });

      /* dropdown lists */
      case 'saveLists':         saveLists(p.lists || {}); log('saveLists', Object.keys(p.lists || {}).join(','));
                                return json({ ok: true, lists: readLists() });
      case 'renameValue':       var hit = renameValue(p.list, p.from, p.to);
                                log('renameValue', p.list + ': ' + p.from + ' -> ' + p.to + ' (' + hit + ' records)');
                                return json({ ok: true, changed: hit, lists: readLists() });

      case 'importAll':         importAll(p); log('importAll', JSON.stringify(counts()));
                                return json({ ok: true, counts: counts() });

      /* Chunked import — one entity per request. Smaller payloads, and if
         something goes wrong you find out which part rather than "it failed". */
      case 'importPart':        var ip = importPart(p.part, p.records || [], p.wipe !== false);
                                log('importPart', p.part + ' × ' + ip);
                                return json({ ok: true, part: p.part, written: ip, counts: counts() });

      /* bulk edit — many records in one round trip */
      case 'bulkSave':          var bs = bulkSave(p.kind, p.records || []);
                                log('bulkSave', p.kind + ' × ' + bs);
                                return json({ ok: true, saved: bs });
      case 'bulkDelete':        var bd = bulkDelete(p.kind, p.ids || []);
                                log('bulkDelete', p.kind + ' × ' + bd);
                                return json({ ok: true, deleted: bd });

      /* Outlook — optional. Needs the Outlook.gs file to be present. */
      case 'syncOutlook':
        if (!hasOutlook()) return json({ ok: false, error: outlookMissingMsg() });
        var n = syncOutlookNow(); log('syncOutlook', n + ' blocks');
        return json({ ok: true, outlook: safeOutlook(), outlookStatus: safeOutlookStatus() });
      case 'outlookPush':
        if (!hasOutlook()) return json({ ok: false, error: outlookMissingMsg() });
        var m = outlookPush(p); log('outlookPush', m + ' blocks');
        return json({ ok: true, written: m });

      default:
        return json({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) {} }
  }
}

/* ================================ SETUP ================================ */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(ss, SH_ACT, ACT_COLS);
  ensureSheet(ss, SH_OPP, OPP_COLS);
  ensureSheet(ss, SH_AV,  availCols());
  ensureSheet(ss, SH_PTR, PTR_COLS);
  ensureSheet(ss, SH_LAY, LAY_COLS);
  ensureSheet(ss, SH_LST, LST_COLS);
  if (hasOutlook()) { try { ensureSheet(ss, SH_OUT, OUT_COLS); } catch (e) {} }
  ensureSheet(ss, SH_LOG, ['when','action','detail']);

  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty('ACCESS_TOKEN');
  if (!tok) {
    tok = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    props.setProperty('ACCESS_TOKEN', tok);
  }
  applyColours();
  var msg = 'Setup complete. Seven tabs created.\n\n' +
            'YOUR ACCESS TOKEN:\n\n    ' + tok + '\n\n' +
            'This unlocks the site and authorises every change.\n' +
            'Anyone who has it can see your pipeline. Treat it like a password.\n\n' +
            'Next:  Deploy > New deployment > Web app\n' +
            '       Execute as: Me     Who has access: Anyone\n' +
            'Then paste the /exec URL into config.js as apiUrl.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return tok;
}
function showToken() {
  var t = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN') || '(not set — run setup)';
  Logger.log(t);
  try { SpreadsheetApp.getUi().alert('Access token:\n\n    ' + t); } catch (e) {}
  return t;
}
function rotateToken() {
  var t = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  PropertiesService.getScriptProperties().setProperty('ACCESS_TOKEN', t);
  Logger.log('New token: ' + t);
  try { SpreadsheetApp.getUi().alert('New access token:\n\n    ' + t +
    '\n\nAnyone using the old one is now locked out.'); } catch (e) {}
  return t;
}
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Command Center')
      .addItem('Show access token', 'showToken')
      .addItem('Re-run setup', 'setup')
      .addItem('Apply colours', 'applyColours')
      .addItem('Recalculate kind from type', 'recalcKinds')
      .addItem('Rebuild partner list from data', 'rebuildPartners')
      .addItem('Rebuild read-only summary', 'activitySummary')
      .addItem('Seed Lists tab from defaults', 'seedListsFromDefaults')
      .addSeparator()
      .addItem('Connect Outlook calendar…', 'connectOutlook')   /* needs Outlook.gs */
      .addItem('Sync Outlook now', 'syncOutlookNow')
      .addItem('Turn ON hourly Outlook sync', 'enableHourlyOutlookSync')
      .addItem('Turn OFF hourly Outlook sync', 'disableHourlyOutlookSync')
      .addItem('Clear Outlook data', 'clearOutlookData')
      .addSeparator()
      .addItem('Rotate access token', 'rotateToken')
      .addToUi();
  } catch (e) {}
}

/* ---------------------------------------------------------------------
   Outlook sync lives in a second script file, Outlook.gs, and is optional.
   These wrappers mean a missing or not-yet-added Outlook.gs degrades to
   "no Outlook data" instead of breaking the whole app on load.
   --------------------------------------------------------------------- */
function hasOutlook() {
  try { return typeof readOutlook === 'function'; } catch (e) { return false; }
}
function outlookMissingMsg() {
  return 'Outlook sync is not installed. In Apps Script add a second script file called ' +
         '"Outlook", paste in Outlook.gs, save, then Deploy > Manage deployments > New version.';
}
function safeOutlook() {
  try { return hasOutlook() ? readOutlook() : []; } catch (e) { return []; }
}
function safeOutlookStatus() {
  try {
    if (!hasOutlook()) return { connected: false, last: '', hourly: false, count: 0,
                                status: 'Outlook sync not installed — see OUTLOOK-SYNC.md.' };
    return outlookStatus();
  } catch (e) {
    return { connected: false, last: '', hourly: false, count: 0, status: 'Outlook check failed: ' + e };
  }
}

/* =============================== HELPERS =============================== */

function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function storedToken() {
  return PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN') || '';
}
/** Tolerates a pasted token with stray spaces or quotes around it. */
function cleanToken(t) {
  return String(t == null ? '' : t).replace(/^[\s"'`]+|[\s"'`]+$/g, '');
}
function checkToken(t) {
  var want = storedToken();
  return !!want && cleanToken(t) === cleanToken(want);
}
/**
 * Returns null when the token is good, otherwise a message that says which of
 * the three situations this actually is — they look identical otherwise.
 */
function tokenProblem(t) {
  var want = storedToken(), got = cleanToken(t);
  if (!want) {
    return 'This Google Sheet has no access token yet, so no token can work. ' +
           'In Apps Script choose the function "setup" and press Run — it will show you the token. ' +
           'If you meant to use a different Sheet, check apiUrl in config.js points at the right one.';
  }
  if (!got) return 'No token was sent. Type it into the box and press Unlock.';
  if (got === cleanToken(want)) return null;
  if (got.length !== cleanToken(want).length) {
    return 'That token does not match this Sheet (you sent ' + got.length + ' characters, this Sheet expects ' +
           cleanToken(want).length + '). Open the Sheet and use Command Center > Show access token. ' +
           'If you have more than one Sheet, make sure apiUrl in config.js points at this one.';
  }
  return 'That token does not match this Sheet. Open the Sheet and use ' +
         'Command Center > Show access token, and copy it exactly.';
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function toMin(hm) { var p = String(hm).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function slotList() {
  var out = [], t = toMin(DAY_START), end = toMin(DAY_END);
  while (t < end) { out.push(pad2(Math.floor(t / 60)) + ':' + pad2(t % 60)); t += SLOT_MIN; }
  return out;
}
function availCols() { return ['date','day','fullDay','travelCity','notes'].concat(slotList()).concat(['updatedAt']); }
function ensureSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  if (cur.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f0f3f6');
    sh.setFrozenRows(1);
  }
  return sh;
}
function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { setup(); sh = ss.getSheetByName(name); }
  return sh;
}
function readTable(name) {
  var sh = sheet(name), lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2) return { headers: sh.getRange(1, 1, 1, lc).getValues()[0], rows: [] };
  var v = sh.getRange(1, 1, lr, lc).getDisplayValues();
  return { headers: v[0], rows: v.slice(1) };
}
function reader(t) {
  var idx = {};
  t.headers.forEach(function (h, i) { idx[h] = i; });
  return function (r) {
    return function (k) {
      if (idx[k] == null) return '';
      var v = r[idx[k]];
      return v == null ? '' : String(v).trim();
    };
  };
}
function asDate(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  var s = String(v).trim(), m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) return m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function asTime(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return pad2(v.getHours()) + ':' + pad2(v.getMinutes());
  var s = String(v).trim(), m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return pad2(+m[1]) + ':' + m[2];
  m = s.match(/^(\d{1,2})(?:[.:](\d{1,2}))?\s*(AM|PM)$/i);
  if (m) {
    var h = +m[1], mi = m[2] ? +m[2] : 0, ap = m[3].toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return pad2(h) + ':' + pad2(mi);
  }
  return '';
}
function asNum(v) {
  if (v === '' || v == null) return '';
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}
function counts() {
  return { activities: Math.max(0, sheet(SH_ACT).getLastRow() - 1),
           opportunities: Math.max(0, sheet(SH_OPP).getLastRow() - 1),
           availability: Math.max(0, sheet(SH_AV).getLastRow() - 1),
           partners: Math.max(0, sheet(SH_PTR).getLastRow() - 1) };
}

/* ================================ READS ================================ */

function readActivities() {
  var t = readTable(SH_ACT), mk = reader(t), out = [];
  t.rows.forEach(function (r) {
    var g = mk(r);
    if (!g('id') && !g('title') && !g('date')) return;
    var o = {};
    ACT_COLS.forEach(function (c) { o[c] = g(c); });
    o.date = asDate(o.date);
    o.startTime = asTime(o.startTime);
    o.endTime = asTime(o.endTime);
    o.regs = asNum(o.regs);
    o.attendees = asNum(o.attendees);
    o.uniquePartners = asNum(o.uniquePartners);
    o.followUpDate = asDate(o.followUpDate);
    o.status = o.status || 'Planned';
    o.kind = kindOf(o.type);          /* never trust a hand-typed kind */
    delete o.updatedAt;
    out.push(o);
  });
  return out;
}
function readOpportunities() {
  var t = readTable(SH_OPP), mk = reader(t), out = [];
  t.rows.forEach(function (r) {
    var g = mk(r);
    if (!g('id') && !g('customer')) return;
    var o = {};
    OPP_COLS.forEach(function (c) { o[c] = g(c); });
    delete o.updatedAt;
    out.push(o);
  });
  return out;
}
function readAvailability() {
  var t = readTable(SH_AV), mk = reader(t), slots = slotList(), out = [];
  t.rows.forEach(function (r) {
    var g = mk(r), date = asDate(g('date'));
    if (!date) return;
    var s = {};
    slots.forEach(function (k) { var v = g(k); if (v) s[k] = v; });
    out.push({ date: date, fullDay: g('fullDay'), travelCity: g('travelCity'), notes: g('notes'), slots: s });
  });
  return out;
}
function readPartners() {
  var t = readTable(SH_PTR), mk = reader(t), out = [];
  t.rows.forEach(function (r) {
    var g = mk(r);
    if (!g('name')) return;
    var o = {};
    PTR_COLS.forEach(function (c) { o[c] = g(c); });
    delete o.updatedAt;
    out.push(o);
  });
  return out;
}
/**
 * Is a Sheet cell a "yes"? People type yes / y / true / 1 / x / on, in any case.
 * Anything else — including blank — is a no.
 */
function truthy(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === 'x' || s === 'on';
}
function readLayout() {
  var t = readTable(SH_LAY), mk = reader(t), out = [];
  t.rows.forEach(function (r) {
    var g = mk(r);
    if (!g('panel')) return;
    out.push({ panel: g('panel'), title: g('title'), on: truthy(g('on')) ? 1 : 0 });
  });
  return out;
}

/**
 * Dropdown lists live in the Sheet so you can change them without touching code.
 * Returns { listName: [values] }. Empty tab means "use the built-in defaults".
 */
function readLists() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SH_LST)) return {};
  var t = readTable(SH_LST), mk = reader(t), rows = [];
  t.rows.forEach(function (r) {
    var g = mk(r);
    if (!g('list') || !g('value')) return;
    if (g('active') !== '' && !truthy(g('active'))) return;
    rows.push({ list: g('list'), value: g('value'), order: Number(g('order')) || 0 });
  });
  rows.sort(function (a, b) { return a.order - b.order; });
  var out = {};
  rows.forEach(function (r) {
    if (!out[r.list]) out[r.list] = [];
    if (out[r.list].indexOf(r.value) === -1) out[r.list].push(r.value);
  });
  return out;
}
function saveLists(lists) {
  clearKindCache();            /* the kind buckets may have just changed */
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ensureSheet(ss, SH_LST, LST_COLS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, LST_COLS.length).clearContent();
  var rows = [];
  Object.keys(lists).forEach(function (name) {
    (lists[name] || []).forEach(function (v, i) {
      if (v === '' || v == null) return;
      rows.push([name, v, i + 1, 'yes']);
    });
  });
  if (rows.length) sh.getRange(2, 1, rows.length, LST_COLS.length).setValues(rows);
}

/** Which column on which tab a list drives. */
var LIST_TARGETS = {
  type:     [[SH_ACT, 'type']],
  cat:      [[SH_ACT, 'category']],
  level:    [[SH_ACT, 'level']],
  mode:     [[SH_ACT, 'mode']],
  status:   [[SH_ACT, 'status']],
  aud:      [[SH_ACT, 'audience']],
  zone:     [[SH_ACT, 'zone'], [SH_OPP, 'zone'], [SH_PTR, 'zone']],
  product:  [[SH_ACT, 'product']],
  stage:    [[SH_OPP, 'stage'], [SH_ACT, 'stage']],
  industry: [[SH_OPP, 'industry']],
  partnerType: [[SH_PTR, 'type']],
  tier:     [[SH_PTR, 'tier']]
};
var COLS_BY_SHEET = {};
COLS_BY_SHEET[SH_ACT] = ACT_COLS;
COLS_BY_SHEET[SH_OPP] = OPP_COLS;
COLS_BY_SHEET[SH_PTR] = PTR_COLS;

/**
 * Renames a value everywhere it is used, so you can converge on a uniform list
 * without hand-editing rows. Audience is multi-value, so it is handled per-item.
 * Returns how many records changed.
 */
function renameValue(list, from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!list || !from || !to || from === to) return 0;
  var targets = LIST_TARGETS[list] || [];
  var changed = 0;
  targets.forEach(function (t) {
    var name = t[0], field = t[1], cols = COLS_BY_SHEET[name];
    if (!cols) return;
    var ci = cols.indexOf(field) + 1;
    if (ci < 1) return;
    var sh = sheet(name), last = sh.getLastRow();
    if (last < 2) return;
    var rng = sh.getRange(2, ci, last - 1, 1);
    var vals = rng.getDisplayValues(), out = [], touched = false;
    for (var i = 0; i < vals.length; i++) {
      var v = String(vals[i][0]);
      var nv = v;
      if (list === 'aud' && v.indexOf(',') > -1) {
        var parts = v.split(',').map(function (x) { return x.trim(); });
        var mapped = parts.map(function (x) { return x === from ? to : x; });
        nv = mapped.filter(function (x, k) { return x && mapped.indexOf(x) === k; }).join(', ');
      } else if (v.trim() === from) {
        nv = to;
      }
      if (nv !== v) { touched = true; changed++; }
      out.push([nv]);
    }
    if (touched) rng.setValues(out);
  });
  /* keep the list itself in step */
  var lists = readLists(), dirty = false;
  if (lists[list]) {
    var idx = lists[list].indexOf(from);
    if (idx > -1) {
      if (lists[list].indexOf(to) > -1) lists[list].splice(idx, 1);   /* merged into an existing value */
      else lists[list][idx] = to;
      dirty = true;
    }
  }
  /* Some lists carry a companion that says how a value behaves — which kind a
     type counts as, whether a stage means closed. Rename there too, or the
     rule silently detaches from the value it belongs to. */
  var COMPANIONS = { type: ['typeEnablement', 'typeInternal'], stage: ['stageClosed'] };
  (COMPANIONS[list] || []).forEach(function (c) {
    if (!lists[c]) return;
    var j = lists[c].indexOf(from);
    if (j < 0) return;
    if (lists[c].indexOf(to) > -1) lists[c].splice(j, 1);
    else lists[c][j] = to;
    dirty = true;
  });
  if (dirty) saveLists(lists);

  if (list === 'type') recalcKinds();     /* kind is derived from type */
  return changed;
}

/* =============================== WRITES =============================== */

function rowFor(cols, obj) {
  var now = new Date().toISOString();
  return cols.map(function (c) {
    if (c === 'updatedAt') return now;
    var v = obj[c];
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
}
function findRow(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var vals = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(id)) return i + 2;
  return -1;
}
function upsert(name, cols, obj, keyField) {
  var kf = keyField || 'id';
  if (!obj || !obj[kf]) throw new Error('Record is missing ' + kf);
  if (name === SH_ACT) obj.kind = kindOf(obj.type);
  var sh = sheet(name), row = findRow(sh, obj[kf]), vals = [rowFor(cols, obj)];
  if (row > 0) sh.getRange(row, 1, 1, cols.length).setValues(vals);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, cols.length).setValues(vals);
}
function deleteById(name, id) {
  var sh = sheet(name), row = findRow(sh, id);
  if (row > 0) sh.deleteRow(row);
}
/** Deleting an opportunity leaves its activities in place, just unlinked. */
/* Which sheet + columns each bulk kind writes to. */
function bulkTarget(kind) {
  if (kind === 'activities')    return { name: SH_ACT, cols: ACT_COLS, key: 'id' };
  if (kind === 'opportunities') return { name: SH_OPP, cols: OPP_COLS, key: 'id' };
  if (kind === 'partners')      return { name: SH_PTR, cols: PTR_COLS, key: 'key' };
  throw new Error('Unknown bulk kind: ' + kind);
}

/**
 * Writes many records at once. Rows already present are updated in place, new ones
 * appended. One pass over the sheet rather than one call per record, so changing
 * 50 rows takes about as long as changing one.
 */
function bulkSave(kind, records) {
  if (!records.length) return 0;
  var t = bulkTarget(kind);
  var sh = sheet(t.name), last = sh.getLastRow();
  var index = {};
  if (last >= 2) {
    var keys = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (var i = 0; i < keys.length; i++) index[String(keys[i][0])] = i + 2;
  }
  var appends = [];
  records.forEach(function (r) {
    if (!r || !r[t.key]) return;
    if (t.name === SH_ACT) r.kind = kindOf(r.type);
    var row = rowFor(t.cols, r);
    var at = index[String(r[t.key])];
    if (at) sh.getRange(at, 1, 1, t.cols.length).setValues([row]);
    else appends.push(row);
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, t.cols.length).setValues(appends);
  return records.length;
}

function bulkDelete(kind, ids) {
  if (!ids.length) return 0;
  var t = bulkTarget(kind);
  var sh = sheet(t.name), last = sh.getLastRow();
  if (last < 2) return 0;
  var want = {};
  ids.forEach(function (i) { want[String(i)] = 1; });
  var keys = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  var n = 0;
  for (var i = keys.length - 1; i >= 0; i--) {
    if (want[String(keys[i][0])]) {
      if (t.name === SH_OPP) unlinkActivities(String(keys[i][0]));
      sh.deleteRow(i + 2); n++;
    }
  }
  return n;
}

function unlinkActivities(oppId) {
  var sh = sheet(SH_ACT), last = sh.getLastRow();
  if (last < 2) return;
  var col = ACT_COLS.indexOf('oppId') + 1;
  var vals = sh.getRange(2, col, last - 1, 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(oppId)) sh.getRange(i + 2, col).setValue('');
  }
}
/**
 * Read-only summary of each opportunity's activity, written to a scratch sheet.
 * Nothing depends on it — the site always counts from the Activities tab — but it
 * is handy if you want to eyeball the Sheet without opening the site.
 */
function activitySummary() {
  var acts = readActivities(), opps = readOpportunities(), by = {};
  acts.forEach(function (a) { if (a.oppId) (by[a.oppId] = by[a.oppId] || []).push(a); });
  var rows = opps.map(function (o) {
    var list = (by[o.id] || []).slice().sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var latest = list[list.length - 1] || {};
    return [o.id, o.customer, o.stage, list.length,
            list.length ? list[0].date : '', list.length ? latest.date : '',
            latest.product || '', latest.nextAction || '', latest.followUpDate || ''];
  });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var head = ['id','customer','stage','activities','firstActivity','lastActivity',
              'product (latest)','nextAction (latest)','followUp (latest)'];
  var sh = ensureSheet(ss, 'Summary (read-only)', head);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  var m = 'Summary rebuilt for ' + rows.length + ' opportunities.';
  Logger.log(m); try { SpreadsheetApp.getUi().alert(m); } catch (e) {}
}
/** Rewrites the kind column from type, in case anyone edited it by hand. */
function recalcKinds() {
  clearKindCache();            /* always recalculate against what is in the Sheet now */
  var sh = sheet(SH_ACT), last = sh.getLastRow();
  if (last < 2) return;
  var kc = ACT_COLS.indexOf('kind') + 1, tc = ACT_COLS.indexOf('type') + 1;
  var types = sh.getRange(2, tc, last - 1, 1).getDisplayValues();
  sh.getRange(2, kc, last - 1, 1).setValues(types.map(function (r) { return [kindOf(String(r[0]).trim())]; }));
  var m = 'Kind recalculated for ' + (last - 1) + ' activities.';
  Logger.log(m); try { SpreadsheetApp.getUi().alert(m); } catch (e) {}
}
function saveAvailability(list) {
  if (!list || !list.length) return;
  var sh = sheet(SH_AV), cols = availCols(), last = sh.getLastRow(), index = {};
  if (last >= 2) {
    var d = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (var i = 0; i < d.length; i++) { var k = asDate(d[i][0]); if (k) index[k] = i + 2; }
  }
  var now = new Date().toISOString(), appends = [];
  list.forEach(function (a) {
    var date = asDate(a.date);
    if (!date) return;
    var dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(date + 'T00:00:00').getDay()];
    var row = cols.map(function (c) {
      if (c === 'date') return date;
      if (c === 'day') return dow;
      if (c === 'fullDay') return a.fullDay || '';
      if (c === 'travelCity') return a.travelCity || '';
      if (c === 'notes') return a.notes || '';
      if (c === 'updatedAt') return now;
      return (a.slots && a.slots[c]) ? a.slots[c] : '';
    });
    if (index[date]) sh.getRange(index[date], 1, 1, cols.length).setValues([row]);
    else appends.push(row);
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, cols.length).setValues(appends);
  sortByCol(sh, 1);
}
function saveLayout(list) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ensureSheet(ss, SH_LAY, LAY_COLS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, LAY_COLS.length).clearContent();
  if (!list.length) return;
  sh.getRange(2, 1, list.length, LAY_COLS.length).setValues(list.map(function (l) {
    return [l.panel, l.title || '', l.on ? 1 : 0];
  }));
}
function sortByCol(sh, c) {
  var last = sh.getLastRow();
  if (last > 2) sh.getRange(2, 1, last - 1, sh.getLastColumn()).sort({ column: c, ascending: true });
}

/**
 * Imports one entity at a time.
 *   part  'activities' | 'opportunities' | 'partners' | 'availability' | 'lists' | 'layout'
 *   wipe  true (default) clears that tab first
 * Returns how many rows were written.
 */
function importPart(part, records, wipe) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (part === 'lists') {
    var obj = records;                       /* an object, not an array */
    if (Array.isArray(obj)) { var m = {}; obj.forEach(function (r) {
      if (!r || !r.list) return; (m[r.list] = m[r.list] || []).push(r.value); }); obj = m; }
    saveLists(obj || {});
    return Object.keys(obj || {}).length;
  }
  if (part === 'layout') { saveLayout(records); return records.length; }

  if (part === 'availability') {
    var cols = availCols();
    var shV = ensureSheet(ss, SH_AV, cols);
    if (wipe && shV.getLastRow() > 1) {
      shV.getRange(2, 1, shV.getLastRow() - 1, cols.length).clearContent();
      if (shV.getLastRow() > 1) shV.deleteRows(2, shV.getLastRow() - 1);
    }
    var av = records.filter(function (a) { return asDate(a.date); });
    if (!av.length) return 0;
    var now = new Date().toISOString();
    /* wipe=false means this is a follow-on batch — append, never overwrite. */
    var atV = wipe ? 2 : Math.max(2, shV.getLastRow() + 1);
    shV.getRange(atV, 1, av.length, cols.length).setValues(av.map(function (a) {
      var date = asDate(a.date);
      var dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(date + 'T00:00:00').getDay()];
      return cols.map(function (c) {
        if (c === 'date') return date;
        if (c === 'day') return dow;
        if (c === 'fullDay') return a.fullDay || '';
        if (c === 'travelCity') return a.travelCity || '';
        if (c === 'notes') return a.notes || '';
        if (c === 'updatedAt') return now;
        return (a.slots && a.slots[c]) ? a.slots[c] : '';
      });
    }));
    sortByCol(shV, 1);
    return av.length;
  }

  var map = { activities: [SH_ACT, ACT_COLS], opportunities: [SH_OPP, OPP_COLS], partners: [SH_PTR, PTR_COLS] };
  var t = map[part];
  if (!t) throw new Error('Unknown import part: ' + part);
  if (part === 'activities') records.forEach(function (a) { a.kind = kindOf(a.type); });
  var sh = ensureSheet(ss, t[0], t[1]);
  if (wipe && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, t[1].length).clearContent();
    /* clearContent leaves blank rows behind, so drop them before appending */
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  }
  if (!records.length) return 0;
  var at = wipe ? 2 : Math.max(2, sh.getLastRow() + 1);
  sh.getRange(at, 1, records.length, t[1].length).setValues(records.map(function (o) { return rowFor(t[1], o); }));
  if (part === 'activities') sortByCol(sh, 2);
  return records.length;
}

function importAll(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  (p.activities || []).forEach(function (a) { a.kind = kindOf(a.type); });
  [[SH_ACT, ACT_COLS, p.activities || []],
   [SH_OPP, OPP_COLS, p.opportunities || []],
   [SH_PTR, PTR_COLS, p.partners || []]].forEach(function (j) {
    var sh = ensureSheet(ss, j[0], j[1]);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, j[1].length).clearContent();
    if (j[2].length) sh.getRange(2, 1, j[2].length, j[1].length).setValues(j[2].map(function (o) { return rowFor(j[1], o); }));
  });

  var cols = availCols();
  var shV = ensureSheet(ss, SH_AV, cols);
  if (shV.getLastRow() > 1) shV.getRange(2, 1, shV.getLastRow() - 1, cols.length).clearContent();
  var av = (p.availability || []).filter(function (a) { return asDate(a.date); });
  if (av.length) {
    var now = new Date().toISOString();
    shV.getRange(2, 1, av.length, cols.length).setValues(av.map(function (a) {
      var date = asDate(a.date);
      var dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(date + 'T00:00:00').getDay()];
      return cols.map(function (c) {
        if (c === 'date') return date;
        if (c === 'day') return dow;
        if (c === 'fullDay') return a.fullDay || '';
        if (c === 'travelCity') return a.travelCity || '';
        if (c === 'notes') return a.notes || '';
        if (c === 'updatedAt') return now;
        return (a.slots && a.slots[c]) ? a.slots[c] : '';
      });
    }));
    sortByCol(shV, 1);
  }
  if (p.layout && p.layout.length) saveLayout(p.layout);
  if (p.lists && Object.keys(p.lists).length) saveLists(p.lists);
  sortByCol(sheet(SH_ACT), 2);
  applyColours();
}

/* ============================ NICE-TO-HAVES ============================ */

function rebuildPartners() {
  var seen = {};
  var add = function (name, type, src) {
    name = String(name || '').trim();
    if (!name || ['Internal','Partner','End Customer'].indexOf(name) > -1) return;
    var k = name.replace(/\s*\((P|D)\)\s*$/i, '')
                .replace(/\b(pvt|private)\.?\s*(ltd|limited)\.?\b/gi, '')
                .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!k) return;
    if (!seen[k]) seen[k] = { key: k, name: name, type: type || 'Partner', zone: '', sources: {}, notes: '' };
    if (name.length > seen[k].name.length) seen[k].name = name;
    if (type === 'Distributor') seen[k].type = 'Distributor';
    seen[k].sources[src] = 1;
  };
  readActivities().forEach(function (a) {
    add(a.partner, a.partnerType === 'Distributor' ? 'Distributor' : 'Partner',
        a.kind === 'Enablement' ? 'enablement' : 'deals');
  });
  readOpportunities().forEach(function (o) { add(o.partner, 'Partner', 'deals'); });

  var list = Object.keys(seen).map(function (k) {
    var e = seen[k];
    e.sources = Object.keys(e.sources).sort().join(',');
    return e;
  }).sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ensureSheet(ss, SH_PTR, PTR_COLS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, PTR_COLS.length).clearContent();
  if (list.length) sh.getRange(2, 1, list.length, PTR_COLS.length).setValues(list.map(function (o) { return rowFor(PTR_COLS, o); }));
  var m = 'Partner list rebuilt: ' + list.length + ' organisations.';
  Logger.log(m); try { SpreadsheetApp.getUi().alert(m); } catch (e) {}
}

function applyColours() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var av = ss.getSheetByName(SH_AV);
  if (av && av.getLastRow() > 1) {
    var rng = av.getRange(2, 3, av.getLastRow() - 1, availCols().length - 3);
    av.setConditionalFormatRules([['Free','#cdeed6'],['Busy','#f6cccc'],['Travelling','#fbe3b0'],
                                  ['Holiday','#ccdcfb'],['Personal','#ddd2fb']].map(function (p) {
      return SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo(p[0]).setBackground(p[1]).setRanges([rng]).build();
    }));
    av.setFrozenColumns(2);
  }

  var ac = ss.getSheetByName(SH_ACT);
  if (ac && ac.getLastRow() > 1) {
    var ki = ACT_COLS.indexOf('kind') + 1;
    var kr = ac.getRange(2, ki, ac.getLastRow() - 1, 1);
    ac.setConditionalFormatRules([['Enablement','#cdeed6'],['Deal support','#dbe6fb'],['Internal','#eceff3']].map(function (p) {
      return SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo(p[0]).setBackground(p[1]).setRanges([kr]).build();
    }));
    ac.setFrozenColumns(2);
  }

  var op = ss.getSheetByName(SH_OPP);
  if (op && op.getLastRow() > 1) {
    var si = OPP_COLS.indexOf('stage') + 1;
    var sr = op.getRange(2, si, op.getLastRow() - 1, 1);
    op.setConditionalFormatRules([['Closed-Won','#cdeed6'],['Closed-Lost','#f6cccc'],['Proposal','#fbe3b0'],
      ['Negotiation','#f8d3e6'],['Prove Value','#ddd2fb'],['Feature Validation','#cdeaea'],
      ['Discussion','#d5e8f2'],['Qualification','#dbe6fb'],['Lead','#eceff3']].map(function (p) {
      return SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo(p[0]).setBackground(p[1]).setRanges([sr]).build();
    }));
    op.setFrozenColumns(3);
  }
}

/** Writes the built-in defaults into the Lists tab so you can edit them by hand. */
function seedListsFromDefaults() {
  var d = {
    type: ['Training','Webinar','Session','PRT','CRT','Bootcamp','Event','Workshop','Conference',
           'Call','Meeting','Demo','POC','Design Session','Follow-up','Email','Internal Sync'],
    cat: ['Sales Enablement','Sales Training','Technical Enablement','Technical Training',
          'Technical Refreshment','Technical Bootcamp','Hands-on Technical Training',
          'Sales & Pre-Sales Enablement','Sales & Pre-Sales Refreshment','Partner Round Table',
          'Partner Led Customer Event','Webinar for Partner','Webinar for End Customer',
          'Veeam Led Customer Webinar','Veeam Led Event','Disti Led Event','Third Party Event'],
    level: ['Foundation','Advanced'],
    aud: ['Sales','Pre-Sales','Technical','Partner','End Customer','Distributor'],
    mode: ['Online','In-person','Hybrid'],
    status: ['Proposed','Planned','Confirmed','Completed','Rescheduled','Cancelled'],
    stage: ['Lead','Qualification','Discussion','Feature Validation','Prove Value','Proposal',
            'Negotiation','Closed-Won','Closed-Lost'],
    product: ['VDP','VDP + Vault','VDP + VDC','VDC Vault','VDC M365','VDC Entra ID','VDC M365+Entra ID',
              'VDC Azure','VDC Salesforce','Security AI','Agent Commander'],
    industry: ['Financial Services','Healthcare','Pharma & Life Sciences','Manufacturing','Energy & Resources',
               'Technology & Software','IT Services & Consulting','Education','Government','Real Estate',
               'Transport & Logistics','Retail & E-commerce','Media & Entertainment','Telecom','Other'],
    zone: ['North','South','East','West','PAN India','SAARC'],
    partnerType: ['Partner','Distributor','Alliance','Internal'],
    tier: ['Registered','Silver','Gold','Platinum']
  };
  saveLists(d);
  var n = 0;
  Object.keys(d).forEach(function (k) { n += d[k].length; });
  var m = 'Lists tab seeded: ' + Object.keys(d).length + ' lists, ' + n + ' values.\n\n' +
          'Edit them there or from the site (Data tab > Dropdown lists).';
  Logger.log(m); try { SpreadsheetApp.getUi().alert(m); } catch (e) {}
}

function log(action, detail) {
  try {
    var sh = sheet(SH_LOG);
    sh.appendRow([new Date(), action, detail || '']);
    if (sh.getLastRow() > 3000) sh.deleteRows(2, 1000);
  } catch (e) {}
}
