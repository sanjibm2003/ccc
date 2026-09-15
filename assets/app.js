/* =========================================================================
   app.js — shell, tabs, filters, forms.
   Dashboard panels live in panels.js.
   ========================================================================= */
(function () {
'use strict';
var A = window.APP, CFG = A.CFG, S = A.Store, Auth = A.Auth;
var $ = A.$, $$ = A.$$, esc = A.esc, num = A.num, has = A.has;

var curTab = 'dash', calCursor = new Date(), avCursor = new Date();
var editAct = null, editOpp = null, editPtr = null, viewOpp = null, dayEditing = null;
var brush = 'Free', painting = false, dirtyDays = {};
var logView = 'table', pipeView = 'board';
var sortLog = { k: 'date', d: -1 }, sortEv = { k: 'date', d: -1 },
    sortOpp = { k: 'lastTouch', d: -1 }, sortPtr = { k: 'name', d: 1 };
var layout = [], importPayload = null, layoutDirty = false;
var TPL_KEY = 'ccc3_week_template';
var tpl = {}, tplBrush = 'Free';        /* { Mon: { '09:00':'Free', ... }, ... } */

/* ====================================================================== */
/*  GATE                                                                  */
/* ====================================================================== */
/* People paste tokens out of emails and notes; strip stray quotes and spaces. */
function cleanTok(t) { return String(t == null ? '' : t).replace(/^[\s"'`]+|[\s"'`]+$/g, ''); }

function gateMsg(kind, html) {
  var el = $('#gateMsg');
  el.className = 'gatemsg' + (kind ? ' ' + kind : '');
  el.innerHTML = html || '';
}
function unlock(tok, remember) {
  if (!A.apiUrl()) {
    gateMsg('err', 'No Google Sheet configured. Add your Web App URL under <b>Tools &rarr; Connection &amp; token</b>, or as <b>apiUrl</b> in <b>config.js</b>.');
    return;
  }
  if (!tok) { gateMsg('err', 'Enter your access token.'); return; }
  $('#gateGo').disabled = true;
  gateMsg('', '<span class="spin"></span> Checking…');
  S.bootstrap(tok).then(function () {
    Auth.set(tok, remember);
    $('#gate').classList.add('hide');
    $('#app').classList.remove('hide');
    start();
  }).catch(function (e) {
    gateMsg('err', esc(e.message));
    $('#gateTok').select();
  }).then(function () { $('#gateGo').disabled = false; });
}
function lock() { Auth.clear(); location.reload(); }

/* ====================================================================== */
/*  FILTERS                                                               */
/* ====================================================================== */
function periodRange() {
  var p = $('#fPeriod').value, td = A.today();
  if (p === '30') return [A.addDays(td, -30), td];
  if (p === '90') return [A.addDays(td, -90), td];
  if (p === 'next30') return [td, A.addDays(td, 30)];
  if (p === 'q') {
    var m = A.quarterMonths(A.qKey(td));
    var last = new Date(+m[2].slice(0, 4), +m[2].slice(5, 7), 0).getDate();
    return [m[0] + '-01', m[2] + '-' + A.pad(last)];
  }
  return null;
}
function gf() {
  return { q: $('#fQ').value, kind: $('#fKind').value, zone: $('#fZone').value,
           stake: $('#fStake').value, partner: $('#fPartner').value,
           text: $('#fSearch').value.trim().toLowerCase(), range: periodRange() };
}
/* Run a list of request-makers strictly in sequence, stopping at the first
   failure. Written as thunks so nothing starts until its turn. */
function runInOrder(thunks) {
  var out = [];
  return thunks.reduce(function (chain, make) {
    return chain.then(function () {
      return withRetry(make).then(function (r) { out.push(r); });
    });
  }, Promise.resolve()).then(function () { return out; });
}

/* Google occasionally answers a write with a transient "failed while accessing
   document". One quiet retry turns that from a visible error into a non-event. */
function withRetry(make, tries) {
  tries = tries || 2;
  return make().catch(function (e) {
    var transient = /failed while accessing|being edited|try again|busy|timed out|internal error/i
      .test(String(e && e.message));
    if (tries > 1 && transient) {
      return new Promise(function (res) { setTimeout(res, 800); }).then(function () {
        return withRetry(make, tries - 1);
      });
    }
    throw e;
  });
}

/* ====================================================================== */
/*  DRILL — "show me exactly those records"                               */
/* ====================================================================== */
/* Charts and the data-health list can name a precise set of records. A drill
   holds that set by id and is applied on top of whatever filters are set, so
   clicking a bar takes you to the rows behind it rather than to the tab in
   general. One concept serves both. */
var drill = null;      /* { label, what: 'activities'|'opportunities', ids: {} } */

function setDrill(label, what, rows, tab) {
  var ids = {};
  (rows || []).forEach(function (r) { ids[r.id] = 1; });
  drill = { label: label, what: what, ids: ids, n: Object.keys(ids).length };
  if (!drill.n) { drill = null; A.toast('Nothing to show for “' + label + '”'); return; }
  clearSel('log'); clearSel('events'); clearSel('pipe');
  renderDrillBar();
  if (tab) setTab(tab);
  refresh();
}
function clearDrill() {
  drill = null;
  renderDrillBar();
  refresh();
}
function drillAllows(what, id) {
  if (!drill) return true;
  if (drill.what !== what) return true;    /* a drill on activities must not hide opportunities */
  return !!drill.ids[id];
}
function renderDrillBar() {
  var bar = $('#drillBar');
  if (!bar) return;
  bar.classList.toggle('hide', !drill);
  if (!drill) return;
  bar.innerHTML = '<span class="dl">Showing</span> <b>' + esc(drill.label) + '</b>' +
    '<span class="dn">' + drill.n + ' ' +
    (drill.what === 'activities' ? (drill.n === 1 ? 'activity' : 'activities')
                                 : (drill.n === 1 ? 'opportunity' : 'opportunities')) + '</span>' +
    '<button class="btn sm" id="drillClear">Show everything again</button>';
  $('#drillClear').onclick = clearDrill;
}

function matchAct(r) {
  if (!drillAllows('activities', r.id)) return false;
  var f = gf();
  if (f.range && (r.date < f.range[0] || r.date > f.range[1])) return false;
  if (f.q && A.qKey(r.date) !== f.q) return false;
  if (f.kind && r.kind !== f.kind) return false;
  if (f.zone && r.zone !== f.zone) return false;
  if (f.stake && r.veeamStakeholder !== f.stake && r.se !== f.stake) return false;
  if (f.partner && r.partner !== f.partner) return false;
  if (f.text) {
    var blob = [r.title, r.customer, r.partner, r.location, r.remarks, r.outcome, r.type,
                r.category, r.audience, r.veeamStakeholder, r.nextAction, r.zone].join(' ').toLowerCase();
    if (blob.indexOf(f.text) === -1) return false;
  }
  return true;
}
function matchOpp(o) {
  if (!drillAllows('opportunities', o.id)) return false;
  var f = gf();
  if (f.zone && o.zone !== f.zone) return false;
  if (f.stake && o.veeamStakeholder !== f.stake) return false;
  if (f.partner && o.partner !== f.partner && o.distributor !== f.partner) return false;
  if (f.q || f.range) {
    var acts = S.actsFor(o.id);
    if (!acts.some(function (a) { return matchAct(a); })) return false;
  }
  if (f.text) {
    var blob = [o.name, o.customer, o.industry, o.industryRaw, o.location, o.partner, o.distributor,
                o.contactPerson, o.contactEmail, o.product, o.stage, o.nextAction, o.remarks].join(' ').toLowerCase();
    if (blob.indexOf(f.text) === -1) return false;
  }
  return true;
}
function fActs() { return S.activities.filter(matchAct); }
function fOpps() { return S.opportunities.filter(matchOpp); }

function fillSel(el, items, all) {
  if (!el) return;
  var cur = el.value;
  el.innerHTML = (all == null ? '' : '<option value="">' + all + '</option>') +
    items.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
  if (items.indexOf(cur) > -1) el.value = cur;
}

/* ====================================================================== */
/*  COMBO — a dropdown you can also type into                             */
/* ====================================================================== */
/* The form fields used to be <select>, which meant you could only ever pick
   what was already there. They are now <input> wrapped by this, so you can
   type anything. The element keeps its id and is still read with .value, so
   every existing get and set in this file goes on working unchanged.

   Filters are deliberately NOT combos — you can only filter by values that
   exist, so a free-text filter would just return nothing. */
var Combo = (function () {
  var openOne = null;

  function close() {
    if (!openOne) return;
    openOne.wrap.classList.remove('on');
    openOne.hi = -1;
    openOne = null;
  }
  document.addEventListener('mousedown', function (e) {
    if (openOne && !openOne.wrap.contains(e.target)) close();
  });

  /* Case-insensitive exact match, returning the canonical spelling from the
     list. Typing "webinar" should give you "Webinar", not a second entry. */
  function canon(st, v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return '';
    for (var i = 0; i < st.items.length; i++)
      if (String(st.items[i]).toLowerCase() === t.toLowerCase()) return st.items[i];
    return t;
  }
  function known(st, v) {
    var t = String(v == null ? '' : v).trim().toLowerCase();
    return st.items.some(function (x) { return String(x).toLowerCase() === t; });
  }

  function draw(st) {
    var q = String(st.input.value || '').trim().toLowerCase();
    var cur = String(st.input.value || '').trim();
    /* Substring match, but anything starting with what you typed comes first. */
    var hits = st.items.filter(function (v) { return !q || String(v).toLowerCase().indexOf(q) > -1; });
    hits.sort(function (a, b) {
      var A2 = String(a).toLowerCase().indexOf(q) === 0, B2 = String(b).toLowerCase().indexOf(q) === 0;
      return A2 === B2 ? 0 : (A2 ? -1 : 1);
    });
    var html = '';
    if (st.opt.blank != null)
      html += '<div class="cbo-i' + (cur ? '' : ' sel') + '" data-v="">' + esc(st.opt.blank) + '</div>';
    html += hits.map(function (v) {
      var lab = esc(v);
      if (q) {                                   /* show what matched */
        var i = String(v).toLowerCase().indexOf(q);
        lab = esc(String(v).slice(0, i)) + '<b>' + esc(String(v).slice(i, i + q.length)) +
              '</b>' + esc(String(v).slice(i + q.length));
      }
      return '<div class="cbo-i' + (String(v) === cur ? ' sel' : '') + '" data-v="' + esc(v) + '">' + lab + '</div>';
    }).join('');
    if (!hits.length && !q) html += '<div class="cbo-i none">nothing on this list yet</div>';
    /* The whole point: an explicit way to keep what you typed. */
    if (st.opt.allowNew !== false && cur && !known(st, cur))
      html += '<div class="cbo-i new" data-new="1" data-v="' + esc(cur) + '">Add &ldquo;' + esc(cur) + '&rdquo;</div>';
    else if (!hits.length && q)
      html += '<div class="cbo-i none">no match</div>';
    st.pop.innerHTML = html;
    st.rows = $$('.cbo-i', st.pop).filter(function (r) { return !r.classList.contains('none'); });
    st.hi = -1;
  }

  function show(st) {
    if (openOne && openOne !== st) close();
    openOne = st;
    st.wrap.classList.add('on');
    draw(st);
    var sel = $('.cbo-i.sel', st.pop);
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function highlight(st, n) {
    if (!st.rows.length) return;
    st.hi = (n + st.rows.length) % st.rows.length;
    st.rows.forEach(function (r, i) { r.classList.toggle('hi', i === st.hi); });
    st.rows[st.hi].scrollIntoView({ block: 'nearest' });
  }

  /* Take a value. If it is new, hand it to whoever wants to record it. */
  function commit(st, raw, fromList) {
    var v = canon(st, raw);
    st.input.value = v;
    close();
    /* We put focus back on the field after a pick, which would otherwise
       re-open the list and look like the click did nothing. */
    st.quiet = true;
    setTimeout(function () { st.quiet = false; }, 0);
    var isNew = v && !known(st, v);
    if (isNew && st.opt.allowNew !== false && st.opt.onNew) {
      st.opt.onNew(v, st);                       /* may prompt, may save */
    }
    if (fromList !== 'silent' && st.opt.onPick) st.opt.onPick(v, isNew);
    /* Anything wired to the old select's onchange still needs telling. */
    if (st.input.onchange) st.input.onchange({ target: st.input });
  }

  function attach(sel, opt) {
    var input = typeof sel === 'string' ? $(sel) : sel;
    if (!input || input._combo) return input && input._combo;
    opt = opt || {};
    var wrap = document.createElement('div');
    wrap.className = 'cbo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    if (opt.placeholder) input.placeholder = opt.placeholder;

    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'cbo-b'; btn.tabIndex = -1;
    btn.innerHTML = '&#9662;'; btn.setAttribute('aria-label', 'Show the list');
    wrap.appendChild(btn);

    var pop = document.createElement('div');
    pop.className = 'cbo-p';
    wrap.appendChild(pop);

    var st = { input: input, wrap: wrap, pop: pop, items: (opt.items || []).slice(),
               opt: opt, hi: -1, rows: [] };
    input._combo = st;

    btn.onclick = function () { if (openOne === st) close(); else { show(st); input.focus(); } };
    /* Only a focus that the user caused should open the list. Putting focus
       back after a pick must not spring it open again. */
    input.addEventListener('focus', function () { if (!st.quiet) show(st); });
    input.addEventListener('input', function () { show(st); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (openOne !== st) show(st); highlight(st, st.hi + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (openOne !== st) show(st); highlight(st, st.hi - 1); }
      else if (e.key === 'Enter') {
        if (openOne === st && st.hi > -1) { e.preventDefault(); commit(st, st.rows[st.hi].getAttribute('data-v')); }
        else if (openOne === st) { e.preventDefault(); commit(st, input.value); }
      } else if (e.key === 'Escape') { if (openOne === st) { e.stopPropagation(); close(); } }
      else if (e.key === 'Tab') { if (openOne === st) commit(st, input.value); }
    });
    /* Clicking away still keeps what you typed — you should never lose a value
       just because you moved on without pressing Enter. */
    input.addEventListener('blur', function () {
      setTimeout(function () {
        if (openOne === st && st.pop.matches(':hover')) return;   /* mid-click */
        if (input.value !== canon(st, input.value) || (input.value && !known(st, input.value)))
          commit(st, input.value);
      }, 120);
    });
    pop.addEventListener('mousedown', function (e) { e.preventDefault(); });   /* keep focus */
    pop.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.cbo-i') : null;
      if (!row || row.classList.contains('none')) return;
      commit(st, row.getAttribute('data-v'));
      input.focus();
    });
    return st;
  }

  /* Replace the option list. Keeps whatever is currently typed. */
  function set(sel, items, opt) {
    var input = typeof sel === 'string' ? $(sel) : sel;
    if (!input) return;
    var st = input._combo || attach(input, opt || {});
    st.items = (items || []).slice();
    if (opt) Object.keys(opt).forEach(function (k) { if (k !== 'items') st.opt[k] = opt[k]; });
    if (openOne === st) draw(st);
  }

  return { attach: attach, set: set, close: close,
           isOpen: function () { return !!openOne; } };
})();

/* ====================================================================== */
/*  ADDING A VALUE THAT WAS NOT ON THE LIST                               */
/* ====================================================================== */
/* A small "which of these is it?" prompt. Resolves with the chosen key, or
   null if dismissed. Used for the two fields where a wrong guess would put
   numbers in the wrong place on the dashboard. */
function askChoice(title, body, choices) {
  return new Promise(function (resolve) {
    var box = $('#askBox');
    $('#askTitle').innerHTML = title;
    $('#askBody').innerHTML = body;
    $('#askOpts').innerHTML = choices.map(function (c) {
      return '<button type="button" data-k="' + esc(c.key) + '"><b>' + esc(c.label) + '</b>' +
             (c.note ? '<span>' + esc(c.note) + '</span>' : '') + '</button>';
    }).join('');
    var done = function (k) {
      box.classList.remove('open');
      $('#askOpts').innerHTML = '';
      resolve(k);
    };
    $$('#askOpts button').forEach(function (b) { b.onclick = function () { done(b.getAttribute('data-k')); }; });
    $('#askCancel').onclick = function () { done(null); };
    box.classList.add('open');
    var first = $('#askOpts button'); if (first) first.focus();
  });
}

/* Push the current A.L lists up to the Sheet. Only the lists you can edit are
   sent, so nothing derived gets written back as if it were a real list. */
var listSaveTimer = null, listSavePending = false;
function persistLists() {
  listSavePending = true;
  clearTimeout(listSaveTimer);
  /* Debounced: adding three values in a row is one round trip, not three. */
  return new Promise(function (resolve) {
    listSaveTimer = setTimeout(function () {
      var out = {};
      A.EDITABLE_LISTS.forEach(function (r) { out[r[0]] = (A.L[r[0]] || []).slice(); });
      S.api('saveLists', { lists: out }).then(function (j) {
        listSavePending = false;
        if (j && j.lists) S.applyLists(j.lists);
        resolve(true);
      }).catch(function (e) {
        listSavePending = false;
        A.toast('Saved on this page, but could not write it to the Sheet: ' + e.message, 6000);
        resolve(false);
      });
    }, 700);
  });
}

/* Record a brand-new value on a list. Everything routes through here so there
   is exactly one place that decides what happens. */
function addListValue(listKey, value) {
  var v = String(value || '').trim();
  if (!v) return Promise.resolve(false);
  var arr = A.L[listKey] || (A.L[listKey] = []);
  if (arr.some(function (x) { return String(x).toLowerCase() === v.toLowerCase(); }))
    return Promise.resolve(false);

  if (listKey === 'type') {
    return askChoice('Where should &ldquo;' + esc(v) + '&rdquo; count?',
      'Activity types feed the dashboard. Tell me which bucket this one belongs to and ' +
      'the numbers stay right. You can change it later under <b>Lists</b>.',
      [{ key: 'Enablement',   label: 'Enablement',   note: 'Trainings, webinars, workshops, partner events' },
       { key: 'Deal support', label: 'Deal support', note: 'Calls, meetings, demos, POCs — anything tied to a deal' },
       { key: 'Internal',     label: 'Internal',     note: 'Internal syncs and admin — excluded from reach figures' }]
    ).then(function (kind) {
      if (!kind) return false;
      arr.push(v);
      if (kind === 'Enablement') (A.L.typeEnablement = A.L.typeEnablement || []).push(v);
      if (kind === 'Internal')   (A.L.typeInternal   = A.L.typeInternal   || []).push(v);
      return persistLists().then(function () {
        A.toast('Added “' + v + '” as ' + kind);
        refreshLists();
        return true;
      });
    });
  }

  if (listKey === 'stage') {
    return askChoice('Is &ldquo;' + esc(v) + '&rdquo; an open stage or a closed one?',
      'This decides whether the deal still counts as in play on the pipeline and the funnel.',
      [{ key: 'open',   label: 'Still open', note: 'Counts as live pipeline' },
       { key: 'closed', label: 'Closed',     note: 'Deal is finished — won, lost or dropped' }]
    ).then(function (which) {
      if (!which) return false;
      arr.push(v);
      if (which === 'closed') (A.L.stageClosed = A.L.stageClosed || []).push(v);
      return persistLists().then(function () {
        A.toast('Added “' + v + '” as a ' + (which === 'closed' ? 'closed' : 'open') + ' stage');
        refreshLists();
        return true;
      });
    });
  }

  /* Everything else just joins the list. */
  arr.push(v);
  return persistLists().then(function () {
    A.toast('Added “' + v + '” to ' + listLabel(listKey));
    refreshLists();
    return true;
  });
}

function listLabel(key) {
  var r = A.EDITABLE_LISTS.filter(function (x) { return x[0] === key; })[0];
  return r ? r[1].toLowerCase() : key;
}

/* Re-point every combo at the updated lists, without disturbing what is typed. */
function refreshLists() {
  fillForms();
  if (curTab === 'lists') renderLists();
}
function fillKV(el, pairs, all) {
  var cur = el.value;
  el.innerHTML = (all == null ? '' : '<option value="">' + all + '</option>') +
    pairs.map(function (p) { return '<option value="' + esc(p[0]) + '">' + esc(p[1]) + '</option>'; }).join('');
  el.value = cur;
}
function uniqAll(key) {
  var s = {};
  S.activities.forEach(function (r) { if (r[key]) s[r[key]] = 1; });
  S.opportunities.forEach(function (r) { if (r[key]) s[r[key]] = 1; });
  return Object.keys(s).sort(function (a, b) { return a.localeCompare(b); });
}
function buildFilters() {
  fillKV($('#fQ'), S.quarters().map(function (k) { return [k, A.qLabel(k)]; }), 'All quarters');
  fillSel($('#fKind'), A.L.kind, 'All kinds');
  fillSel($('#fZone'), uniqAll('zone'), 'All zones');
  fillSel($('#fStake'), uniqAll('veeamStakeholder'), 'All stakeholders');
  fillSel($('#fPartner'), S.partners.map(function (p) { return p.name; }), 'All partners');

  fillSel($('#lType'), S.uniq('activities', 'type'), 'All types');
  fillSel($('#lStatus'), A.L.status, 'All statuses');
  fillSel($('#lMode'), A.L.mode, 'All modes');
  var en = S.activities.filter(function (r) { return r.kind === 'Enablement'; });
  fillSel($('#eType'), uniqOf(en, 'type'), 'All types');
  fillSel($('#eCat'), uniqOf(en, 'category'), 'All categories');
  fillSel($('#eAud'), uniqOf(en, 'audience'), 'All audiences');
  fillSel($('#eMode'), A.L.mode, 'All modes');
  fillSel($('#eStatus'), A.L.status, 'All statuses');
  fillSel($('#pStage'), A.L.stage.filter(function (s) { return S.opportunities.some(function (o) { return o.stage === s; }); }), 'All stages');
  fillSel($('#pProd'), S.uniq('opportunities', 'product'), 'All products');
  fillSel($('#pInd'), S.uniq('opportunities', 'industry'), 'All industries');

  fillForms();

  var dl = function (id, arr) { var e = $(id); if (e) e.innerHTML = arr.map(function (v) { return '<option value="' + esc(v) + '">'; }).join(''); };
  dl('#dl_city', uniqAll('location'));
  dl('#dl_city2', uniqAll('location'));
  dl('#dl_city3', uniqAll('location'));
  dl('#dl_stake', uniqAll('veeamStakeholder'));
  dl('#dl_cust', S.uniq('opportunities', 'customer'));
  dl('#dl_ptr', S.partners.filter(function (p) { return p.type !== 'Distributor'; }).map(function (p) { return p.name; }));
  dl('#dl_disti', S.partners.filter(function (p) { return p.type === 'Distributor'; }).map(function (p) { return p.name; }));
  dl('#dl_ptrall', S.partners.map(function (p) { return p.name; }).concat(['Internal','Partner','End Customer']));

  $('#cLog').textContent = S.activities.length;
  $('#cEv').textContent = en.length;
  $('#cPipe').textContent = S.opportunities.length;
}
function uniqOf(rows, key) {
  var s = {};
  rows.forEach(function (r) { if (r[key]) s[r[key]] = 1; });
  return Object.keys(s).sort();
}

/* Every form field you can type into. `list` is the list a new value joins;
   leave it out and the field takes free text without recording it anywhere. */
var FORM_COMBOS = [
  ['#a_type',     'type',        null],
  ['#a_status',   'status',      null],
  ['#a_stage',    'stage',       '— leave unchanged —'],
  ['#a_product',  'product',     '—'],
  ['#a_cat',      'cat',         '—'],
  ['#a_mode',     'mode',        null],
  ['#a_zone',     'zone',        '—'],
  ['#a_level',    'level',       '—'],
  ['#o_industry', 'industry',    '—'],
  ['#o_stage',    'stage',       null],
  ['#o_zone',     'zone',        '—'],
  ['#p_type',     'partnerType', null],
  ['#p_tier',     'tier',        '—'],
  ['#p_zone',     'zone',        '—']
];

function fillForms() {
  FORM_COMBOS.forEach(function (c) {
    Combo.set(c[0], A.L[c[1]] || [], {
      blank: c[2],
      allowNew: true,
      onNew: function (v) { addListValue(c[1], v); }
    });
  });

  /* Full-day status stays a fixed set — each value drives a colour and a rule
     (Travelling wants a city, Personal shows as PTO). A custom one would have
     no behaviour attached, so this one is deliberately still a picker. */
  fillSel($('#d_full'), ['Travelling','Holiday','Busy','Free','Personal'], '— slot by slot —');
  fillKV($('#rWhat'), [['Travelling','Travelling (whole days)'],['Holiday','Holiday'],['Personal','Personal'],
                       ['Busy','Busy all day'],['Free','Free all day'],['','Clear']], null);

  /* Target audience is a multi-select, so it gets its own add box. */
  var picked = auds();
  $('#a_aud').innerHTML = A.L.aud.map(function (a) {
    return '<label><input type="checkbox" value="' + esc(a) + '"' +
           (picked.indexOf(a) > -1 ? ' checked' : '') + '> ' + esc(a) + '</label>';
  }).join('') +
    '<span class="addaud"><input id="a_audNew" placeholder="add another…" ' +
    'aria-label="Add a target audience"><button type="button" id="a_audAdd">Add</button></span>';
  var addAud = function () {
    var v = String($('#a_audNew').value || '').trim();
    if (!v) return;
    $('#a_audNew').value = '';
    addListValue('aud', v).then(function (added) {
      if (added) {
        var box = $$('#a_aud input[type=checkbox]').filter(function (c) { return c.value === v; })[0];
        if (box) box.checked = true;
      }
    });
  };
  $('#a_audAdd').onclick = addAud;
  $('#a_audNew').onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addAud(); }
  };
}
function auds() {
  return $$('#a_aud input[type=checkbox]').filter(function (c) { return c.checked; })
    .map(function (c) { return c.value; });
}

/* ====================================================================== */
/*  CUSTOMER / OPPORTUNITY ON THE ACTIVITY FORM                           */
/* ====================================================================== */
/* This one is a combo over records, not over a list of words, so it keeps a
   label-to-id map. #a_opp stays in the DOM as a hidden field holding the id,
   which is what the rest of this file reads. #a_custFree holds a customer
   name when you chose to record the name without creating a deal. */
var oppLabelToId = {};

function oppLabel(o) {
  var c = String(o.customer || '').trim(), n = String(o.name || '').trim();
  return (!n || n === c) ? (c || n || o.id) : c + ' — ' + n;
}

/* The customer field. Typing a customer nobody has heard of offers to start a
   deal for them. Picking a known one narrows the opportunity list below it. */
function fillCustCombo() {
  var names = {};
  S.opportunities.forEach(function (o) { if (o.customer) names[o.customer] = 1; });
  S.activities.forEach(function (a) { if (a.customer) names[a.customer] = 1; });
  Combo.set('#a_customer', Object.keys(names).sort(), {
    allowNew: true,
    onNew: function (v) { newCustomer(v); },
    onPick: function (v, isNew) {
      if (isNew) return;                       /* newCustomer handles it */
      $('#a_custFree').value = v;
      fillOppCombo();                          /* only this customer's deals */
      /* One deal for this customer? Then there is nothing to choose. */
      var mine = S.opportunities.filter(function (o) { return o.customer === v; });
      if (mine.length === 1) setOppPick(mine[0].id);
      else if (!mine.some(function (o) { return o.id === $('#a_opp').value; })) setOppPick('');
      pullContact();
      syncAct();
    }
  });
}

/* Opportunities, narrowed to the customer once you have named one. */
function fillOppCombo() {
  var cust = String($('#a_customer') ? $('#a_customer').value : '').trim();
  var opps = S.opportunities.filter(function (o) { return !cust || o.customer === cust; })
    .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
  oppLabelToId = {};
  var items = opps.map(function (o) {
    /* Once the customer is named, repeating it in every row is just noise. */
    var base = cust ? (String(o.name || '').trim() || o.customer || o.id) : oppLabel(o);
    var lab = base, n = 2;
    while (oppLabelToId[lab]) lab = base + ' (' + (n++) + ')';   /* two deals, same name */
    oppLabelToId[lab] = o.id;
    return lab;
  });
  Combo.set('#a_oppPick', items, {
    blank: '— not linked to an opportunity —',
    allowNew: true,
    onNew: function (v) { newOppNamed(v); },
    onPick: function (v, isNew) {
      if (isNew) return;
      $('#a_opp').value = oppLabelToId[v] || '';
      var o = S.oppMap[$('#a_opp').value];
      if (o && o.customer) { $('#a_customer').value = o.customer; $('#a_custFree').value = o.customer; }
      pullContact();
      syncAct();
    }
  });
}

/* Show the contact the opportunity already holds, without wiping something you
   have just typed by hand. */
function pullContact() {
  var o = S.oppMap[$('#a_opp').value];
  if (!o) return;
  if (!$('#a_contactName').value) $('#a_contactName').value = o.contactPerson || '';
  if (!$('#a_contact').value) $('#a_contact').value = o.contactNumber || '';
  if (!$('#a_email').value) $('#a_email').value = o.contactEmail || '';
  var hint = $('#a_contactHint');
  if (hint) hint.textContent = (o.contactPerson || o.contactNumber || o.contactEmail)
    ? 'From ' + o.customer + '. Change any of them here and the opportunity is updated.'
    : "These three are saved on the customer's opportunity, so they fill themselves in next time.";
}

/* You typed an opportunity name that does not exist yet, for a customer that
   might. Make the deal under whatever customer is named above. */
function newOppNamed(name) {
  var v = String(name || '').trim();
  if (!v) return Promise.resolve(false);
  var cust = String($('#a_customer').value || '').trim();
  if (!cust) {
    A.toast('Put the customer name in first, then name the deal', 5000);
    $('#a_oppPick').value = '';
    $('#a_customer').focus();
    return Promise.resolve(false);
  }
  return createOpp(cust, v).then(function (rec) { return !!rec; });
}

/* Show whichever record the hidden id points at. */
function setOppPick(id) {
  $('#a_opp').value = id || '';
  var o = id ? S.oppMap[id] : null;
  var lab = '';
  if (o) {
    lab = Object.keys(oppLabelToId).filter(function (k) { return oppLabelToId[k] === id; })[0];
    if (lab == null) lab = String($('#a_customer') && $('#a_customer').value || '').trim()
      ? (String(o.name || '').trim() || o.customer || '') : oppLabel(o);
  }
  if ($('#a_oppPick')) $('#a_oppPick').value = lab;
  if (!o) $('#a_custFree').value = $('#a_custFree').value || '';
}

/* Older deal-support rows kept the customer only inside the title, in the form
   "Acme Corp — Meeting". Recover it so opening one of those to edit does not
   demand you retype a name that is sitting right there. */
function customerFromTitle(title, type) {
  var t = String(title || '').trim();
  if (!t) return '';
  var suffix = ' — ' + String(type || '').trim();
  if (type && t.length > suffix.length && t.slice(-suffix.length) === suffix)
    return t.slice(0, -suffix.length).trim();
  var i = t.indexOf(' — ');
  return i > 0 ? t.slice(0, i).trim() : '';
}

/* Who the activity is for. Deal support has its own Customer name field; for
   everything else the customer only exists via a linked opportunity. */
function dealCustomer(kind, o) {
  if (kind === 'Deal support')
    return String($('#a_customer').value || '').trim() || (o ? o.customer : '');
  return o ? o.customer : '';
}

/* Deal support does not ask for a title, so build one that reads properly in
   the log, the calendar and the .ics you send to Outlook. */
function actTitle(kind, o) {
  var typed = String($('#a_title').value || '').trim();
  if (kind !== 'Deal support') return typed;
  var cust = String($('#a_customer').value || '').trim() || (o ? o.customer : '');
  var deal = o ? String(o.name || '').trim() : '';
  var type = String($('#a_type').value || '').trim();
  if (!cust) return typed || type;
  /* "Acme Corp — Demo", or "Acme Corp — Renewal FY27 — Demo" when the deal has
     a name of its own worth showing. */
  return cust + (deal && deal !== cust ? ' — ' + deal : '') + (type ? ' — ' + type : '');
}

/* Make an opportunity from what the form already knows, so you are not
   retyping the zone, city and partner you have just filled in. */
function createOpp(customer, dealName) {
  var rec = A.normOpp({
    id: A.uid('O-'),
    customer: customer,
    name: dealName || customer,
    stage: (A.L.stage && A.L.stage[0]) || 'Lead',
    zone: $('#a_zone').value || '',
    location: $('#a_loc').value || '',
    partner: $('#a_partner').value || '',
    veeamStakeholder: $('#a_stake').value || '',
    contactPerson: $('#a_contactName').value || '',
    contactNumber: $('#a_contact').value || '',
    contactEmail: $('#a_email').value || ''
  });
  return S.api('saveOpportunity', rec).then(function () {
    S.opportunities.push(rec);
    S.reindex();
    $('#a_customer').value = customer;
    $('#a_custFree').value = customer;
    fillCustCombo();
    fillCustCombo();
  fillOppCombo();
    setOppPick(rec.id);
    syncAct();
    A.toast('Opportunity created for ' + customer + ' — add the detail in Pipeline when you have it', 5000);
    return rec;
  }).catch(function (e) {
    /* Do not silently drop what they typed just because the Sheet said no. */
    $('#a_custFree').value = customer;
    $('#a_opp').value = '';
    A.toast('Could not create the opportunity: ' + e.message + ' — the name is still on this activity', 7000);
    return null;
  });
}

/* You typed a customer nobody has heard of. Two sensible things to do. */
/* A customer nobody has heard of. No question asked any more — the opportunity
   is created when you save, by ensureOppForCustomer(). Here we only keep what
   was typed and say what is going to happen. */
function newCustomer(name) {
  var v = String(name || '').trim();
  if (!v) return Promise.resolve(false);
  $('#a_opp').value = '';
  $('#a_custFree').value = v;
  $('#a_customer').value = v;
  $('#a_oppPick').value = '';
  fillOppCombo();
  syncAct();
  var hint = $('#a_custHint');
  if (hint && A.kindOf($('#a_type').value) === 'Deal support')
    hint.textContent = 'New customer — an opportunity will be created for “' + v + '” when you save.';
  return Promise.resolve(true);
}

/* ====================================================================== */
/*  DASHBOARD                                                             */
/* ====================================================================== */
function defaultLayout() {
  return window.PANELS.map(function (p) { return { panel: p.id, title: p.title, on: p.off ? 0 : 1 }; });
}
function normLayout(raw) {
  var byId = {};
  window.PANELS.forEach(function (p) { byId[p.id] = p; });
  var out = [], seen = {};
  (raw || []).forEach(function (l) {
    var id = l.panel || l.id;
    if (!byId[id] || seen[id]) return;
    seen[id] = 1;
    out.push({ panel: id, title: byId[id].title, on: (l.on === 1 || l.on === '1' || l.on === true || l.on === 'TRUE') ? 1 : 0 });
  });
  window.PANELS.forEach(function (p) {
    if (!seen[p.id]) out.push({ panel: p.id, title: p.title, on: p.off ? 0 : 1 });
  });
  return out;
}
function ctx() {
  var acts = fActs(), opps = fOpps();
  var dates = {};
  acts.forEach(function (a) { if (a.date) dates[a.date] = 1; });
  var r = periodRange();
  var avail = S.availability.filter(function (a) { return !r || (a.date >= r[0] && a.date <= r[1]); });
  return { acts: acts, opps: opps, as: A.actStats(acts), os: A.oppStats(opps), avs: A.availStats(avail) };
}
function renderDash() {
  var c = ctx(), byId = {};
  window.PANELS.forEach(function (p) { byId[p.id] = p; });
  A.destroyCharts();
  var grid = $('#pgrid');
  var on = layout.filter(function (l) { return l.on && byId[l.panel]; });
  if (!on.length) {
    grid.innerHTML = '<div class="panel wide"><div class="empty">Every panel is hidden. ' +
      'Click <b>Customise dashboard</b> and switch some back on.</div></div>';
    return;
  }
  grid.innerHTML = on.map(function (l) {
    var p = byId[l.panel];
    return '<div class="panel' + (p.width === 'wide' ? ' wide' : '') + '" draggable="true" data-p="' + p.id + '">' +
      '<div class="phandle"><button class="pmove" data-move="' + p.id + '" title="Drag to reorder">⠿</button>' +
      '<button data-hide="' + p.id + '" title="Hide this panel">×</button></div>' +
      '<div data-body="' + p.id + '"></div></div>';
  }).join('');
  on.forEach(function (l) {
    var host = $('[data-body="' + l.panel + '"]');
    if (!host) return;
    try { byId[l.panel].render(host, c); }
    catch (e) {
      console.error('panel ' + l.panel + ' failed', e);
      host.innerHTML = '<h3>' + esc(byId[l.panel].title) + '</h3><div class="empty">This panel could not render.</div>';
    }
  });
  $$('#pgrid [data-hide]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      layout.forEach(function (l) { if (l.panel === b.dataset.hide) l.on = 0; });
      layoutDirty = true; renderPanelList(); renderDash();
    };
  });
  wireDrag();
  renderPanelList();
}
function wireDrag() {
  var dragId = null;
  $$('#pgrid .panel').forEach(function (el) {
    el.ondragstart = function (e) {
      dragId = el.dataset.p;
      e.dataTransfer.setData('text/plain', dragId);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('drag');
    };
    el.ondragend = function () { el.classList.remove('drag'); $$('#pgrid .panel').forEach(function (x) { x.classList.remove('over'); }); };
    el.ondragover = function (e) { e.preventDefault(); if (el.dataset.p !== dragId) el.classList.add('over'); };
    el.ondragleave = function () { el.classList.remove('over'); };
    el.ondrop = function (e) {
      e.preventDefault();
      el.classList.remove('over');
      var from = e.dataTransfer.getData('text/plain'), to = el.dataset.p;
      if (!from || from === to) return;
      var fi = -1, ti = -1;
      layout.forEach(function (l, i) { if (l.panel === from) fi = i; if (l.panel === to) ti = i; });
      if (fi < 0 || ti < 0) return;
      var moved = layout.splice(fi, 1)[0];
      layout.splice(ti, 0, moved);
      layoutDirty = true;
      renderDash();
    };
  });
}
function renderPanelList() {
  var byId = {};
  window.PANELS.forEach(function (p) { byId[p.id] = p; });
  $('#plist').innerHTML = layout.filter(function (l) { return byId[l.panel]; }).map(function (l) {
    return '<button class="ptog' + (l.on ? ' on' : '') + '" data-tog="' + l.panel + '"><i></i>' + esc(l.title) + '</button>';
  }).join('');
  $$('#plist [data-tog]').forEach(function (b) {
    b.onclick = function () {
      layout.forEach(function (l) { if (l.panel === b.dataset.tog) l.on = l.on ? 0 : 1; });
      layoutDirty = true; renderDash();
    };
  });
  $('#pSave').classList.toggle('p', layoutDirty);
}
function saveLayout() {
  $('#pSave').disabled = true;
  S.api('saveLayout', { layout: layout }).then(function () {
    layoutDirty = false;
    S.layout = layout.slice();
    A.toast('Dashboard layout saved — it will look like this on any device');
    renderPanelList();
  }).catch(function (e) { A.toast('Could not save layout: ' + e.message, 5000); })
    .then(function () { $('#pSave').disabled = false; });
}
window.renderDash = renderDash;
window.setDrill = setDrill;      /* panels.js drills through this */
window.gotoPipeline = function (stage) {
  setTab('pipe');
  $('#pStage').value = stage || '';
  $('#pState').value = 'Open';
  renderPipe();
};

/* ====================================================================== */
/*  DAILY LOG                                                             */
/* ====================================================================== */
function logRows() {
  var t = $('#lType').value, st = $('#lStatus').value, m = $('#lMode').value, lk = $('#lLinked').value;
  return fActs().filter(function (r) {
    if (t && r.type !== t) return false;
    if (st && r.status !== st) return false;
    if (m && r.mode !== m) return false;
    if (lk === 'yes' && !r.oppId) return false;
    if (lk === 'no' && r.oppId) return false;
    return true;
  });
}
var LOG_COLS = [['date','Date'],['time','Time'],['kind','Kind'],['type','Type'],['title','Title'],
  ['customer','Customer'],['partner','Partner / Disti'],['zone','Zone'],['location','City'],
  ['veeamStakeholder','Stakeholder'],['duration','Duration'],['status','Status'],
  ['nextAction','Next action'],['remarks','Notes']];
function renderLog() {
  var rows = logRows();
  $('#lCount').textContent = rows.length + ' of ' + S.activities.length + ' activities';
  $('#ltable').classList.toggle('hide', logView !== 'table');
  $('#lcal').classList.toggle('hide', logView !== 'cal');
  if (logView === 'cal') { renderCal(rows); return; }
  var s = sortLog;
  rows = rows.slice().sort(function (a, b) {
    return String(a[s.k] || '').localeCompare(String(b[s.k] || '')) * s.d;
  });
  $('#tblLog thead').innerHTML = '<tr>' + selHead() + LOG_COLS.map(function (c) {
    return '<th data-k="' + c[0] + '">' + c[1] + (s.k === c[0] ? (s.d > 0 ? ' ▲' : ' ▼') : '') + '</th>';
  }).join('') + '</tr>';
  $('#tblLog tbody').innerHTML = rows.length ? rows.map(function (r) {
    return '<tr data-id="' + r.id + '"' + (sel.log[r.id] ? ' class="selrow"' : '') + '>' +
      selCell('log', r.id) +
      '<td style="white-space:nowrap;font-weight:600">' + A.niceDate(r.date) + '</td>' +
      '<td style="white-space:nowrap">' + esc(r.time || '—') + '</td>' +
      '<td>' + A.kindChip(r.kind) + '</td><td>' + A.typePill(r.type) + '</td>' +
      '<td class="t-title">' + esc(r.title) + '</td><td>' + esc(r.customer) + '</td>' +
      '<td>' + esc(r.partner) + '</td><td>' + esc(r.zone) + '</td><td>' + esc(r.location) + '</td>' +
      '<td>' + esc(r.veeamStakeholder) + '</td><td>' + esc(r.duration || '—') + '</td>' +
      '<td>' + A.statusPill(r.status) + '</td><td style="max-width:170px">' + esc(r.nextAction) + '</td>' +
      '<td style="max-width:190px">' + esc(r.remarks) + '</td></tr>';
  }).join('') : '<tr><td colspan="' + (LOG_COLS.length + 1) + '"><div class="empty">Nothing matches. Click <b>+ Log activity</b>.</div></td></tr>';
  $$('#tblLog th[data-k]').forEach(function (th) {
    th.onclick = function () { var k = th.dataset.k; if (s.k === k) s.d *= -1; else { s.k = k; s.d = 1; } renderLog(); };
  });
  $$('#tblLog tbody tr[data-id]').forEach(function (tr) { tr.onclick = function () { openAct(tr.dataset.id); }; });
  wireRowSelection('log');
  refreshBulkBars();
}
function renderCal(rows) {
  var y = calCursor.getFullYear(), m = calCursor.getMonth();
  $('#mLabel').textContent = A.MONTHS_FULL[m] + ' ' + y;
  var first = new Date(y, m, 1), start = new Date(y, m, 1 - first.getDay());
  var byDate = {};
  rows.forEach(function (r) { if (r.date) (byDate[r.date] = byDate[r.date] || []).push(r); });
  var shade = $('#shadeAvail').checked, td = A.today();
  var html = A.DOW.map(function (d) { return '<div class="dow">' + d + '</div>'; }).join('');
  for (var i = 0; i < 42; i++) {
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    var ds = A.ymd(d), out = d.getMonth() !== m, wknd = d.getDay() === 0 || d.getDay() === 6;
    var acts = (byDate[ds] || []).sort(function (a, b) { return (a.startTime || '99').localeCompare(b.startTime || '99'); });
    var av = S.availMap[ds], tag = '';
    /* A day you are away is a day you are away. When the whole day carries a
       status, that status IS the day — showing meetings underneath it only
       invites you to book over yourself. Everything is still in the log, and
       the hidden items are listed on hover. */
    var whole = shade && av && av.fullDay ? av : null;
    if (shade && av && av.fullDay) {
      var cc = A.AVAIL_COLOR[av.fullDay] || '#8b95a3';
      var lbl = A.fullDayLabel(av).short;
      tag = '<span class="dtag" style="background:' + cc + '1f;color:' + cc + '">' + esc(lbl) + '</span>';
    }
    /* A whole-day status heads the day, and the meetings follow underneath —
       you asked for both: the banner tells you where you are, the list tells
       you what you are doing there. */
    var body = '';
    if (whole) {
      var fdc = A.fullDayLabel(whole);
      var col2 = A.AVAIL_COLOR[whole.fullDay] || '#8b95a3';
      body += '<div class="fullday" style="background:' + col2 + '1f;color:' + col2 +
        ';border-left-color:' + col2 + '" title="' + esc(fdc.title) + '">' + esc(fdc.bare) + '</div>';
    }
    body += acts.map(function (r) {
      var col = A.TYPE_COLOR[r.type] || '#8b95a3';
      return '<button class="ev" data-id="' + r.id + '" style="border-left-color:' + col + ';background:' + col + '18" title="' +
        esc(r.title + ' — ' + r.type) + '">' + (r.startTime ? '<b>' + esc(A.fmt12(r.startTime)) + '</b> ' : '') +
        esc(r.title) + '</button>';
    }).join('') +
    ($('#showOutlook') && $('#showOutlook').checked
      ? S.outlookFor(ds).map(function (o) {
          return '<span class="ev olchip" title="Outlook meeting ' + A.fmt12(o.start) + '–' + A.fmt12(o.end) +
            '"><b>' + esc(A.fmt12(o.start)) + '</b> Outlook</span>';
        }).join('') : '');
    html += '<div class="day' + (out ? ' out' : '') + (wknd && !out ? ' wknd' : '') + (ds === td ? ' today' : '') + '">' +
      '<div class="dnum"><span>' + d.getDate() + '</span>' + tag +
      '<button class="dadd" data-newdate="' + ds + '" title="Log something">+</button></div>' +
      body + '</div>';
  }
  $('#calGrid').innerHTML = html;
  var used = uniqOf(rows, 'type');
  $('#calLegend').innerHTML = used.map(function (t) {
    return '<span><i style="background:' + (A.TYPE_COLOR[t] || '#8b95a3') + '"></i>' + esc(t) + '</span>';
  }).join('') + (shade ? '<span style="color:var(--ink3)">Corner tags = travel / holiday</span>' : '') +
    (($('#showOutlook') && $('#showOutlook').checked) ? '<span><i style="background:#505861"></i>Outlook meeting</span>' : '');
  $$('#calGrid .ev[data-id]').forEach(function (b) { b.onclick = function () { openAct(b.dataset.id); }; });
  $$('#calGrid .dadd').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openAct(null, null, b.dataset.newdate); };
  });
}

/* ====================================================================== */
/*  EVENTS & TRAININGS                                                    */
/* ====================================================================== */
function evRows() {
  var t = $('#eType').value, c = $('#eCat').value, au = $('#eAud').value,
      m = $('#eMode').value, st = $('#eStatus').value;
  return fActs().filter(function (r) {
    if (r.kind !== 'Enablement') return false;
    if (t && r.type !== t) return false;
    if (c && r.category !== c) return false;
    if (au && r.audience !== au) return false;
    if (m && r.mode !== m) return false;
    if (st && r.status !== st) return false;
    return true;
  });
}
var EV_COLS = [['date','Date'],['time','Time'],['type','Type'],['level','Level'],['title','Title'],
  ['category','Category'],['audience','Audience'],['mode','Mode'],['zone','Zone'],['location','City'],
  ['partner','Partner / Disti'],['veeamStakeholder','Stakeholder'],['duration','Duration'],
  ['regs','Regs'],['attendees','Att'],['uniquePartners','Partners'],['status','Status'],['source','Source']];
function renderEvents() {
  var rows = evRows(), st = A.actStats(rows);
  $('#eCount').textContent = rows.length + ' events';
  $('#eKpis').innerHTML = [
    ['Events', rows.length, st.done + ' completed · ' + st.upcoming.length + ' upcoming', 'acc'],
    ['People reached', st.att.toLocaleString(), st.withAtt + ' events have counts', 'acc'],
    ['Partner seats', st.uniquePartners || '—', st.withUniq ? 'across ' + st.withUniq + ' events' : 'not recorded yet', 'acc'],
    ['Avg attendees', st.avgAtt == null ? '—' : st.avgAtt, 'per event with data', ''],
    ['Heads per partner', st.uniquePartners ? (st.att / st.uniquePartners).toFixed(1) : '—', 'lower is broader reach', ''],
    ['Show rate', st.conv == null ? '—' : st.conv + '%', st.reg ? st.reg + ' registered' : 'no registration data', ''],
    ['In-person', st.inperson, rows.length ? Math.round(st.inperson / rows.length * 100) + '%' : '—', ''],
    ['Missing counts', st.missingAtt.length, 'completed with no attendees', st.missingAtt.length ? 'warn' : '']
  ].map(function (i) {
    return '<div class="kpi' + (i[3] ? ' ' + i[3] : '') + '"><div class="k">' + esc(i[0]) +
      '</div><div class="v">' + i[1] + '</div><div class="d">' + esc(i[2]) + '</div></div>';
  }).join('');

  var s = sortEv;
  rows = rows.slice().sort(function (a, b) {
    if (s.k === 'regs' || s.k === 'attendees') return (num(a[s.k]) - num(b[s.k])) * s.d;
    return String(a[s.k] || '').localeCompare(String(b[s.k] || '')) * s.d;
  });
  $('#tblEv thead').innerHTML = '<tr>' + selHead() + EV_COLS.map(function (c) {
    return '<th data-k="' + c[0] + '">' + c[1] + (s.k === c[0] ? (s.d > 0 ? ' ▲' : ' ▼') : '') + '</th>';
  }).join('') + '</tr>';
  $('#tblEv tbody').innerHTML = rows.length ? rows.map(function (r) {
    return '<tr data-id="' + r.id + '"' + (sel.events[r.id] ? ' class="selrow"' : '') + '>' +
      selCell('events', r.id) +
      '<td style="white-space:nowrap;font-weight:600">' + A.niceDate(r.date) + '</td>' +
      '<td style="white-space:nowrap">' + esc(r.time || '—') + '</td><td>' + A.typePill(r.type) + '</td>' +
      '<td>' + (r.level ? A.colourPill(r.level, A.LEVEL_COLOR[r.level]) : '') + '</td>' +
      '<td class="t-title">' + (r.link && /^https?:/.test(r.link)
        ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(r.title) + '</a>'
        : esc(r.title)) + '</td>' +
      '<td>' + esc(r.category) + '</td><td>' + esc(r.audience) + '</td><td>' + esc(r.mode) + '</td>' +
      '<td>' + esc(r.zone) + '</td><td>' + esc(r.location) + '</td><td>' + esc(r.partner) + '</td>' +
      '<td>' + esc(r.veeamStakeholder) + '</td><td>' + esc(r.duration) + '</td>' +
      '<td class="n">' + esc(r.regs) + '</td><td class="n">' + esc(r.attendees) + '</td>' +
      '<td class="n">' + esc(r.uniquePartners) + '</td>' +
      '<td>' + A.statusPill(r.status) + '</td><td class="src">' + esc(r.source) + '</td></tr>';
  }).join('') : '<tr><td colspan="' + (EV_COLS.length + 1) + '"><div class="empty">No events match.</div></td></tr>';
  $$('#tblEv th[data-k]').forEach(function (th) {
    th.onclick = function () { var k = th.dataset.k; if (s.k === k) s.d *= -1; else { s.k = k; s.d = 1; } renderEvents(); };
  });
  $$('#tblEv tbody tr[data-id]').forEach(function (tr) { tr.onclick = function () { openAct(tr.dataset.id); }; });
  wireRowSelection('events');
  refreshBulkBars();
}

/* ====================================================================== */
/*  PIPELINE                                                              */
/* ====================================================================== */
function pipeRows() {
  var st = $('#pState').value, sg = $('#pStage').value, pr = $('#pProd').value,
      ind = $('#pInd').value, fl = $('#pFlag').value;
  return fOpps().filter(function (o) {
    if (st && o.state !== st) return false;
    if (sg && o.stage !== sg) return false;
    if (pr && o.product !== pr) return false;
    if (ind && o.industry !== ind) return false;
    if (fl === 'overdue' && !o.overdue) return false;
    if (fl === 'stale' && !o.stale) return false;
    if (fl === 'nopartner' && (o.partner || o.distributor)) return false;
    return true;
  });
}
function renderPipe() {
  var rows = pipeRows();
  $('#pCount').textContent = rows.length + ' of ' + S.opportunities.length + ' opportunities';
  $('#board').classList.toggle('hide', pipeView !== 'board');
  $('#ptable').classList.toggle('hide', pipeView !== 'table');
  if (pipeView === 'board') renderBoard(rows); else renderOppTable(rows);
}
function renderBoard(rows) {
  var stages = A.L.stage.filter(function (s) {
    return s.indexOf('Closed') !== 0 || rows.some(function (o) { return o.stage === s; });
  });
  $('#board').innerHTML = stages.map(function (s) {
    var items = rows.filter(function (o) { return o.stage === s; });
    return '<div class="kbc" data-stage="' + esc(s) + '">' +
      '<div class="kbh"><span style="color:' + A.STAGE_COLOR[s] + '">' + esc(s) + '</span>' +
      '<span class="n">' + items.length + '</span></div>' +
      items.map(function (o) {
        var cls = o.overdue ? ' overdue' : (o.stale ? ' stale' : '');
        return '<div class="kbi' + cls + '" draggable="true" data-id="' + o.id + '" style="border-left-color:' + A.STAGE_COLOR[s] + '">' +
          '<div class="t">' + esc(o.customer || o.name) + '</div>' +
          '<div class="m"><span>' + esc(o.product || '—') + '</span><span>' + esc(o.zone || '') + '</span></div>' +
          '<div class="m"><span>' + esc(o.partner || 'no partner') + '</span></div>' +
          '<div class="m"><span>' + (o.lastTouch ? o.daysSinceTouch + 'd since activity' : 'nothing logged') + '</span>' +
          (o.overdue ? '<span style="color:var(--red);font-weight:700">' + A.daysAgo(o.followUpDate) + 'd late</span>' : '') +
          '</div></div>';
      }).join('') + (items.length ? '' : '<div class="src" style="text-align:center;padding:10px 0">—</div>') + '</div>';
  }).join('');
  $$('#board .kbi').forEach(function (el) {
    el.onclick = function () { openOppView(el.dataset.id); };
    el.ondragstart = function (e) {
      e.dataTransfer.setData('text/plain', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    };
    el.ondragend = function () { el.classList.remove('dragging'); };
  });
  $$('#board .kbc').forEach(function (col) {
    col.ondragover = function (e) { e.preventDefault(); col.classList.add('dragover'); };
    col.ondragleave = function () { col.classList.remove('dragover'); };
    col.ondrop = function (e) {
      e.preventDefault(); col.classList.remove('dragover');
      var o = S.oppMap[e.dataTransfer.getData('text/plain')];
      if (!o || o.stage === col.dataset.stage) return;
      var from = o.stage;
      var rec = A.normOpp(Object.assign({}, o, { stage: col.dataset.stage }));
      S.upsert('opportunities', rec, A.normOpp);
      renderPipe();
      S.api('saveOpportunity', rec).then(function () {
        A.toast(rec.customer + ': ' + from + ' → ' + rec.stage);
        refresh();
      }).catch(function (err) { A.toast('Could not save: ' + err.message, 6000); });
    };
  });
}
var OPP_COLS_T = [['customer','Customer'],['name','Opportunity'],['stage','Stage'],['product','Product'],
  ['industry','Industry'],['zone','Zone'],['location','City'],['partner','Partner'],['distributor','Disti'],
  ['veeamStakeholder','Stakeholder'],['touchCount','Activities'],['lastTouch','Last activity'],
  ['followUpDate','Follow-up'],['nextAction','Next action']];
function renderOppTable(rows) {
  var s = sortOpp;
  rows = rows.slice().sort(function (a, b) {
    if (s.k === 'touchCount') return (num(a[s.k]) - num(b[s.k])) * s.d;
    return String(a[s.k] || '').localeCompare(String(b[s.k] || '')) * s.d;
  });
  $('#tblOpp thead').innerHTML = '<tr>' + selHead() + OPP_COLS_T.map(function (c) {
    return '<th data-k="' + c[0] + '">' + c[1] + (s.k === c[0] ? (s.d > 0 ? ' ▲' : ' ▼') : '') + '</th>';
  }).join('') + '</tr>';
  $('#tblOpp tbody').innerHTML = rows.length ? rows.map(function (o) {
    return '<tr data-id="' + o.id + '"' + (sel.pipe[o.id] ? ' class="selrow"' : '') + '>' +
      selCell('pipe', o.id) +
      '<td style="font-weight:650">' + esc(o.customer) + '</td>' +
      '<td class="t-title">' + esc(o.name) + '</td><td>' + A.stagePill(o.stage) + '</td>' +
      '<td>' + esc(o.product) + '</td><td>' + esc(o.industry) + '</td><td>' + esc(o.zone) + '</td>' +
      '<td>' + esc(o.location) + '</td><td>' + esc(o.partner) + '</td><td>' + esc(o.distributor) + '</td>' +
      '<td>' + esc(o.veeamStakeholder) + '</td><td class="n">' + o.touchCount + '</td>' +
      '<td' + (o.stale ? ' class="warnrow"' : '') + ' style="white-space:nowrap">' +
        (o.lastTouch ? A.niceDate(o.lastTouch) + ' <span class="src">(' + o.daysSinceTouch + 'd)</span>' : '—') + '</td>' +
      '<td' + (o.overdue ? ' class="warnrow"' : '') + ' style="white-space:nowrap">' +
        (o.followUpDate ? A.niceDate(o.followUpDate) : '—') + '</td>' +
      '<td style="max-width:180px">' + esc(o.nextAction) + '</td></tr>';
  }).join('') : '<tr><td colspan="' + (OPP_COLS_T.length + 1) + '"><div class="empty">No opportunities match.</div></td></tr>';
  $$('#tblOpp th[data-k]').forEach(function (th) {
    th.onclick = function () { var k = th.dataset.k; if (s.k === k) s.d *= -1; else { s.k = k; s.d = 1; } renderPipe(); };
  });
  $$('#tblOpp tbody tr[data-id]').forEach(function (tr) { tr.onclick = function () { openOppView(tr.dataset.id); }; });
  wireRowSelection('pipe');
  refreshBulkBars();
}

/* ====================================================================== */
/*  AVAILABILITY                                                          */
/* ====================================================================== */
function monthDates() {
  var y = avCursor.getFullYear(), m = avCursor.getMonth(), last = new Date(y, m + 1, 0).getDate(), out = [];
  for (var d = 1; d <= last; d++) {
    var ds = y + '-' + A.pad(m + 1) + '-' + A.pad(d);
    if (A.hiddenDay(ds)) continue;
    out.push(ds);
  }
  return out;
}
function renderAvail() {
  var y = avCursor.getFullYear(), m = avCursor.getMonth();
  $('#aLabel').textContent = A.MONTHS_FULL[m] + ' ' + y;
  var slots = A.slotList(), dates = monthDates();
  var html = '<table class="av"><thead><tr><th class="dcol">Date</th>' +
    slots.map(function (s) { return '<th>' + (s.slice(3) === '00' ? A.fmt12(s) : '·' + s.slice(3)) + '</th>'; }).join('') +
    '<th style="min-width:112px">Day</th></tr></thead><tbody>';
  var days = [];
  dates.forEach(function (ds) {
    var av = S.availMap[ds] || A.normAvail({ date: ds });
    days.push(av);
    var fd = A.fullDayLabel(av);
    html += '<tr><td class="dcol"><div class="dlab">' + ds.slice(8) + ' ' + A.MONTHS[m] +
      (dirtyDays[ds] ? ' <span style="color:var(--amber)">•</span>' : '') + '</div>' +
      '<div class="dsub"' + (fd.title ? ' title="' + esc(fd.title) + '"' : '') + '>' +
      A.dowOf(ds) + (fd.bare ? ' · ' + esc(fd.bare) : '') + '</div></td>';
    if (av.fullDay) {
      /* The status names the day; the meetings on it are listed alongside, so a
         travel day shows both where you were and what you did there. */
      var onDay = S.activities.filter(function (a) { return a.date === ds && a.status !== 'Cancelled'; })
        .sort(function (a, b) { return String(a.startTime || '99').localeCompare(String(b.startTime || '99')); });
      html += '<td colspan="' + slots.length + '"><div class="slot ' + av.fullDay.toLowerCase() +
        ' fullrow" style="height:34px;line-height:34px" title="' + esc(fd.title) + '">' +
        esc(fd.bare) +
        (onDay.length
          ? '<span class="fdacts">' + onDay.map(function (a) {
              return '<button class="fdact" data-act="' + a.id + '" title="' + esc(a.title + ' — ' + a.type) + '">' +
                (a.startTime ? esc(A.fmt12(a.startTime)) + ' ' : '') + esc(a.title) + '</button>';
            }).join('') + '</span>'
          : '') +
        '</div></td>';
        /* Status and place, nothing else. The day note often lists the very
           meetings the whole-day status is meant to replace — it stays on
           hover and in the Day editor. */
    } else {
      slots.forEach(function (s) {
        var v = av.slots[s] || '';
        var ol = S.outlookAt(ds, s);
        var cls = (v ? v.toLowerCase() : 'none') + (ol ? ' ol' : '');
        var tip = ds + ' ' + A.fmt12(s) + (v ? ' — ' + v : '');
        if (ol) tip += (v ? ' · ' : ' — ') + 'Outlook meeting ' + A.fmt12(ol.start) + '–' + A.fmt12(ol.end);
        html += '<td><div class="slot ' + cls + '" data-cell="' + ds + '|' + s +
          '" title="' + esc(tip) + '"></div></td>';
      });
    }
    html += '<td style="padding:3px 6px;white-space:nowrap"><button class="btn sm" data-day="' + ds + '">Day…</button></td></tr>';
  });
  $('#avGrid').innerHTML = html + '</tbody></table>';
  var st = A.availStats(days);
  $('#aSummary').textContent = st.freeH.toFixed(1) + ' free h · ' + st.busyH.toFixed(1) +
    ' booked h' + (st.outlookH ? ' (' + st.outlookH.toFixed(1) + ' from Outlook)' : '') +
    ' · ' + (st.utilisation == null ? '—' : st.utilisation + '% utilised') +
    ' · ' + st.travelDays + ' travel days · ' + st.coverage + '% filled in';

  /* conflicts inside the month on screen */
  var mk = y + '-' + A.pad(m + 1);
  var cf = S.conflicts().filter(function (x) { return x.date.slice(0, 7) === mk; });
  var cb = $('#avConflict');
  cb.classList.toggle('hide', !cf.length);
  if (cf.length) {
    cb.innerHTML = '<b>' + cf.length + ' clash' + (cf.length > 1 ? 'es' : '') + ' this month.</b> ' +
      cf.slice(0, 3).map(function (x) { return esc(A.niceDate(x.date) + ' — ' + x.msg); }).join('<br>') +
      (cf.length > 3 ? '<br><span class="src">and ' + (cf.length - 3) + ' more — see the Diary conflicts panel</span>' : '');
  }
  $('#avLegend').innerHTML = A.L.avail.map(function (k) {
    return '<span><i style="background:' + A.AVAIL_COLOR[k] + '"></i>' + k + '</span>';
  }).join('') + '<span><i style="background:#dfe4ea"></i>Not set</span>' +
    (S.outlookOn()
      ? '<span><i style="background:repeating-linear-gradient(45deg,#c9d4e4 0 3px,#dde5f0 3px 6px)"></i>' +
        'Outlook meeting — counts as booked</span>' : '');
  updateDirty();
  $$('#avGrid [data-cell]').forEach(function (el) {
    el.onmousedown = function (e) { e.preventDefault(); painting = true; paint(el); };
    el.onmouseenter = function () { if (painting) paint(el); };
  });
  $$('#avGrid [data-day]').forEach(function (b) { b.onclick = function () { openDay(b.dataset.day); }; });
  $$('#avGrid [data-act]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openAct(b.dataset.act); };
  });
}
function paint(el) {
  var p = el.dataset.cell.split('|'), ds = p[0], s = p[1];
  var av = S.availMap[ds] || A.normAvail({ date: ds });
  if (brush === '') delete av.slots[s]; else av.slots[s] = brush;
  S.upsertAvail(av);
  dirtyDays[ds] = 1;
  var ol = S.outlookAt(ds, s);
  el.className = 'slot ' + (brush ? brush.toLowerCase() : 'none') + (ol ? ' ol' : '');
  el.title = ds + ' ' + A.fmt12(s) + (brush ? ' — ' + brush : '') +
    (ol ? ' · Outlook meeting ' + A.fmt12(ol.start) + '–' + A.fmt12(ol.end) : '');
  updateDirty();
}
function updateDirty() {
  var n = Object.keys(dirtyDays).length;
  $('#aDirty').textContent = n ? n + ' day' + (n > 1 ? 's' : '') + ' unsaved' : '';
  $('#aDirty').style.color = 'var(--amber)';
  $('#aSave').classList.toggle('p', n > 0);
}
function openDay(ds) {
  dayEditing = ds;
  var av = S.availMap[ds] || A.normAvail({ date: ds });
  $('#dTitle').textContent = A.longDate(ds);
  $('#d_full').value = av.fullDay || '';
  syncDayHint();
  $('#d_city').value = av.travelCity || '';
  $('#d_notes').value = av.notes || '';
  $('#ovDay').classList.add('open');
}
/** Live preview of how the day will read on the grid and calendar. */
function syncDayHint() {
  var el = $('#d_preview');
  if (!el) return;
  var fd = A.fullDayLabel({ fullDay: $('#d_full').value, travelCity: $('#d_city').value.trim(),
                            notes: $('#d_notes').value.trim() });
  el.innerHTML = fd.bare
    ? 'Shows as <b>' + esc(fd.bare) + '</b> on the grid, and <b>' + esc(fd.short) +
      '</b> as the tag on the month calendar.'
    : 'No whole-day status — the slot row stays editable.';
}
function applyDay() {
  if (!dayEditing) return;
  var av = S.availMap[dayEditing] || A.normAvail({ date: dayEditing });
  av.fullDay = $('#d_full').value;
  av.travelCity = $('#d_city').value.trim();
  av.notes = $('#d_notes').value.trim();
  if (av.fullDay) av.slots = {};
  S.upsertAvail(av);
  dirtyDays[dayEditing] = 1;
  $('#ovDay').classList.remove('open');
  renderAvail();
}
function saveMonth() {
  /* save every day touched since the last save, even if a date range spanned months */
  var keys = {};
  monthDates().forEach(function (d) { keys[d] = 1; });
  Object.keys(dirtyDays).forEach(function (d) { keys[d] = 1; });
  var days = Object.keys(keys).sort()
    .map(function (ds) { return S.availMap[ds] || A.normAvail({ date: ds }); })
    .filter(function (a) { return a.fullDay || Object.keys(a.slots).length || a.notes; });
  $('#aSave').disabled = true;
  S.api('saveAvailability', { days: days }).then(function () {
    dirtyDays = {};
    A.toast('Availability saved — ' + days.length + ' days');
    renderAvail();
  }).catch(function (e) { A.toast('Save failed: ' + e.message, 6000); })
    .then(function () { $('#aSave').disabled = false; });
}
/* ------------------------------------------------- weekly template */
function loadTpl() {
  try { tpl = JSON.parse(localStorage.getItem(TPL_KEY) || '{}') || {}; } catch (e) { tpl = {}; }
}
function saveTpl() { try { localStorage.setItem(TPL_KEY, JSON.stringify(tpl)); } catch (e) {} }
function tplDays() {
  /* Mon-first reads better for a working week, and Sat/Sun are only dropped
     if you explicitly asked for that. */
  var order = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return A.showWeekends() ? order : order.slice(0, 5);
}
function renderTpl() {
  var slots = A.slotList(), days = tplDays();
  var html = '<table class="av"><thead><tr><th class="dcol">Day</th>' +
    slots.map(function (s) { return '<th>' + (s.slice(3) === '00' ? A.fmt12(s) : '·' + s.slice(3)) + '</th>'; }).join('') +
    '</tr></thead><tbody>';
  days.forEach(function (d) {
    html += '<tr><td class="dcol"><div class="dlab">' + d + '</div></td>';
    slots.forEach(function (s) {
      var v = (tpl[d] || {})[s] || '';
      html += '<td><div class="slot ' + (v ? v.toLowerCase() : 'none') + '" data-tcell="' + d + '|' + s + '"></div></td>';
    });
    html += '</tr>';
  });
  $('#tplGrid').innerHTML = html + '</tbody></table>';
  var paintingT = false;
  var hit = function (el) {
    var p = el.dataset.tcell.split('|');
    tpl[p[0]] = tpl[p[0]] || {};
    if (tplBrush === '') delete tpl[p[0]][p[1]]; else tpl[p[0]][p[1]] = tplBrush;
    el.className = 'slot ' + (tplBrush ? tplBrush.toLowerCase() : 'none');
  };
  $$('#tplGrid [data-tcell]').forEach(function (el) {
    el.onmousedown = function (e) { e.preventDefault(); paintingT = true; hit(el); };
    el.onmouseenter = function () { if (paintingT) hit(el); };
  });
  document.addEventListener('mouseup', function () { paintingT = false; });
}
function applyTemplate() {
  var days = tplDays();
  if (!days.some(function (d) { return tpl[d] && Object.keys(tpl[d]).length; })) {
    A.toast('No template set yet — click "Edit usual week" first');
    openTpl();
    return;
  }
  var n = 0;
  monthDates().forEach(function (ds) {
    var dow = A.dowOf(ds), pat = tpl[dow];
    if (!pat) return;
    var av = S.availMap[ds] || A.normAvail({ date: ds });
    if (av.fullDay) return;                       /* never overwrite travel or holiday */
    Object.keys(pat).forEach(function (s) {
      if (!av.slots[s]) { av.slots[s] = pat[s]; n++; }
    });
    S.upsertAvail(av); dirtyDays[ds] = 1;
  });
  renderAvail();
  A.toast(n ? n + ' empty slots filled from your usual week — click Save month' : 'Nothing left to fill');
}
function openTpl() {
  $$('[data-tbrush]').forEach(function (b) { b.classList.toggle('on', b.dataset.tbrush === tplBrush); });
  renderTpl();
  $('#ovTpl').classList.add('open');
}
/* -------------------------------------------------- date-range bulk apply */
function applyRange() {
  var from = $('#rFrom').value, to = $('#rTo').value, what = $('#rWhat').value, city = $('#rCity').value.trim();
  if (!from || !to) { A.toast('Pick both dates'); return; }
  if (to < from) { var t = from; from = to; to = t; }
  if (A.daysBetween(from, to) > 120) { A.toast('That range is longer than four months'); return; }
  var d = from, n = 0, days = [];
  while (d <= to) {
    if (!A.hiddenDay(d)) {
      var av = S.availMap[d] || A.normAvail({ date: d });
      if (what === '') { av.fullDay = ''; av.travelCity = ''; av.slots = {}; }
      else if (['Travelling','Holiday','Personal'].indexOf(what) > -1) {
        av.fullDay = what;
        av.travelCity = what === 'Travelling' ? city : '';
        av.slots = {};
      } else {
        av.fullDay = '';
        A.slotList().forEach(function (s) { av.slots[s] = what; });
      }
      S.upsertAvail(av); dirtyDays[d] = 1; days.push(av); n++;
    }
    d = A.addDays(d, 1);
  }
  renderAvail();
  A.toast(n + ' day' + (n > 1 ? 's' : '') + ' set to ' + (what || 'blank') +
          (city && what === 'Travelling' ? ' — ' + city : '') + '. Click Save month.');
}
function blockBusy(date, start, end) {
  if (!date) return null;
  var st = start || '10:00', en = end || A.addMins(st, CFG.defaultActivityMinutes || 60);
  var av = S.availMap[date] || A.normAvail({ date: date });
  if (av.fullDay) return null;
  var hit = false;
  A.slotList().forEach(function (s) { if (s >= st && s < en) { av.slots[s] = 'Busy'; hit = true; } });
  if (!hit) return null;
  S.upsertAvail(av);
  return av;
}

/* ====================================================================== */
/*  ACTIVITY FORM                                                         */
/* ====================================================================== */
function applyKind() {
  var kind = A.kindOf($('#a_type').value);
  $('#actKindChip').innerHTML = A.kindChip(kind);
  $('#a_kindHint').textContent = 'Counts as ' + kind + ' — set automatically from the type.';
  var isEn = kind === 'Enablement', isDeal = kind === 'Deal support';
  $$('.enableonly').forEach(function (e) { e.classList.toggle('hide', !isEn); });
  $$('.dealonly').forEach(function (e) { e.classList.toggle('hide', !isDeal); });
  /* Deal support asks for the customer instead of a title — the title is built
     from the customer and the type, so there is nothing useful to type twice. */
  $$('.notdeal').forEach(function (e) { e.classList.toggle('hide', isDeal); });
}
function openAct(id, quickType, presetDate) {
  editAct = id || null;
  var r = id ? S.activities.filter(function (x) { return x.id === id; })[0] : null;
  $('#actTitle').textContent = id ? 'Edit activity' : 'Log activity';
  $('#actDel').style.display = id ? '' : 'none';
  $('#actErr').classList.remove('show');

  fillOppCombo();

  var v = function (s, val) { $(s).value = val == null ? '' : val; };
  v('#a_type', r ? r.type : (quickType || 'Meeting'));
  v('#a_date', r ? r.date : (presetDate || A.today()));
  v('#a_start', r ? r.startTime : '');
  v('#a_end', r ? r.endTime : '');
  v('#a_title', r ? r.title : '');
  v('#a_status', r ? r.status : (((presetDate || A.today()) > A.today()) ? 'Planned' : 'Completed'));
  setOppPick(r ? r.oppId : '');
  $('#a_custFree').value = (r && !r.oppId) ? (r.customer || '') : '';
  /* Customer name comes from the linked deal when there is one, otherwise from
     whatever was typed straight onto the activity. */
  var oppOf = r && r.oppId ? S.oppMap[r.oppId] : null;
  v('#a_customer', (oppOf && oppOf.customer) || (r && r.customer) ||
                   (r ? customerFromTitle(r.title, r.type) : ''));
  v('#a_contactName', (oppOf && oppOf.contactPerson) || '');
  v('#a_contact', (oppOf && oppOf.contactNumber) || '');
  v('#a_email', (oppOf && oppOf.contactEmail) || '');
  fillOppCombo();
  if (r && r.oppId) setOppPick(r.oppId);
  pullContact();
  v('#a_stage', r ? r.stage : '');
  v('#a_product', r ? r.product : '');
  v('#a_next', r ? r.nextAction : '');
  v('#a_follow', r ? r.followUpDate : '');
  v('#a_cat', r ? r.category : '');
  v('#a_level', r ? r.level : '');
  v('#a_regs', r ? r.regs : '');
  v('#a_att', r ? r.attendees : '');
  v('#a_uniq', r ? r.uniquePartners : '');
  v('#a_dur', r ? r.duration : '');
  v('#a_link', r ? r.link : '');
  v('#a_mode', r ? r.mode : 'Online');
  v('#a_zone', r ? r.zone : '');
  v('#a_loc', r ? r.location : '');
  v('#a_partner', r ? r.partner : '');
  v('#a_stake', r ? r.veeamStakeholder : '');
  v('#a_remarks', r ? r.remarks : '');
  v('#a_outcome', r ? r.outcome : '');
  var picked = String((r && r.audience) || '').split(',').map(function (s) { return s.trim(); });
  $$('#a_aud input[type=checkbox]').forEach(function (cb) { cb.checked = picked.indexOf(cb.value) > -1; });
  $('#a_block').checked = !id;
  $('#a_dur').dataset.auto = '1';
  applyKind(); syncAct();
  $('#ovAct').classList.add('open');
  setTimeout(function () { $('#a_title').focus(); }, 60);
}
window.openAct = openAct;
function syncAct() {
  var s = $('#a_start').value, e = $('#a_end').value;
  var auto = A.durLabel(s, e);
  if (auto && (!$('#a_dur').value || $('#a_dur').dataset.auto === '1')) {
    $('#a_dur').value = auto; $('#a_dur').dataset.auto = '1';
  }
  var rg = num($('#a_regs').value), at = num($('#a_att').value), uq = num($('#a_uniq').value);
  var bits = [];
  if (rg && at) bits.push(Math.round(at / rg * 100) + '% showed');
  if (at && uq) bits.push((at / uq).toFixed(1) + ' per partner');
  $('#a_conv').value = bits.length ? bits.join(' · ') : '—';
  var lvl = $('#a_level').value;
  var TIER = { Foundation: 'Targets Registered & Silver partners', Advanced: 'Targets Gold & Platinum partners' };
  $('#a_tierHint').textContent = TIER[lvl] || '';
  /* pull context from the linked opportunity */
  var o = S.oppMap[$('#a_opp').value];
  if (o && !editAct) {
    if (!$('#a_partner').value) $('#a_partner').value = o.partner || '';
    if (!$('#a_zone').value) $('#a_zone').value = o.zone || '';
    if (!$('#a_loc').value) $('#a_loc').value = o.location || '';
    if (!$('#a_stake').value) $('#a_stake').value = o.veeamStakeholder || '';
    if (!$('#a_product').value) $('#a_product').value = o.product || '';
    if (!$('#a_customer').value) $('#a_customer').value = o.customer || '';
    /* Deal support builds its own title on save — see actTitle(). */
    if (A.kindOf($('#a_type').value) !== 'Deal support' && !$('#a_title').value)
      $('#a_title').value = o.customer + ' — ' + $('#a_type').value;
  }
  /* Show what will actually be filed, so the composed title is never a surprise. */
  var ch = $('#a_custHint');
  if (ch) {
    var k = A.kindOf($('#a_type').value);
    var cn = String($('#a_customer').value || '').trim();
    ch.textContent = (k === 'Deal support' && cn)
      ? 'Files as “' + actTitle(k, o) + '”'
      : 'Type a new customer and you can create the deal for them on the spot.';
  }
}
function collectAct() {
  var pname = $('#a_partner').value.trim();
  var known = ['Internal','Partner','End Customer'].indexOf(pname) > -1;
  var oppId = $('#a_opp').value;
  var kind = A.kindOf($('#a_type').value);
  var o = S.oppMap[oppId];
  return A.normActivity({
    id: editAct || A.uid('A-'),
    date: $('#a_date').value, startTime: $('#a_start').value, endTime: $('#a_end').value,
    type: $('#a_type').value, title: actTitle(kind, o),
    oppId: kind === 'Deal support' ? oppId : '',
    customer: dealCustomer(kind, o),
    status: $('#a_status').value,
    stage: kind === 'Deal support' ? $('#a_stage').value : '',
    product: $('#a_product').value,
    nextAction: $('#a_next').value.trim(),
    followUpDate: $('#a_follow').value,
    category: kind === 'Enablement' ? $('#a_cat').value : '',
    level: kind === 'Enablement' ? $('#a_level').value : '',
    partnerTier: kind === 'Enablement'
      ? ({ Foundation: 'Registered, Silver', Advanced: 'Gold, Platinum' }[$('#a_level').value] || '') : '',
    audience: kind === 'Enablement' ? auds().join(', ') : '',
    regs: (kind === 'Enablement' && $('#a_regs').value !== '') ? num($('#a_regs').value) : '',
    attendees: (kind === 'Enablement' && $('#a_att').value !== '') ? num($('#a_att').value) : '',
    uniquePartners: (kind === 'Enablement' && $('#a_uniq').value !== '') ? num($('#a_uniq').value) : '',
    source: (editAct && S.activities.filter(function (x) { return x.id === editAct; })[0] || {}).source || 'Entered here',
    duration: $('#a_dur').value.trim(),
    link: $('#a_link').value.trim(),
    mode: $('#a_mode').value, zone: $('#a_zone').value, location: $('#a_loc').value.trim(),
    partner: known ? pname : S.partnerName(pname),
    partnerType: known ? 'Internal/NA' : S.partnerType(pname),
    veeamStakeholder: $('#a_stake').value.trim(), se: CFG.ownerName || '',
    remarks: $('#a_remarks').value.trim(), outcome: $('#a_outcome').value.trim()
  });
}
function saveAct(mode) {
  var errs = [];
  var kindNow = A.kindOf($('#a_type').value);
  if (!$('#a_date').value) errs.push('Date is required.');
  if (kindNow === 'Deal support') {
    if (!String($('#a_customer').value || '').trim()) errs.push('Customer name is required.');
    var em = String($('#a_email').value || '').trim();
    if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) errs.push('That email address does not look right.');
  } else if (!$('#a_title').value.trim()) {
    errs.push('Title is required.');
  }
  if ($('#a_start').value && $('#a_end').value && A.minsBetween($('#a_start').value, $('#a_end').value) === 0)
    errs.push('Start and end cannot be identical.');
  if (errs.length) { showErr('#actErr', errs.join(' ')); return; }

  /* Every deal-support activity is about a deal, so make sure one exists before
     the activity is written — otherwise the activity is filed with a customer
     name and no pipeline entry, which is the gap this closes. */
  $('#actSave').disabled = true;
  ensureOppForCustomer(kindNow).then(function () {
    saveActNow(mode);
  }).catch(function (e) {
    $('#actSave').disabled = false;
    if (e && e.message === '__cancelled__') {
      showErr('#actErr', 'Pick which opportunity this belongs to, then save again.');
      return;
    }
    showErr('#actErr', 'Could not create the opportunity: ' + esc(e.message));
  });
}

/* Deal support with a named customer and no deal linked gets one, silently.
   Matching is case-insensitive on the customer name, so logging three meetings
   with the same customer links all three to one opportunity rather than
   creating three. */
function ensureOppForCustomer(kindNow) {
  if (kindNow !== 'Deal support') return Promise.resolve(null);
  if ($('#a_opp').value) return Promise.resolve(S.oppMap[$('#a_opp').value]);
  var cust = String($('#a_customer').value || '').trim();
  if (!cust) return Promise.resolve(null);

  var matches = S.opportunities.filter(function (o) {
    return String(o.customer || '').trim().toLowerCase() === cust.toLowerCase();
  });
  if (matches.length === 1) {
    setOppPick(matches[0].id);
    return Promise.resolve(matches[0]);
  }
  if (matches.length > 1) {
    /* Two deals for one customer. Picking the first would silently attach the
       activity to the wrong one, so ask. Open deals first, most recently
       touched at the top — the likely answer is near the front. */
    var ordered = matches.slice().sort(function (a, b) {
      if (A.stageClosed(a.stage) !== A.stageClosed(b.stage)) return A.stageClosed(a.stage) ? 1 : -1;
      return String(b.lastTouch || '').localeCompare(String(a.lastTouch || ''));
    });
    return askChoice(esc(cust) + ' has ' + matches.length + ' opportunities',
      'Which one is this activity against?',
      ordered.slice(0, 4).map(function (o) {
        return { key: o.id, label: o.name || o.customer,
                 note: o.stage + (o.lastTouch ? ' · last activity ' + A.niceDate(o.lastTouch) : ' · nothing logged yet') };
      })
    ).then(function (id) {
      /* Cancelling must not quietly file the activity against nobody. */
      if (!id) throw new Error('__cancelled__');
      setOppPick(id);
      return S.oppMap[id];
    });
  }
  return createOpp(cust, cust).then(function (rec) {
    if (!rec) throw new Error('the Sheet rejected it');
    return rec;
  });
}

var stageHeld = null;
function saveActNow(mode) {
  stageHeld = null;
  var rec = collectAct();
  S.upsert('activities', rec, A.normActivity);
  if (['Internal','Partner','End Customer'].indexOf(rec.partner) === -1) ensurePartner(rec.partner, rec.partnerType);

  var jobs = [function () { return S.api('saveActivity', rec); }];

  /* roll the opportunity forward */
  var o = S.oppMap[rec.oppId];
  if (o) {
    var upd = Object.assign({}, o);
    /* Advance only — see advanceStage(). The activity keeps whatever stage you
       chose; the opportunity keeps the furthest it has got to. */
    var wanted = rec.stage, moved = A.advanceStage(o.stage, wanted);
    if (wanted && moved !== wanted) stageHeld = { deal: o.customer || o.name, at: o.stage, tried: wanted };
    upd.stage = moved;
    if (rec.nextAction) upd.nextAction = rec.nextAction;
    if (rec.followUpDate) upd.followUpDate = rec.followUpDate;
    /* Contact details live on the customer, not on one meeting — so typing
       them here keeps the master record current. Blank never wipes. */
    var cp = String($('#a_contactName').value || '').trim();
    var cn = String($('#a_contact').value || '').trim();
    var ce = String($('#a_email').value || '').trim();
    if (cp) upd.contactPerson = cp;
    if (cn) upd.contactNumber = cn;
    if (ce) upd.contactEmail = ce;
    var ro = A.normOpp(upd);
    S.upsert('opportunities', ro, A.normOpp);
    jobs.push(function () { return S.api('saveOpportunity', ro); });
  }
  if ($('#a_block').checked) {
    var av = blockBusy(rec.date, rec.startTime, rec.endTime);
    if (av) jobs.push(function () { return S.api('saveAvailability', { days: [av] }); });
  }
  $('#actSave').disabled = true;
  /* One at a time. These three writes touch the same Sheet, and firing them
     together is what caused the random "Sheet said..." failures: three Apps
     Script executions racing for the same next-empty-row. */
  runInOrder(jobs).then(function () {
    if (stageHeld) {
      A.toast(stageHeld.deal + ' stays at ' + stageHeld.at + ' — “' + stageHeld.tried +
              '” is recorded on the activity, but a deal only moves forward', 6500);
    } else {
      A.toast(editAct ? 'Activity updated' : 'Activity logged');
    }
    if (mode === 'again') {
      var d = rec.date, t = rec.type;
      $('#ovAct').classList.remove('open');
      refresh();
      openAct(null, t, d);
    } else {
      $('#ovAct').classList.remove('open');
      refresh();
      if (mode === 'ics') A.downloadIcs([rec], A.slug(rec.title));
    }
  }).catch(function (e) { showErr('#actErr', 'Saved locally but the Sheet said: ' + e.message); })
    .then(function () { $('#actSave').disabled = false; });
}
function showErr(sel, msg) { var e = $(sel); e.textContent = msg; e.classList.add('show'); }

/* ====================================================================== */
/*  OPPORTUNITY FORM + DETAIL                                             */
/* ====================================================================== */
function openOpp(id) {
  editOpp = id || null;
  var o = id ? S.oppMap[id] : null;
  $('#oppTitle').textContent = id ? 'Edit opportunity' : 'New opportunity';
  $('#oppDel').style.display = id ? '' : 'none';
  $('#oppErr').classList.remove('show');
  var v = function (s, val) { $(s).value = val == null ? '' : val; };
  v('#o_customer', o && o.customer); v('#o_name', o && o.name);
  v('#o_industry', o && o.industry);
  v('#o_stage', (o && o.stage) || 'Lead'); v('#o_zone', o && o.zone);
  v('#o_location', o && o.location); v('#o_stake', o && o.veeamStakeholder);
  v('#o_cperson', o && o.contactPerson); v('#o_cnumber', o && o.contactNumber); v('#o_cemail', o && o.contactEmail);
  v('#o_partner', o && o.partner); v('#o_psales', o && o.partnerSales);
  v('#o_ppresales', o && o.partnerPreSales); v('#o_ppcontact', o && o.partnerPreSalesContact);
  /* read-only, derived from the activity log */
  $('#o_product').value = (o && o.product) || '—';
  $('#o_next').value = (o && o.nextAction) || '—';
  $('#o_follow').value = (o && o.followUpDate)
    ? A.niceDate(o.followUpDate) + (o.overdue ? ' (overdue)' : '') : '—';
  $('#o_info').value = o && o.touchCount
    ? o.touchCount + ' activities · last ' + A.niceDate(o.lastTouch) + ' (' + o.daysSinceTouch + 'd ago)'
    : 'nothing logged yet';
  $('#ovOpp').classList.add('open');
  setTimeout(function () { $('#o_customer').focus(); }, 60);
}
function saveOpp(thenLog) {
  var cust = $('#o_customer').value.trim();
  if (!cust) { showErr('#oppErr', 'Customer is required.'); return; }
  if (!$('#o_name').value.trim()) $('#o_name').value = cust;
  var base = editOpp ? Object.assign({}, S.oppMap[editOpp]) : {};
  var rec = A.normOpp(Object.assign(base, {
    id: editOpp || A.uid('OPP-'),
    customer: cust, name: $('#o_name').value.trim(),
    industry: $('#o_industry').value,
    stage: $('#o_stage').value, zone: $('#o_zone').value, location: $('#o_location').value.trim(),
    veeamStakeholder: $('#o_stake').value.trim(),
    contactPerson: $('#o_cperson').value.trim(), contactNumber: $('#o_cnumber').value.trim(),
    contactEmail: $('#o_cemail').value.trim(),
    partner: S.partnerName($('#o_partner').value.trim()), partnerSales: $('#o_psales').value.trim(),
    partnerPreSales: $('#o_ppresales').value.trim(), partnerPreSalesContact: $('#o_ppcontact').value.trim()
  }));
  if (!rec.industryRaw) rec.industryRaw = rec.industry;
  S.upsert('opportunities', rec, A.normOpp);
  ensurePartner(rec.partner, 'Partner');
  $('#oppSave').disabled = true;
  S.api('saveOpportunity', rec).then(function () {
    $('#ovOpp').classList.remove('open');
    A.toast(editOpp ? 'Opportunity updated' : 'Opportunity created');
    refresh();
    if (thenLog) openAct(null, 'Meeting', A.today()), setOppPick(rec.id), syncAct();
  }).catch(function (e) { showErr('#oppErr', 'Saved locally but the Sheet said: ' + e.message); })
    .then(function () { $('#oppSave').disabled = false; });
}
function openOppView(id) {
  var o = S.oppMap[id];
  if (!o) return;
  viewOpp = id;
  $('#vTitle').textContent = o.customer || o.name;
  var pairs = [
    ['Opportunity', o.name],
    ['Stage', A.stagePill(o.stage) + (o.state === 'Closed' ? ' <span class="src">closed</span>' : '')],
    ['Product', o.product],
    ['Industry', o.industry + (o.industryRaw && o.industryRaw !== o.industry
      ? ' <span class="src">(entered as ' + esc(o.industryRaw) + ')</span>' : '')],
    ['Zone / city', [o.zone, o.location].filter(Boolean).join(' · ')],
    ['Veeam stakeholder', o.veeamStakeholder],
    ['Contact', [o.contactPerson, o.contactEmail, o.contactNumber].filter(Boolean).join(' · ')],
    ['Partner', [o.partner, o.partnerSales && '(' + o.partnerSales + ')'].filter(Boolean).join(' ')],
    ['Partner pre-sales', o.partnerPreSales],
    ['Distributor', [o.distributor, o.distributorPreSales && '(' + o.distributorPreSales + ')'].filter(Boolean).join(' ')],
    ['Age', o.firstTouch ? A.daysAgo(o.firstTouch) + ' days (first activity ' + A.niceDate(o.firstTouch) + ')' : '—'],
    ['Last activity', o.lastTouch ? A.niceDate(o.lastTouch) + ' — ' + o.daysSinceTouch + ' days ago' : 'nothing logged'],
    ['Next action', o.nextAction],
    ['Follow-up', o.followUpDate
      ? A.niceDate(o.followUpDate) + (o.overdue ? ' <b style="color:var(--red)">— ' + A.daysAgo(o.followUpDate) + ' days overdue</b>' : '')
      : '—'],
    ['Notes', o.remarks]
  ];
  var raw = { 'Stage': 1, 'Industry': 1, 'Follow-up': 1 };
  $('#vBody').innerHTML = pairs.filter(function (p) { return p[1] !== '' && p[1] != null; })
    .map(function (p) { return '<dt>' + p[0] + '</dt><dd>' + (raw[p[0]] ? p[1] : esc(p[1])) + '</dd>'; }).join('');
  var ts = S.actsFor(id);
  $('#vTimeline').innerHTML = ts.length ? ts.map(function (t) {
    return '<div class="tli" data-aid="' + t.id + '" style="cursor:pointer">' +
      '<div class="dt2">' + A.niceDate(t.date) + '</div><div class="bd"><b>' + esc(t.type) + '</b>' +
      (t.stage ? ' → ' + A.stagePill(t.stage) : '') +
      (t.remarks ? '<div class="mt">' + esc(t.remarks) + '</div>' : '') +
      (t.nextAction ? '<div class="mt">Next: ' + esc(t.nextAction) +
        (t.followUpDate ? ' by ' + A.niceDate(t.followUpDate) : '') + '</div>' : '') +
      '<div class="mt">' + [t.veeamStakeholder, t.partner].filter(Boolean).map(esc).join(' · ') + '</div>' +
      '</div></div>';
  }).join('') : '<div class="src" style="padding:8px 0">Nothing logged yet.</div>';
  $$('#vTimeline [data-aid]').forEach(function (el) {
    el.onclick = function () { $('#ovView').classList.remove('open'); openAct(el.dataset.aid); };
  });
  $('#ovView').classList.add('open');
}
window.openOppView = openOppView;

/* ====================================================================== */
/*  PARTNERS                                                              */
/* ====================================================================== */
function ensurePartner(name, type) {
  if (!name) return;
  var k = A.partnerKey(name);
  if (!k || S.partners.some(function (p) { return p.key === k; })) return;
  var rec = A.normPartner({ key: k, name: name, type: type === 'Internal/NA' ? 'Partner' : (type || 'Partner'), sources: 'manual' });
  S.partners.push(rec);
  S.api('savePartner', rec).catch(function () {});
}
function openPtr(key) {
  editPtr = key || null;
  var p = key ? S.partners.filter(function (x) { return x.key === key; })[0] : null;
  $('#ptrTitle').textContent = key ? 'Edit partner' : 'New partner';
  $('#ptrDel').style.display = key ? '' : 'none';
  $('#ptrErr').classList.remove('show');
  $('#p_name').value = p ? p.name : '';
  $('#p_type').value = p ? p.type : 'Partner';
  $('#p_tier').value = p ? p.tier : '';
  $('#p_zone').value = p ? p.zone : '';
  $('#p_owner').value = p ? p.owner : '';
  $('#p_notes').value = p ? p.notes : '';
  $('#ovPtr').classList.add('open');
}
function savePtr() {
  var name = $('#p_name').value.trim();
  if (!name) { showErr('#ptrErr', 'Name is required.'); return; }
  var old = S.partners.filter(function (x) { return x.key === editPtr; })[0];
  var rec = A.normPartner({ key: editPtr || A.partnerKey(name), name: name, type: $('#p_type').value,
    tier: $('#p_tier').value, owner: $('#p_owner').value.trim(),
    zone: $('#p_zone').value, notes: $('#p_notes').value.trim(), sources: (old && old.sources) || 'manual' });
  var i = -1;
  S.partners.forEach(function (x, k) { if (x.key === rec.key) i = k; });
  if (i >= 0) S.partners[i] = rec; else S.partners.push(rec);
  S.api('savePartner', rec).then(function () {
    $('#ovPtr').classList.remove('open');
    A.toast('Partner saved'); refresh();
  }).catch(function (e) { showErr('#ptrErr', e.message); });
}
var PTR_COLS_T = [['name','Organisation'],['type','Type'],['tier','Tier'],['owner','Veeam owner'],
                  ['zone','Zone'],['en','Enablement'],['ds','Deal support'],['opps','Opportunities'],
                  ['sources','Seen in'],['notes','Notes']];
var TIER_COLOR = { Platinum:'#5a6472', Gold:'#97D700', Silver:'#8b95a3', Registered:'#0d7fa8' };
function renderPartners() {
  var q = $('#ptrSearch').value.trim().toLowerCase();
  var rows = S.partners.map(function (p) {
    var o = Object.assign({}, p);
    var mine = S.activities.filter(function (a) { return A.partnerKey(a.partner) === p.key; });
    o.en = mine.filter(function (a) { return a.kind === 'Enablement'; }).length;
    o.ds = mine.filter(function (a) { return a.kind === 'Deal support'; }).length;
    o.opps = S.opportunities.filter(function (x) {
      return A.partnerKey(x.partner) === p.key || A.partnerKey(x.distributor) === p.key; }).length;
    return o;
  }).filter(function (p) {
    return !q || (p.name + ' ' + p.type + ' ' + p.tier + ' ' + p.owner + ' ' + p.notes).toLowerCase().indexOf(q) > -1;
  });
  var s = sortPtr;
  rows.sort(function (a, b) {
    if (['en','ds','opps'].indexOf(s.k) > -1) return (a[s.k] - b[s.k]) * s.d;
    return String(a[s.k] || '').localeCompare(String(b[s.k] || '')) * s.d;
  });
  $('#ptrCount').textContent = '— ' + rows.length;
  $('#tblPtr thead').innerHTML = '<tr>' + PTR_COLS_T.map(function (c) {
    return '<th data-k="' + c[0] + '">' + c[1] + (s.k === c[0] ? (s.d > 0 ? ' ▲' : ' ▼') : '') + '</th>';
  }).join('') + '</tr>';
  $('#tblPtr tbody').innerHTML = rows.length ? rows.map(function (p) {
    return '<tr data-key="' + esc(p.key) + '"><td style="font-weight:600">' + esc(p.name) + '</td>' +
      '<td>' + A.colourPill(p.type, p.type === 'Distributor' ? '#97D700' : '#00D15F') + '</td>' +
      '<td>' + (p.tier ? A.colourPill(p.tier, TIER_COLOR[p.tier]) : '<span class="src">—</span>') + '</td>' +
      '<td>' + esc(p.owner) + '</td>' +
      '<td>' + esc(p.zone) + '</td><td class="n">' + p.en + '</td><td class="n">' + p.ds + '</td>' +
      '<td class="n">' + p.opps + '</td><td class="src">' + esc(p.sources) + '</td>' +
      '<td style="max-width:180px">' + esc(p.notes) + '</td></tr>';
  }).join('') : '<tr><td colspan="' + PTR_COLS_T.length + '"><div class="empty">No partners.</div></td></tr>';
  $$('#tblPtr th[data-k]').forEach(function (th) {
    th.onclick = function () { var k = th.dataset.k; if (s.k === k) s.d *= -1; else { s.k = k; s.d = 1; } renderPartners(); };
  });
  $$('#tblPtr tbody tr[data-key]').forEach(function (tr) { tr.onclick = function () { openPtr(tr.dataset.key); }; });
}

/* ====================================================================== */
/*  DATA TAB                                                              */
/* ====================================================================== */
function renderData() {
  $('#connInfo').innerHTML = [
    ['Web App URL', A.apiUrl()
        ? '<span class="src">' + esc(A.apiUrl().slice(0, 54)) + '…</span>' +
          (A.apiIsOverridden() ? ' <b>(set in this browser)</b>' : '')
        : '<b style="color:var(--red)">not set</b>'],
    ['Status', '<span class="dot ok"></span> connected'],
    ['Last loaded', S.updated ? esc(String(S.updated).slice(0, 16).replace('T', ' ')) + ' UTC' : '—'],
    ['Activities', S.activities.length + ' <span class="src">(' +
      S.activities.filter(function (a) { return a.kind === 'Enablement'; }).length + ' enablement, ' +
      S.activities.filter(function (a) { return a.kind === 'Deal support'; }).length + ' deal support)</span>'],
    ['Opportunities', S.opportunities.length],
    ['Availability days', S.availability.length],
    ['Partners', S.partners.length],
    ['Dashboard panels', layout.filter(function (l) { return l.on; }).length + ' of ' + layout.length + ' shown']
  ].map(function (p) { return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>'; }).join('');

  renderOutlookCard();
  renderLists();

  var items = [];
  var push = function (cls, tag, html, go) { items.push({ cls: cls, tag: tag, html: html, go: go }); };
  /* Each line drills to exactly its own records — switching tab and showing
     everything is not an answer to "which ones?". */
  var noTime = S.activities.filter(function (a) { return !a.timed; });
  if (noTime.length) push('ms', 'No time', '<b>' + noTime.length + ' activities</b> have no start and end time, so hour totals estimate them at ' +
    (CFG.defaultActivityMinutes || 60) + ' minutes',
    function () { setDrill('Activities with no start and end time', 'activities', noTime, 'log'); });

  var noMode = S.activities.filter(function (a) { return !String(a.mode || '').trim(); });
  if (noMode.length) push('ms', 'No mode', '<b>' + noMode.length + ' activities</b> do not say whether they were in-person or online, ' +
    'so travel time cannot be worked out for them',
    function () { setDrill('Activities with no delivery mode', 'activities', noMode, 'log'); });

  var noOpp = S.activities.filter(function (a) { return a.kind === 'Deal support' && !a.oppId; });
  if (noOpp.length) push('ms', 'Unlinked', '<b>' + noOpp.length + ' deal-support activities</b> are not linked to an opportunity',
    function () { setDrill('Deal-support activities with no opportunity', 'activities', noOpp, 'log'); });

  var noAtt = S.activities.filter(function (a) { return a.kind === 'Enablement' && a.status === 'Completed' && !has(a.attendees); });
  if (noAtt.length) push('ms', 'No count', '<b>' + noAtt.length + ' completed events</b> have no attendee number',
    function () { setDrill('Completed events with no attendee count', 'activities', noAtt, 'events'); });

  var noInd = S.opportunities.filter(function (o) { return !o.industry; });
  if (noInd.length) push('st', 'Industry', '<b>' + noInd.length + ' opportunities</b> have no industry',
    function () { pipeView = 'table'; setDrill('Opportunities with no industry', 'opportunities', noInd, 'pipe'); });

  var noPtr = S.opportunities.filter(function (o) { return !o.partner && !o.distributor; });
  if (noPtr.length) push('st', 'No partner', '<b>' + noPtr.length + ' opportunities</b> have no partner or distributor',
    function () { pipeView = 'table'; setDrill('Opportunities with no partner', 'opportunities', noPtr, 'pipe'); });

  var noLog = S.opportunities.filter(function (o) { return !o.touchCount; });
  if (noLog.length) push('st', 'Silent', '<b>' + noLog.length + ' opportunities</b> have no activity logged against them',
    function () { pipeView = 'table'; setDrill('Opportunities with nothing logged', 'opportunities', noLog, 'pipe'); });

  /* A deal sitting lower than its own history — usually because an older
     build let a catch-up call drag the stage backwards. */
  var behind = S.opportunities.filter(function (o) {
    var best = -1;
    S.actsFor(o.id).forEach(function (a) {
      var r = A.stageRank(a.stage);
      if (r > best) best = r;
    });
    return best > -1 && !A.stageClosed(o.stage) && best > A.stageRank(o.stage);
  });
  if (behind.length) push('st', 'Behind', '<b>' + behind.length + ' opportunities</b> sit at a lower stage than ' +
    'their own activity history reached — nudge them forward if that is wrong',
    function () { pipeView = 'table'; setDrill('Deals below their own history', 'opportunities', behind, 'pipe'); });

  /* Two opportunities under one customer name. The pipeline should show one
     row per deal, so this is either a real second deal or a typo to merge. */
  var seen = {}, dupes = [];
  S.opportunities.forEach(function (o) {
    var k = String(o.customer || '').trim().toLowerCase();
    if (!k) return;
    if (seen[k]) { if (dupes.indexOf(seen[k]) < 0) dupes.push(seen[k]); dupes.push(o); }
    else seen[k] = o;
  });
  if (dupes.length) push('st', 'Duplicate', '<b>' + dupes.length + ' opportunities</b> share a customer name with another — ' +
    'merge them with <b>Rename everywhere</b> if one is a typo',
    function () { pipeView = 'table'; setDrill('Customers with more than one deal', 'opportunities', dupes, 'pipe'); });

  var orphan = S.activities.filter(function (a) { return a.oppId && !S.oppMap[a.oppId]; });
  if (orphan.length) push('od', 'Orphans', '<b>' + orphan.length + ' activities</b> point at an opportunity that no longer exists',
    function () { setDrill('Activities pointing at a deleted opportunity', 'activities', orphan, 'log'); });

  $('#health').innerHTML = items.length ? items.map(function (it, i) {
    return '<div class="ai ' + it.cls + '" data-h="' + i + '"><div class="ic">' + it.tag + '</div><div class="bd">' + it.html + '</div></div>';
  }).join('') : '<div class="empty">No data issues found.</div>';
  $$('#health [data-h]').forEach(function (el) {
    var it = items[+el.dataset.h];
    if (it.go) { el.onclick = it.go; el.style.cursor = 'pointer'; el.title = 'Show me these records'; }
    else el.style.cursor = 'default';
  });
  renderPartners();
}

function renderOutlookCard() {
  var st = S.outlookStatus || {}, on = S.outlookOn();
  $('#olState').innerHTML = '<span class="oldot ' + (on ? 'on' : 'off') + '"></span>' +
    (on ? S.outlook.length + ' busy blocks' : 'not connected');
  var td = A.today();
  var soon = S.outlook.filter(function (o) { return o.date >= td; }).length;
  var lines = [];
  if (on) {
    lines.push('<b>Connected.</b> ' + S.outlook.length + ' busy blocks loaded, ' + soon + ' of them from today onwards.');
    if (st.last) lines.push('Last sync: ' + esc(String(st.last).slice(0, 16).replace('T', ' ')) + ' UTC.');
    lines.push(st.hourly ? 'Hourly sync is <b>on</b>.'
                         : 'Hourly sync is <b>off</b> — turn it on from the Sheet menu, ' +
                           '<b>Command Center → Turn ON hourly Outlook sync</b>.');
    lines.push('Meeting subjects are never copied. Only start and end times come across, which is ' +
               'all the grid needs to block correctly.');
    lines.push('Outlook time shows as a hatched overlay on the Availability grid. It counts as booked ' +
               'in your free-hours total but never overwrites what you painted — disconnect and your ' +
               'own entries are exactly as you left them.');
  } else {
    lines.push('<b>Not connected yet.</b> Two ways to set it up, both in <b>OUTLOOK-SYNC.md</b>:');
    lines.push('<b>Published link</b> — Outlook Web gives you a private .ics address; the Sheet fetches it ' +
               'every hour. Set it up with <b>Command Center → Connect Outlook calendar</b> in the Sheet menu.');
    lines.push('<b>Power Automate</b> — a Microsoft flow pushes your events to the Sheet. Use this if your ' +
               'tenant blocks calendar publishing.');
  }
  if (st.status) lines.push('<span class="src">' + esc(st.status) + '</span>');
  $('#olInfo').innerHTML = lines.join('<br>');
}

/* ====================================================================== */
/*  BULK EDIT                                                             */
/*  Tick rows on any table, then change one or more fields on all of them  */
/*  at once. Only the fields you tick are written — everything else on     */
/*  each record is left exactly as it was.                                 */
/* ====================================================================== */
/* Selection is per TABLE, not per record type. Daily Log and Events both list
   activities; sharing one set meant a row ticked on one tab was counted by the
   other, and a row hidden by a filter stayed counted with nothing on screen to
   show for it — "1 record selected" with nothing selected. */
var sel = { log: {}, events: {}, pipe: {} };
var BULK_TABLES = {
  log:    { table: '#tblLog', kind: 'activities',    sfx: '' },
  events: { table: '#tblEv',  kind: 'activities',    sfx: 'E' },
  pipe:   { table: '#tblOpp', kind: 'opportunities', sfx: 'P' }
};
var bulkKind = 'activities', bulkTable = 'log';

function selCount(t) { return Object.keys(sel[t] || {}).length; }
function selIds(t) { return Object.keys(sel[t] || {}); }
function clearSel(t) { sel[t] = {}; }
function toggleSel(t, id, on) {
  if (on) sel[t][id] = 1; else delete sel[t][id];
}
/* Forget anything that is no longer on screen, so the count can never claim a
   selection you cannot see or act on. */
function pruneSel(t, visibleIds) {
  var keep = {};
  visibleIds.forEach(function (id) { if (sel[t][id]) keep[id] = 1; });
  sel[t] = keep;
}
function refreshBulkBars() {
  Object.keys(BULK_TABLES).forEach(function (t) {
    var bar = $('#bulkBar' + BULK_TABLES[t].sfx);
    if (!bar) return;
    var n = selCount(t);
    bar.classList.toggle('hide', n === 0);
    var c = $('#bulkCount' + BULK_TABLES[t].sfx);
    if (c) c.textContent = n + (n === 1 ? ' record selected' : ' records selected');
  });
}
/* Controls whose handler is attached once, at start-up.

   These were all built with a working function behind them, but nothing ever
   called it — the buttons rendered, did nothing when clicked, and no test
   noticed because every test asked "does the function exist" rather than "is
   anything wired to it". dead.test.js now asks the second question. */
function wireBulkButtons() {
  /* Bulk edit — three bars, three buttons each. */
  Object.keys(BULK_TABLES).forEach(function (t) {
    var sfx = BULK_TABLES[t].sfx;
    var e = $('#bulkEdit' + sfx), d = $('#bulkDel' + sfx), c = $('#bulkClear' + sfx);
    if (e) e.onclick = function () { openBulk(t); };
    if (d) d.onclick = function () { deleteBulk(t); };
    if (c) c.onclick = function () { clearSel(t); refreshBulkBars(); repaintSel(t); };
  });
  var apply = $('#bkApply');
  if (apply) apply.onclick = applyBulk;

  /* Dropdown lists — the whole toolbar above the list. */
  var pick = $('#lsPick');
  if (pick) pick.onchange = function () { lsKey = pick.value; renderLists(); };

  var addVal = function () {
    var box = $('#lsNew'), v = String(box.value || '').trim();
    if (!v) return;
    var cur = lsCurrent();
    if (cur.some(function (x) { return String(x).toLowerCase() === v.toLowerCase(); })) {
      A.toast('“' + v + '” is already on this list');
      box.value = '';
      return;
    }
    cur.push(v);
    box.value = '';
    lsDirty = true;
    renderLists();
    box.focus();
  };
  var addBtn = $('#lsAdd');
  if (addBtn) addBtn.onclick = addVal;
  var newBox = $('#lsNew');
  if (newBox) newBox.onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addVal(); }
  };

  var reset = $('#lsReset');
  if (reset) reset.onclick = function () {
    var def = (A.L_DEFAULT && A.L_DEFAULT[lsKey]) ? A.L_DEFAULT[lsKey].slice() : [];
    var meta = A.EDITABLE_LISTS.filter(function (e) { return e[0] === lsKey; })[0] || ['', lsKey];
    if (!def.length) { A.toast('“' + meta[1] + '” has no built-in default to go back to'); return; }
    if (!confirm('Put “' + meta[1] + '” back to the built-in list?\n\n' +
                 'Existing records keep whatever they already say — only the dropdown changes.')) return;
    if (!lsDraft) lsDraft = {};
    lsDraft[lsKey] = def;
    lsDirty = true;
    renderLists();
  };

  var save = $('#lsSave');
  if (save) save.onclick = saveLists;

  /* Connection dialog: go back to whatever config.js says. */
  var ur = $('#sUrlReset');
  if (ur) ur.onclick = function () {
    A.setApiUrl('');
    $('#s_url').value = A.apiUrl();
    syncUrlHint();
    A.toast('Using the Web App URL from config.js');
  };

  /* Rename everywhere. */
  var rn = $('#rnGo');
  if (rn) rn.onclick = doRename;
}
/* Untick without redrawing the whole table. */
function repaintSel(t) {
  var cfg = BULK_TABLES[t];
  $$(cfg.table + ' tbody input[data-sel]').forEach(function (cb) {
    cb.checked = !!sel[t][cb.dataset.sel];
    var tr = cb.closest('tr');
    if (tr) tr.classList.toggle('selrow', cb.checked);
  });
  var all = $(cfg.table + ' thead input[data-selall]');
  if (all) all.checked = false;
}
function wireRowSelection(t) {
  var tableSel = BULK_TABLES[t].table;
  var boxes = $$(tableSel + ' tbody input[data-sel]');
  pruneSel(t, boxes.map(function (cb) { return cb.dataset.sel; }));
  boxes.forEach(function (cb) {
    cb.onclick = function (e) { e.stopPropagation(); };
    cb.onchange = function () {
      toggleSel(t, cb.dataset.sel, cb.checked);
      var tr = cb.closest('tr');
      if (tr) tr.classList.toggle('selrow', cb.checked);
      refreshBulkBars();
      var all = $(tableSel + ' thead input[data-selall]');
      if (all) all.checked = false;
    };
  });
  var all = $(tableSel + ' thead input[data-selall]');
  if (all) all.onchange = function () {
    boxes.forEach(function (cb) {
      cb.checked = all.checked;
      toggleSel(t, cb.dataset.sel, all.checked);
      var tr = cb.closest('tr');
      if (tr) tr.classList.toggle('selrow', all.checked);
    });
    refreshBulkBars();
  };
}
function selCell(t, id) {
  return '<td class="selcol" onclick="event.stopPropagation()"><input type="checkbox" data-sel="' + id + '"' +
         (sel[t][id] ? ' checked' : '') + '></td>';
}
function selHead() { return '<th class="selcol"><input type="checkbox" data-selall></th>'; }

/* Which fields can be bulk-changed, and how each is entered. */
var BULK_FIELDS = {
  activities: [
    ['status',  'Status',            'list', 'status'],
    ['type',    'Activity type',     'list', 'type'],
    ['category','Category',          'list', 'cat'],
    ['level',   'Level',             'list', 'level'],
    ['mode',    'Delivery mode',     'list', 'mode'],
    ['zone',    'Zone',              'list', 'zone'],
    ['product', 'Product',           'list', 'product'],
    ['location','City',              'text', ''],
    ['partner', 'Partner / disti',   'text', ''],
    ['veeamStakeholder', 'Veeam stakeholder', 'text', ''],
    ['se',      'SE / owner',        'text', ''],
    ['audience','Target audience',   'list', 'aud'],
    ['followUpDate', 'Follow-up date', 'date', ''],
    ['outcome', 'Outcome',           'text', '']
  ],
  opportunities: [
    ['stage',    'Stage',             'list', 'stage'],
    ['zone',     'Zone',              'list', 'zone'],
    ['industry', 'Industry',          'list', 'industry'],
    ['location', 'Location',          'text', ''],
    ['veeamStakeholder', 'Internal sales', 'text', ''],
    ['partner',  'Partner',           'text', ''],
    ['partnerSales', 'Partner sales', 'text', '']
  ]
};
function openBulk(t) {
  var kind = BULK_TABLES[t].kind;
  bulkTable = t;
  bulkKind = kind;
  var n = selCount(t);
  if (!n) { A.toast('Nothing selected'); return; }
  $('#bkErr').classList.remove('show');
  $('#bkTitle').textContent = 'Edit ' + n + ' ' + (kind === 'activities' ? 'activit' + (n === 1 ? 'y' : 'ies')
                                                                        : 'opportunit' + (n === 1 ? 'y' : 'ies'));
  $('#bkNote').innerHTML = 'Tick a field to change it. <b>Only ticked fields are written</b> — everything ' +
    'else on each record stays exactly as it is. Leave a ticked field blank to clear it.' +
    (kind === 'activities' ? ' Changing the type also recalculates Enablement / Deal support.' : '');
  $('#bkFields').innerHTML = BULK_FIELDS[kind].map(function (f) {
    var input;
    if (f[2] === 'list') {
      input = '<select id="bk_' + f[0] + '" disabled><option value=""></option>' +
        (A.L[f[3]] || []).map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('') + '</select>';
    } else if (f[2] === 'date') {
      input = '<input type="date" id="bk_' + f[0] + '" disabled>';
    } else {
      input = '<input id="bk_' + f[0] + '" disabled>';
    }
    return '<div class="f"><div class="bkrow"><input type="checkbox" data-bk="' + f[0] + '">' +
           '<span class="fname">' + esc(f[1]) + '</span></div>' + input + '</div>';
  }).join('');
  $$('#bkFields [data-bk]').forEach(function (cb) {
    cb.onchange = function () {
      var el = $('#bk_' + cb.dataset.bk);
      if (el) { el.disabled = !cb.checked; if (cb.checked) el.focus(); }
    };
  });
  $('#ovBulk').classList.add('open');
}
function applyBulk() {
  var kind = bulkKind, t = bulkTable;
  var picked = $$('#bkFields [data-bk]').filter(function (c) { return c.checked; })
                 .map(function (c) { return c.dataset.bk; });
  if (!picked.length) { showErr('#bkErr', 'Tick at least one field to change.'); return; }
  var patch = {};
  picked.forEach(function (k) { patch[k] = ($('#bk_' + k).value || '').trim(); });

  var ids = selIds(t), out = [];
  ids.forEach(function (id) {
    var rec = kind === 'activities'
      ? S.activities.filter(function (x) { return x.id === id; })[0]
      : S.oppMap[id];
    if (!rec) return;
    var merged = Object.assign({}, rec, patch);
    if (kind === 'activities' && patch.type) {
      merged.kind = A.kindOf(patch.type);
      /* the kind decides which block of fields applies */
      if (merged.kind !== 'Enablement') { merged.category = ''; merged.level = ''; merged.audience = ''; }
      if (merged.kind !== 'Deal support') { merged.oppId = merged.oppId || ''; }
    }
    if (kind === 'activities' && (patch.partner !== undefined) && patch.partner) {
      merged.partner = S.partnerName(patch.partner);
      merged.partnerType = S.partnerType(patch.partner);
    }
    var norm = kind === 'activities' ? A.normActivity(merged) : A.normOpp(merged);
    S.upsert(kind, norm, kind === 'activities' ? A.normActivity : A.normOpp);
    out.push(norm);
  });
  $('#bkApply').disabled = true;
  S.api('bulkSave', { kind: kind, records: out }).then(function (j) {
    $('#ovBulk').classList.remove('open');
    A.toast(j.saved + ' record' + (j.saved > 1 ? 's' : '') + ' updated');
    clearSel(t); refresh(); refreshBulkBars();
  }).catch(function (e) { showErr('#bkErr', 'Saved locally but the Sheet said: ' + e.message); })
    .then(function () { $('#bkApply').disabled = false; });
}
function deleteBulk(t) {
  var kind = BULK_TABLES[t].kind;
  var ids = selIds(t), n = ids.length;
  if (!n) return;
  var what = kind === 'activities' ? 'activities' : 'opportunities';
  if (!confirm('Delete ' + n + ' ' + what + '? This cannot be undone.' +
      (kind === 'opportunities' ? '\n\nTheir activities stay in the log but become unlinked.' : ''))) return;
  ids.forEach(function (id) { S.remove(kind, id); });
  S.api('bulkDelete', { kind: kind, ids: ids }).then(function (j) {
    A.toast((j.deleted || n) + ' deleted');
    clearSel(t); refresh(); refreshBulkBars();
  }).catch(function (e) { A.toast('Delete failed: ' + e.message, 6000); });
}

/* ====================================================================== */
/*  DROPDOWN LISTS                                                        */
/* ====================================================================== */
var lsKey = 'type', lsDraft = null, lsDirty = false;

function lsCurrent() {
  if (!lsDraft) lsDraft = {};
  if (!lsDraft[lsKey]) lsDraft[lsKey] = (A.L[lsKey] || []).slice();
  return lsDraft[lsKey];
}
function renderLists() {
  var pick = $('#lsPick');
  if (!pick.options.length) {
    pick.innerHTML = A.EDITABLE_LISTS.map(function (e) {
      return '<option value="' + e[0] + '">' + esc(e[1]) + '</option>';
    }).join('');
    pick.value = lsKey;
  }
  var meta = A.EDITABLE_LISTS.filter(function (e) { return e[0] === lsKey; })[0] || ['', '', ''];
  $('#lsHint').textContent = meta[2] || '';
  var vals = lsCurrent();
  var rows = vals.map(function (v, i) {
    var used = S.usageOf(lsKey, v);
    var col = (lsKey === 'stage' ? A.STAGE_COLOR[v] : lsKey === 'type' ? A.TYPE_COLOR[v]
             : lsKey === 'status' ? A.STATUS_COLOR[v] : lsKey === 'level' ? A.LEVEL_COLOR[v] : null);
    return '<div class="lsrow" data-i="' + i + '">' +
      '<span class="lsdot" style="background:' + (col || '#DBDEE1') + '"></span>' +
      '<span class="lsv">' + esc(v) + '</span>' +
      '<span class="lsu">' + (used ? used + ' in use' : '<span class="src">unused</span>') + '</span>' +
      '<span class="lsact">' +
        '<button class="btn sm" data-up="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="btn sm" data-dn="' + i + '" title="Move down"' + (i === vals.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button class="btn sm" data-rn="' + i + '">Rename…</button>' +
        '<button class="btn sm dg" data-rm="' + i + '" title="' +
          (used ? 'Still used by ' + used + ' records' : 'Remove from the list') + '"' +
          (used ? ' disabled' : '') + '>Remove</button>' +
      '</span></div>';
  }).join('');
  $('#lsRows').innerHTML = vals.length
    ? '<div class="lstable">' + rows + '</div>' +
      '<div class="hint2">A value still in use can\'t be removed — rename it into another value instead, ' +
      'which moves every record across. Order here is the order you\'ll see in every dropdown.</div>'
    : '<div class="empty">This list is empty.</div>';
  $('#lsDirty').textContent = lsDirty ? 'unsaved changes' : '';
  $('#lsDirty').style.color = 'var(--amber)';
  $('#lsSave').classList.toggle('p', lsDirty);

  $$('#lsRows [data-up]').forEach(function (b) {
    b.onclick = function () { var i = +b.dataset.up; var v = lsCurrent();
      v.splice(i - 1, 0, v.splice(i, 1)[0]); lsDirty = true; renderLists(); };
  });
  $$('#lsRows [data-dn]').forEach(function (b) {
    b.onclick = function () { var i = +b.dataset.dn; var v = lsCurrent();
      v.splice(i + 1, 0, v.splice(i, 1)[0]); lsDirty = true; renderLists(); };
  });
  $$('#lsRows [data-rm]').forEach(function (b) {
    b.onclick = function () { lsCurrent().splice(+b.dataset.rm, 1); lsDirty = true; renderLists(); };
  });
  $$('#lsRows [data-rn]').forEach(function (b) {
    b.onclick = function () { openRename(lsCurrent()[+b.dataset.rn]); };
  });
}
function openRename(from) {
  var used = S.usageOf(lsKey, from);
  var meta = A.EDITABLE_LISTS.filter(function (e) { return e[0] === lsKey; })[0] || ['', lsKey];
  $('#rnErr').classList.remove('show');
  $('#rn_from').value = from;
  $('#rn_to').value = from;
  $('#dl_rn').innerHTML = lsCurrent().filter(function (v) { return v !== from; })
    .map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
  $('#rnNote').innerHTML = used
    ? 'Renaming in <b>' + esc(meta[1]) + '</b>. This will update <b>' + used + ' record' +
      (used > 1 ? 's' : '') + '</b> in the Sheet as well as the list itself. ' +
      'If you type a value that already exists, the two are <b>merged</b>.' +
      (lsKey === 'type' ? ' Enablement / Deal support tags are recalculated afterwards.' : '')
    : 'Nothing uses <b>' + esc(from) + '</b> yet, so this only changes the list.';
  $('#ovRename').classList.add('open');
  setTimeout(function () { $('#rn_to').select(); }, 60);
}
function doRename() {
  var from = $('#rn_from').value, to = $('#rn_to').value.trim();
  if (!to) { showErr('#rnErr', 'Type the new value.'); return; }
  if (to === from) { $('#ovRename').classList.remove('open'); return; }
  $('#rnGo').disabled = true;
  S.api('renameValue', { list: lsKey, from: from, to: to }).then(function (j) {
    $('#ovRename').classList.remove('open');
    A.toast(j.changed
      ? 'Renamed — ' + j.changed + ' record' + (j.changed > 1 ? 's' : '') + ' updated'
      : 'Renamed in the list');
    lsDraft = null; lsDirty = false;
    return S.bootstrap(Auth.token());
  }).then(function () {
    buildFilters(); renderLists(); render();
  }).catch(function (e) { showErr('#rnErr', e.message); })
    .then(function () { $('#rnGo').disabled = false; });
}
function saveLists() {
  var payload = {};
  A.EDITABLE_LISTS.forEach(function (e) {
    payload[e[0]] = (lsDraft && lsDraft[e[0]]) ? lsDraft[e[0]] : (A.L[e[0]] || []).slice();
  });
  $('#lsSave').disabled = true;
  S.api('saveLists', { lists: payload }).then(function () {
    A.toast('Lists saved — every dropdown on the site now uses them');
    lsDirty = false;
    return S.bootstrap(Auth.token());
  }).then(function () {
    lsDraft = null;
    buildFilters(); renderLists(); render();
  }).catch(function (e) { A.toast('Could not save: ' + e.message, 6000); })
    .then(function () { $('#lsSave').disabled = false; });
}

/* ====================================================================== */
/*  IMPORT / SETTINGS                                                     */
/* ====================================================================== */
function previewImport(text) {
  try {
    var j = JSON.parse(text);
    importPayload = j;
    $('#impPreview').textContent = 'Ready: ' + ['activities','opportunities','availability','partners','layout']
      .map(function (k) { return (j[k] || []).length + ' ' + k; }).join(' · ');
    $('#impGo').disabled = false;
    $('#impErr').classList.remove('show');
  } catch (e) {
    importPayload = null; $('#impGo').disabled = true; $('#impPreview').textContent = '';
    showErr('#impErr', 'Not valid JSON: ' + e.message);
  }
}
/**
 * Imports one entity at a time rather than in one big request. Smaller payloads
 * are far more reliable through Apps Script, and if a part fails you are told
 * which one and what the server actually said — instead of "import failed".
 */
function runImport() {
  if (!importPayload) return;
  if (!confirm('This replaces everything currently in the Google Sheet. Continue?')) return;
  var p = importPayload;
  /* Big arrays go up in batches, so no single request is large. The first batch
     of each part clears the tab; the rest append. */
  var BATCH = 60;
  var parts = [];
  [['activities', p.activities], ['opportunities', p.opportunities],
   ['partners', p.partners], ['availability', p.availability]].forEach(function (x) {
    var name = x[0], arr = x[1] || [];
    if (!arr.length) return;
    for (var k = 0; k < arr.length; k += BATCH) {
      var slice = arr.slice(k, k + BATCH);
      parts.push({ part: name, records: slice, wipe: k === 0,
                   label: name + (arr.length > BATCH ? ' ' + (k + 1) + '–' + (k + slice.length) : ''),
                   n: slice.length });
    }
  });
  if (p.lists && Object.keys(p.lists).length)
    parts.push({ part: 'lists', records: p.lists, wipe: true, label: 'lists', n: Object.keys(p.lists).length });
  if (p.layout && p.layout.length)
    parts.push({ part: 'layout', records: p.layout, wipe: true, label: 'layout', n: p.layout.length });

  $('#impGo').disabled = true;
  $('#impErr').classList.remove('show');
  $('#impOk').classList.remove('show');
  var out = $('#impPreview');
  var done = [], i = 0;

  var step = function () {
    if (i >= parts.length) {
      /* Every batch is in the Sheet by now. What follows is only re-reading it
         to redraw the page, so a failure here is NOT an import failure — say so,
         and never let it be blamed on a batch that already succeeded. */
      out.innerHTML = '<span class="spin"></span> reloading…';
      return S.bootstrap(Auth.token()).catch(function (e) {
        e.__reported = true;
        showErr('#impErr',
          '<b>Your data imported fine</b> — all ' + parts.length + ' parts are in the Sheet. ' +
          'The page then failed to read it back: ' + esc(e.message) +
          '<br><br>This is a problem with the Apps Script, not your data. Paste the latest ' +
          '<b>apps-script/Code.gs</b>, then <b>Deploy &rarr; Manage deployments &rarr; pencil &rarr; ' +
          'Version: New version &rarr; Deploy</b>, then reload this page. Do not re-import.');
        out.innerHTML = done.map(function (d) { return '✓ ' + esc(d); }).join('<br>');
        throw e;
      }).then(function () {
        var o = $('#impOk');
        o.innerHTML = '<b>Import complete.</b> ' + S.activities.length + ' activities, ' +
          S.opportunities.length + ' opportunities, ' + S.availability.length +
          ' availability days, ' + S.partners.length + ' partners.';
        o.classList.add('show');
        out.innerHTML = '';
        A.toast('Import complete');
        $('#ovImp').classList.remove('open');
        layout = normLayout(S.layout);
        buildFilters(); render();
      });
    }
    var pt = parts[i];
    out.innerHTML = done.map(function (d) { return '✓ ' + esc(d); }).join('<br>') +
      (done.length ? '<br>' : '') + '<span class="spin"></span> ' + esc(pt.label) + ' — ' +
      pt.n + ' records… <span class="src">(' + (i + 1) + ' of ' + parts.length + ')</span>';
    return S.api('importPart', { part: pt.part, records: pt.records, wipe: pt.wipe }).then(function (j) {
      done.push(pt.label + ' — ' + (j.written != null ? j.written : pt.n));
      i++;
      return step();
    }).catch(function (e) {
      /* step() recurses, so every level sees a failure from a deeper level. Only
         the level that actually failed may report it — otherwise the message ends
         up blaming batch 1 for something that went wrong at the very end. */
      if (e.__reported) throw e;
      /* An older deployed Apps Script has no importPart. Fall back to the
         single-request import it does understand, rather than dead-ending. */
      if (/unknown action/i.test(e.message) && i === 0) return legacyImport();
      e.__reported = true;
      var extra = /unknown action/i.test(e.message)
        ? '<br><br><b>This means your Apps Script is out of date.</b> Paste the latest ' +
          '<b>apps-script/Code.gs</b>, then <b>Deploy &rarr; Manage deployments &rarr; pencil &rarr; ' +
          'Version: New version &rarr; Deploy</b>.' : '';
      showErr('#impErr', 'Failed on <b>' + esc(pt.label) + '</b> (' + pt.n + ' records): ' + esc(e.message) + extra +
        (done.length ? '<br><br>Already imported: ' + esc(done.join(', ')) +
                       '. Fix the problem and run the import again — it replaces, so re-running is safe.'
                     : ''));
      out.innerHTML = done.map(function (d) { return '✓ ' + esc(d); }).join('<br>');
      throw e;
    });
  };

  /* Old backend: one big request. Slower and riskier, but it works, and we tell
     you afterwards that redeploying will make this smoother. */
  var legacyImport = function () {
    out.innerHTML = '<span class="spin"></span> your Apps Script is an older version — ' +
                    'importing the old way, this may take a minute…';
    return S.api('importAll', p).then(function () {
      return S.bootstrap(Auth.token());
    }).then(function () {
      var o = $('#impOk');
      o.innerHTML = '<b>Import complete.</b> ' + S.activities.length + ' activities, ' +
        S.opportunities.length + ' opportunities, ' + S.availability.length + ' availability days.' +
        '<br><br><b>Worth doing:</b> your Apps Script is out of date. Paste the latest ' +
        '<b>apps-script/Code.gs</b> and <b>Deploy &rarr; Manage deployments &rarr; pencil &rarr; ' +
        'New version &rarr; Deploy</b> — the newer import is far more reliable.';
      o.classList.add('show');
      out.innerHTML = '';
      A.toast('Import complete');
      layout = normLayout(S.layout);
      buildFilters(); render();
    }).catch(function (e) {
      showErr('#impErr', 'Import failed: ' + esc(e.message) +
        '<br><br>Your Apps Script is an older version. Paste the latest <b>apps-script/Code.gs</b>, ' +
        'then <b>Deploy &rarr; Manage deployments &rarr; pencil &rarr; Version: New version &rarr; ' +
        'Deploy</b>, reload this page and try again.');
      out.innerHTML = '';
      throw e;
    });
  };

  step().catch(function () { A.toast('Import stopped — see the message above', 5000); })
        .then(function () { $('#impGo').disabled = false; });
}
function openSettings() {
  $('#s_url').value = A.apiUrl();
  syncUrlHint();
  $('#s_tok').value = Auth.token();
  $('#setOk').classList.remove('show'); $('#setErr').classList.remove('show');
  $('#ovSet').classList.add('open');
}

/* ====================================================================== */
/*  SHELL                                                                 */
/* ====================================================================== */
function render() {
  var a = fActs().length, o = fOpps().length;
  $('#fCount').textContent = a + ' activities · ' + o + ' opportunities in filter';
  $('#gbar').classList.toggle('hide', curTab === 'avail' || curTab === 'data');
  if (curTab === 'dash') renderDash();
  if (curTab === 'log') renderLog();
  if (curTab === 'events') renderEvents();
  if (curTab === 'pipe') renderPipe();
  if (curTab === 'avail') renderAvail();
  if (curTab === 'data') renderData();
}
function refresh() { S.reindex(); buildFilters(); render(); }
function setTab(t) {
  curTab = t;
  $$('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
  ['dash','log','events','pipe','avail','data'].forEach(function (k) {
    $('#pane-' + k).classList.toggle('hide', k !== t);
  });
  render();
}
function start() {
  wireBulkButtons();          /* nine buttons that had no handler until v18 */
  $('#subline').textContent = (CFG.ownerName || '') + (CFG.ownerRole ? ' · ' + CFG.ownerRole : '');
  $('#srcLabel').textContent = S.activities.length + ' activities · ' + S.opportunities.length + ' opportunities';
  $('#footer').innerHTML = esc(CFG.ownerName) + ' · all times ' + esc(CFG.timezoneLabel) +
    ' · everything stored in your private Google Sheet · <b>v24</b>';
  layout = normLayout(S.layout && S.layout.length ? S.layout : defaultLayout());

  /* The commonest upgrade mistake: new Code.gs pasted, but no new deployment. */
  if (S.backend && S.backend < A.NEEDS_BACKEND) {
    var wb = $('#banner');
    wb.classList.remove('hide');
    wb.innerHTML = '<b>Your Google Sheet script is out of date.</b> This page is v' + A.NEEDS_BACKEND +
      ' but the deployed script is v' + S.backend + ', so some things will not save. ' +
      'Paste the latest <b>apps-script/Code.gs</b>, then <b>Deploy &rarr; Manage deployments &rarr; ' +
      'pencil &rarr; Version: New version &rarr; Deploy</b>.';
  } else if (!S.backend) {
    var wb2 = $('#banner');
    wb2.classList.remove('hide');
    wb2.innerHTML = '<b>Your Google Sheet script is from an older version.</b> Update ' +
      '<b>apps-script/Code.gs</b> and redeploy a <b>New version</b> — otherwise dropdown lists, ' +
      'bulk edit and Outlook sync will not work.';
  }

  if (!S.activities.length && !S.opportunities.length) {
    var b = $('#banner');
    b.classList.remove('hide');
    b.innerHTML = '<b>Your Sheet is empty.</b> Use <b>Tools → First-time data import</b> and pick ' +
      '<b>seed-private-data-v4.json</b>.<button class="btn sm" id="bImp">Import now</button>';
    $('#bImp').onclick = function () { $('#ovImp').classList.add('open'); };
  }
  buildFilters();
  var next = S.activities.map(function (r) { return r.date; }).filter(function (d) { return d >= A.today(); }).sort()[0];
  var last = S.activities.map(function (r) { return r.date; }).filter(Boolean).sort().pop();
  var anchor = next || last;
  if (anchor) { calCursor = A.dateObj(anchor); avCursor = A.dateObj(anchor); }
  setTab('dash');
  console.log('[app] ready —', S.activities.length, 'activities,', S.opportunities.length,
              'opportunities,', S.availability.length, 'availability days,', layout.filter(function (l) { return l.on; }).length, 'panels on');
}

/* ------------------------------------------------------------- wiring */
function wire() {
  $('#gateGo').onclick = function () { unlock(cleanTok($('#gateTok').value), $('#gateRemember').checked); };
  $('#gateTok').onkeydown = function (e) { if (e.key === 'Enter') $('#gateGo').click(); };

  $$('.tab').forEach(function (b) { b.onclick = function () { setTab(b.dataset.tab); }; });
  ['#fPeriod','#fQ','#fKind','#fZone','#fStake','#fPartner'].forEach(function (s) { $(s).onchange = render; });
  var t1; $('#fSearch').oninput = function () { clearTimeout(t1); t1 = setTimeout(render, 220); };
  $('#fClear').onclick = function () {
    ['#fPeriod','#fQ','#fKind','#fZone','#fStake','#fPartner','#fSearch'].forEach(function (s) { $(s).value = ''; });
    render();
  };

  /* dashboard customise */
  $('#btnCust').onclick = function () {
    var c = $('#custbar');
    c.classList.toggle('hide');
    $('#btnCust').textContent = c.classList.contains('hide') ? 'Customise dashboard' : 'Done customising';
  };
  $('#pAll').onclick = function () { layout.forEach(function (l) { l.on = 1; }); layoutDirty = true; renderDash(); };
  $('#pNone').onclick = function () { layout.forEach(function (l) { l.on = 0; }); layoutDirty = true; renderDash(); };
  $('#pReset').onclick = function () { layout = defaultLayout(); layoutDirty = true; renderDash(); };
  $('#pSave').onclick = saveLayout;

  /* log tab */
  $$('#logSeg button').forEach(function (b) {
    b.onclick = function () {
      logView = b.dataset.lv;
      $$('#logSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderLog();
    };
  });
  ['#lType','#lStatus','#lMode','#lLinked'].forEach(function (s) { $(s).onchange = renderLog; });
  $('#lNew').onclick = function () { openAct(); };
  $('#mPrev').onclick = function () { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderLog(); };
  $('#mNext').onclick = function () { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderLog(); };
  $('#mToday').onclick = function () { calCursor = new Date(); renderLog(); };
  $('#shadeAvail').onchange = renderLog;

  /* events tab */
  ['#eType','#eCat','#eAud','#eMode','#eStatus'].forEach(function (s) { $(s).onchange = renderEvents; });
  $('#eNew').onclick = function () { openAct(null, 'Training'); };

  /* pipeline tab */
  $$('#pipeSeg button').forEach(function (b) {
    b.onclick = function () {
      pipeView = b.dataset.pv;
      $$('#pipeSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderPipe();
    };
  });
  ['#pState','#pStage','#pProd','#pInd','#pFlag'].forEach(function (s) { $(s).onchange = renderPipe; });
  $('#pNew').onclick = function () { openOpp(); };

  /* availability */
  $('#aPrev').onclick = function () { avCursor = new Date(avCursor.getFullYear(), avCursor.getMonth() - 1, 1); renderAvail(); };
  $('#aNext').onclick = function () { avCursor = new Date(avCursor.getFullYear(), avCursor.getMonth() + 1, 1); renderAvail(); };
  $('#aToday').onclick = function () { avCursor = new Date(); renderAvail(); };
  $('#aSave').onclick = saveMonth;
  $$('[data-brush]').forEach(function (b) {
    b.onclick = function () {
      brush = b.dataset.brush;
      $$('[data-brush]').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    };
  });
  document.addEventListener('mouseup', function () { painting = false; });
  $('#dApply').onclick = applyDay;
  $('#d_full').onchange = syncDayHint;
  $('#d_city').oninput = syncDayHint;
  $('#d_notes').oninput = syncDayHint;
  $('#bTemplate').onclick = applyTemplate;
  $('#bEditTpl').onclick = openTpl;
  $('#rApply').onclick = applyRange;
  $$('[data-tbrush]').forEach(function (b) {
    b.onclick = function () {
      tplBrush = b.dataset.tbrush;
      $$('[data-tbrush]').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    };
  });
  $('#tplSave').onclick = function () {
    saveTpl();
    $('#ovTpl').classList.remove('open');
    A.toast('Usual week saved — use "Apply my usual week" on any month');
  };
  $('#tplClear').onclick = function () {
    if (!confirm('Clear the weekly template?')) return;
    tpl = {}; saveTpl(); renderTpl();
  };
  $('#bFromActs').onclick = function () {
    var n = 0;
    monthDates().forEach(function (ds) {
      S.activities.filter(function (r) { return r.date === ds && r.status !== 'Cancelled'; }).forEach(function (r) {
        if (blockBusy(ds, r.startTime, r.endTime)) { n++; dirtyDays[ds] = 1; }
      });
    });
    renderAvail(); A.toast(n ? n + ' activities blocked out as Busy' : 'Nothing logged this month');
  };
  $('#bFromOutlook').onclick = function () {
    if (!S.outlookOn()) { A.toast('No Outlook data yet — connect it from the Data tab'); return; }
    var n = 0;
    monthDates().forEach(function (ds) {
      var av = S.availMap[ds] || A.normAvail({ date: ds });
      if (av.fullDay) return;
      A.slotList().forEach(function (s) {
        if (S.outlookAt(ds, s) && av.slots[s] !== 'Busy') { av.slots[s] = 'Busy'; n++; }
      });
      S.upsertAvail(av); dirtyDays[ds] = 1;
    });
    renderAvail();
    A.toast(n ? n + ' slots set to Busy from Outlook — click Save month to keep them'
              : 'Nothing new to block this month');
  };
  $('#syncOutlook').onclick = function () {
    var b = $('#syncOutlook');
    b.disabled = true;
    var old = b.textContent;
    b.textContent = 'Syncing…';
    S.api('syncOutlook', {}).then(function (j) {
      S.outlook = (j.outlook || []).map(function (o) {
        return { date: String(o.date || '').slice(0, 10), start: o.start || '00:00',
                 end: o.end || '23:59', allDay: !!o.allDay, source: o.source || '' };
      }).filter(function (o) { return o.date; });
      S.outlookStatus = j.outlookStatus || S.outlookStatus;
      S.reindex(); render();
      A.toast('Outlook synced — ' + S.outlook.length + ' busy blocks');
    }).catch(function (e) { A.toast('Sync failed: ' + e.message, 6000); })
      .then(function () { b.disabled = false; b.textContent = old; });
  };
  $('#showOutlook').onchange = renderLog;
  $('#bClearMonth').onclick = function () {
    if (!confirm('Clear all availability for ' + A.MONTHS_FULL[avCursor.getMonth()] + ' ' + avCursor.getFullYear() + '?')) return;
    monthDates().forEach(function (ds) { S.upsertAvail(A.normAvail({ date: ds })); dirtyDays[ds] = 1; });
    renderAvail();
  };

  /* activity form */
  $('#a_type').onchange = function () { applyKind(); syncAct(); };
  $('#a_level').onchange = syncAct;
  ['#a_start','#a_end','#a_regs','#a_att','#a_uniq','#a_date'].forEach(function (s) { $(s).oninput = syncAct; });
  $('#a_dur').oninput = function () { $('#a_dur').dataset.auto = '0'; };
  $('#actSave').onclick = function () { saveAct(''); };
  $('#actSaveIcs').onclick = function () { saveAct('ics'); };
  $('#actSaveNew').onclick = function () { saveAct('again'); };
  $('#actDel').onclick = function () {
    if (!editAct || !confirm('Delete this activity?')) return;
    var id = editAct;
    S.remove('activities', id);
    S.api('deleteActivity', { id: id }).then(function () {
      $('#ovAct').classList.remove('open'); A.toast('Activity deleted'); refresh();
    }).catch(function (e) { showErr('#actErr', e.message); });
  };

  /* opportunity form */
  $('#oppSave').onclick = function () { saveOpp(false); };
  $('#oppSaveLog').onclick = function () { saveOpp(true); };
  $('#oppDel').onclick = function () {
    if (!editOpp) return;
    var o = S.oppMap[editOpp];
    if (!confirm('Delete "' + (o ? o.customer : '') + '"? Its ' + (o ? o.touchCount : 0) +
                 ' activities stay in the log but become unlinked.')) return;
    var id = editOpp;
    S.remove('opportunities', id);
    S.api('deleteOpportunity', { id: id }).then(function () {
      $('#ovOpp').classList.remove('open'); A.toast('Opportunity deleted'); refresh();
    }).catch(function (e) { showErr('#oppErr', e.message); });
  };
  $('#vEdit').onclick = function () { $('#ovView').classList.remove('open'); openOpp(viewOpp); };
  $('#vLog').onclick = function () {
    $('#ovView').classList.remove('open');
    openAct(null, 'Meeting');
    setOppPick(viewOpp);
    syncAct();
  };

  /* partners */
  $('#ptrNew').onclick = function () { openPtr(); };
  $('#ptrSave').onclick = savePtr;
  var t2; $('#ptrSearch').oninput = function () { clearTimeout(t2); t2 = setTimeout(renderPartners, 200); };
  $('#ptrDel').onclick = function () {
    if (!editPtr || !confirm('Remove from the master list? Existing records keep the name.')) return;
    var k = editPtr;
    S.partners = S.partners.filter(function (p) { return p.key !== k; });
    S.api('deletePartner', { key: k }).then(function () {
      $('#ovPtr').classList.remove('open'); A.toast('Partner removed'); refresh();
    }).catch(function (e) { showErr('#ptrErr', e.message); });
  };

  /* quick-log menu */
  $$('[data-quick]').forEach(function (b) { b.onclick = function () { openAct(null, b.dataset.quick); }; });
  $$('[data-new]').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.new === 'opp') openOpp();
      if (b.dataset.new === 'partner') openPtr();
    };
  });

  /* dropdowns */
  $$('[data-ddtoggle]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); b.closest('.dd').classList.toggle('open'); };
  });
  document.addEventListener('click', function () { $$('.dd').forEach(function (d) { d.classList.remove('open'); }); });

  /* tools */
  $$('.dd-menu [data-act]').forEach(function (b) {
    b.onclick = function () {
      var a = b.dataset.act;
      if (a === 'csv-act') { A.download('activity-log.csv', A.csvOf(fActs(), A.CSV_ACT), 'text/csv'); A.toast('CSV downloaded'); }
      if (a === 'csv-opp') { A.download('opportunities.csv', A.csvOf(fOpps(), A.CSV_OPP), 'text/csv'); A.toast('CSV downloaded'); }
      if (a === 'ics') A.downloadIcs(S.activities.filter(function (r) {
        return r.date >= A.today() && r.status !== 'Cancelled'; }), 'upcoming');
      if (a === 'backup') {
        A.download('workspace-backup-' + A.today() + '.json', JSON.stringify({
          generated: new Date().toISOString(), activities: S.activities, opportunities: S.opportunities,
          availability: S.availability, partners: S.partners, layout: layout }, null, 1), 'application/json');
        A.toast('Backup downloaded — keep it private');
      }
      if (a === 'import') $('#ovImp').classList.add('open');
      if (a === 'settings') openSettings();
      if (a === 'print') window.print();
      if (a === 'lock') lock();
    };
  });
  $('#btnReload').onclick = function () {
    $('#btnReload').disabled = true;
    S.bootstrap(Auth.token()).then(function () {
      layout = normLayout(S.layout && S.layout.length ? S.layout : layout);
      layoutDirty = false; refresh(); A.toast('Reloaded from the Sheet');
    }).catch(function (e) { A.toast(e.message, 5000); })
      .then(function () { $('#btnReload').disabled = false; });
  };

  /* import + settings */
  $('#impTxt').oninput = function () { if ($('#impTxt').value.trim()) previewImport($('#impTxt').value); };
  $('#impFile').onchange = function () {
    var f = $('#impFile').files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { $('#impTxt').value = ''; previewImport(String(fr.result)); };
    fr.readAsText(f);
  };
  $('#impGo').onclick = runImport;
  $('#sTest').onclick = function () {
    A.setApiUrl($('#s_url').value);
    syncUrlHint();
    S.api('ping', {}, cleanTok($('#s_tok').value)).then(function (j) {
      $('#setErr').classList.remove('show');
      var o = $('#setOk');
      o.textContent = 'Connected. Sheet holds ' + j.counts.activities + ' activities, ' +
        j.counts.opportunities + ' opportunities, ' + j.counts.availability + ' availability days.';
      o.classList.add('show');
    }).catch(function (e) { $('#setOk').classList.remove('show'); showErr('#setErr', e.message); });
  };
  $('#sSave').onclick = function () {
    A.setApiUrl($('#s_url').value);      /* a redeploy can change this — no file edit needed */
    Auth.set(cleanTok($('#s_tok').value), $('#s_remember').checked);
    A.toast('Token saved'); $('#sTest').click();
  };
  $('#sForget').onclick = lock;

  /* modals */
  $$('[data-close]').forEach(function (b) { b.onclick = function () { b.closest('.ov').classList.remove('open'); }; });
  $$('.ov').forEach(function (o) { o.onclick = function (e) { if (e.target === o) o.classList.remove('open'); }; });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $$('.ov').forEach(function (o) { o.classList.remove('open'); });
  });
  window.addEventListener('beforeunload', function (e) {
    if (Object.keys(dirtyDays).length || layoutDirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ====================================================================== */
/*  SELF-CHECK  — tells you exactly which setup step is incomplete        */
/* ====================================================================== */
/* Say plainly which URL is in force, because a stale one is invisible
   otherwise — the page just fails to log in and blames the token. */
function syncUrlHint() {
  var el = $('#s_urlHint');
  if (!el) return;
  var over = A.apiIsOverridden();
  el.innerHTML = over
    ? 'Set here, in this browser — this <b>overrides config.js</b>. ' +
      'Press <b>Use config.js URL</b> to go back to the file.'
    : 'Coming from <b>config.js</b>. Redeployed the Apps Script and got a new URL? ' +
      'Paste it here and press Save — no need to touch GitHub.';
}

function runDiagnostics() {
  var box = $('#diag');
  box.classList.remove('hide');
  var rows = [];
  var add = function (state, title, fix) {
    var ic = state === 'ok' ? '<span class="ic2 ok2">✓</span>'
           : state === 'warn' ? '<span class="ic2 wa2">!</span>'
           : '<span class="ic2 no2">✗</span>';
    rows.push('<div class="row">' + ic + '<div class="tx"><b>' + title + '</b>' +
              (fix ? '<div class="fix">' + fix + '</div>' : '') + '</div></div>');
  };

  /* --- files --- */
  rows.push('<div class="hdr">Files</div>');
  var cssOk = false;
  try {
    var probe = document.createElement('div');
    probe.className = 'btn';
    document.body.appendChild(probe);
    cssOk = getComputedStyle(probe).borderRadius !== '' && getComputedStyle(probe).borderRadius !== '0px';
    probe.remove();
  } catch (e) {}
  add(cssOk ? 'ok' : 'no', 'assets/style.css',
      cssOk ? null : 'Not loading. Check the <code>assets</code> folder was uploaded, with that exact lower-case name.');
  add(window.SITE_CONFIG ? 'ok' : 'no', 'config.js',
      window.SITE_CONFIG ? null : 'Not loading. It must sit next to <code>index.html</code>, not inside a folder.');
  add(window.APP ? 'ok' : 'no', 'assets/core.js',
      window.APP ? null : 'Not loading.');
  add(window.PANELS ? 'ok' : 'no', 'assets/panels.js' + (window.PANELS ? ' — ' + window.PANELS.length + ' panels' : ''),
      window.PANELS ? null : 'Not loading.');
  add('ok', 'assets/app.js — running');
  add(window.Chart ? 'ok' : 'warn', 'Chart.js from the CDN',
      window.Chart ? null : 'Blocked. The page still works; dashboard charts will be blank. Often a corporate network rule.');

  /* --- configuration --- */
  rows.push('<div class="hdr">Configuration</div>');
  var url = (window.SITE_CONFIG || {}).apiUrl || '';
  if (!url) {
    add('no', 'Google Sheet URL is not set',
        'This is almost certainly the problem. Open <code>config.js</code> in GitHub, put your Apps Script ' +
        'Web App URL between the quotes on the <code>apiUrl</code> line, and commit. ' +
        'See <b>GO-LIVE.md</b> steps 2 and 4.');
  } else if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    add('warn', 'Google Sheet URL looks wrong',
        'It should end in <code>/exec</code> and start with ' +
        '<code>https://script.google.com/macros/s/</code>. Yours is:<br><code>' + esc(url.slice(0, 90)) + '</code>');
  } else {
    add('ok', 'Google Sheet URL is set');
  }
  add(A.Auth.token() ? 'ok' : 'warn', A.Auth.token() ? 'A token is remembered on this device' : 'No token saved yet',
      A.Auth.token() ? null : 'Normal on a first visit — type it in above.');
  if (S.loaded) {
    add(S.backend >= A.NEEDS_BACKEND ? 'ok' : 'no',
        'Sheet script version' + (S.backend ? ' — v' + S.backend : ' — unknown'),
        S.backend >= A.NEEDS_BACKEND ? null
          : 'Older than this page (v' + A.NEEDS_BACKEND + '). Paste the latest <code>Code.gs</code> and ' +
            '<b>Deploy &rarr; Manage deployments &rarr; New version</b>.');
    add(S.hasOutlook ? 'ok' : 'warn', 'Outlook sync script',
        S.hasOutlook ? null : 'Optional. Add a second Apps Script file called <code>Outlook</code> ' +
          'with <code>Outlook.gs</code> if you want calendar sync.');
  }

  box.innerHTML = '<div class="diag">' + rows.join('') + '</div>' +
    (url ? '<button class="btn" id="diagPing" style="width:100%;justify-content:center;margin-top:10px">' +
           'Test the connection to your Sheet</button><div id="diagPingOut" style="margin-top:8px"></div>' : '');

  var pb = $('#diagPing');
  if (pb) pb.onclick = function () {
    var out = $('#diagPingOut');
    pb.disabled = true;
    out.innerHTML = '<span class="spin"></span> testing…';
    var tok = cleanTok($('#gateTok').value || A.Auth.token() || '');
    S.api('ping', {}, tok || 'no-token-supplied').then(function (j) {
      out.innerHTML = '<div class="diag"><div class="row"><span class="ic2 ok2">✓</span><div class="tx">' +
        '<b>Connected, and the token works.</b><div class="fix">Your Sheet holds ' +
        j.counts.activities + ' activities, ' + j.counts.opportunities + ' opportunities, ' +
        j.counts.availability + ' availability days.' +
        (j.counts.activities === 0 ? ' It is empty — after unlocking, use <b>Tools → First-time data import</b>.' : '') +
        '</div></div></div></div>';
    }).catch(function (e) {
      var m = String(e.message || e), hint;
      if (/Invalid access token/i.test(m)) {
        hint = 'The Sheet answered, so the URL is right — the <b>token</b> is wrong or missing. ' +
               'Get it from the Sheet: <b>Command Center → Show access token</b>.';
      } else if (/Could not reach/i.test(m)) {
        hint = 'The Sheet did not answer. Two usual causes: the deployment is not set to ' +
               '<b>Who has access: Anyone</b>, or the URL is from an old deployment. ' +
               'Paste your <code>/exec</code> URL into a browser tab — you should see ' +
               '<code>{"ok":false,...}</code>. If you get a Google sign-in page instead, redeploy with access Anyone.';
      } else {
        hint = 'Raw error: ' + esc(m);
      }
      out.innerHTML = '<div class="diag"><div class="row"><span class="ic2 no2">✗</span><div class="tx">' +
        '<b>Could not connect.</b><div class="fix">' + hint + '</div></div></div></div>';
    }).then(function () { pb.disabled = false; });
  };
}

/* --------------------------------------------------------------- boot */
document.addEventListener('DOMContentLoaded', function () {
  wire();
  loadTpl();
  $('#diagRun').onclick = runDiagnostics;
  $('#gateSub').textContent = CFG.ownerName
    ? 'Private workspace for ' + CFG.ownerName + '. Enter your access token.'
    : 'Private. Enter your access token to continue.';
  if (!A.apiUrl()) {
    gateMsg('err', 'Setup is not finished — your Google Sheet is not connected yet.');
    $('#gateTok').disabled = true;
    $('#gateGo').disabled = true;
    runDiagnostics();          /* show exactly what is missing, unprompted */
    return;
  }
  var tok = Auth.token();
  if (tok) {
    gateMsg('', '<span class="spin"></span> Reconnecting…');
    S.bootstrap(tok).then(function () {
      $('#gate').classList.add('hide');
      $('#app').classList.remove('hide');
      start();
    }).catch(function (e) {
      Auth.clear(); gateMsg('err', esc(e.message)); $('#gateTok').focus();
    });
  } else { $('#gateTok').focus(); }
});
})();
