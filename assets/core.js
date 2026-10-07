/* =========================================================================
   core.js — data model, Sheet client, stats, charts, exports.

   ONE activity table holds everything you do. `kind` is derived from `type`
   and is never typed by hand:
       Enablement    Training, Webinar, Session, PRT, CRT, Bootcamp, Event, Workshop
       Deal support  Call, Meeting, Demo, POC, Design Session, Follow-up
       Internal      Internal Sync
   Supporting records: opportunities (lean), availability, partners, layout.
   ========================================================================= */
(function (global) {
'use strict';

var CFG = global.SITE_CONFIG || {};

/* ------------------------------------------------------------------ lists */
var ENABLEMENT = ['Training','Webinar','Session','PRT','CRT','Bootcamp','Event','Workshop','Conference'];
var DEAL       = ['Call','Meeting','Demo','POC','Design Session','Follow-up','Email'];
var INTERNAL   = ['Internal Sync'];

var L = {
  kind:      ['Enablement','Deal support','Internal'],
  /* Filled in as you invent new values on the form — see kindOf() / stageClosed(). */
  typeEnablement: [],
  typeInternal:   [],
  stageClosed:    [],
  type:      ENABLEMENT.concat(DEAL).concat(INTERNAL),
  enablement: ENABLEMENT, dealTypes: DEAL, internalTypes: INTERNAL,
  cat:       ['Sales Enablement','Sales Training','Technical Enablement','Technical Training',
              'Technical Refreshment','Technical Bootcamp','Hands-on Technical Training',
              'Sales & Pre-Sales Enablement','Sales & Pre-Sales Refreshment','Partner Round Table',
              'Partner Led Customer Event','Webinar for Partner','Webinar for End Customer',
              'Veeam Led Customer Webinar','Veeam Led Event','Disti Led Event','Third Party Event'],
  aud:       ['Sales','Pre-Sales','Technical','Partner','End Customer','Distributor'],
  mode:      ['Online','In-person','Hybrid'],
  status:    ['Proposed','Planned','Confirmed','Completed','Rescheduled','Cancelled'],
  level:     ['Foundation','Advanced'],
  tier:      ['Registered','Silver','Gold','Platinum'],
  stage:     ['Lead','Qualification','Discussion','Feature Validation','Prove Value','Proposal',
              'Negotiation','Closed-Won','Closed-Lost'],
  product:   ['VDP','VDP + Vault','VDP + VDC','VDC Vault','VDC M365','VDC Entra ID','VDC M365+Entra ID',
              'VDC Azure','VDC Salesforce','Security AI','Agent Commander'],
  industry:  ['Financial Services','Healthcare','Pharma & Life Sciences','Manufacturing','Energy & Resources',
              'Technology & Software','IT Services & Consulting','Education','Government','Real Estate',
              'Transport & Logistics','Retail & E-commerce','Media & Entertainment','Telecom','Other'],
  zone:      ['North','South','East','West','PAN India','SAARC'],
  partnerType:['Partner','Distributor','Alliance','Internal'],
  avail:     ['Free','Busy','Travelling','Holiday','Personal'],
  quarter:   ['Q1','Q2','Q3','Q4']
};
/* Untouched copy of the built-ins, so "reset to default" always works even after
   the Sheet's Lists tab has been edited. */
var L_DEFAULT = JSON.parse(JSON.stringify(L));

/* Which lists you can edit from the site, and what each one drives. */
var EDITABLE_LISTS = [
  ['type',        'Activity type',      'Also decides Enablement / Deal support'],
  ['cat',         'Activity category',  'Enablement activities only'],
  ['level',       'Training level',     'Foundation / Advanced'],
  ['aud',         'Target audience',    'Multi-select on the activity form'],
  ['mode',        'Delivery mode',      ''],
  ['status',      'Status',             ''],
  ['stage',       'Pipeline stage',     'Order here sets the funnel and board order'],
  ['product',     'Product / solution', ''],
  ['industry',    'Industry',           ''],
  ['zone',        'Zone',               'Used by activities, opportunities and partners'],
  ['partnerType', 'Partner type',       ''],
  ['tier',        'Partner tier',       ''],
  ['typeEnablement', 'Types counted as Enablement', 'Set when you add a new type; edit to correct it'],
  ['typeInternal',   'Types counted as Internal',   'Set when you add a new type; edit to correct it'],
  ['stageClosed',    'Stages that mean closed',     'Custom stages only; "Closed-…" is automatic']
];

var MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var DOW         = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

var KIND_COLOR  = { 'Enablement':'#00D15F', 'Deal support':'#1CA8DD', 'Internal':'#8F8B90' };
/* Enablement types use the green-to-blue brand range; deal-support types use
   blue-to-purple. Warning colours are never used for categories. */
var TYPE_COLOR  = { Training:'#00D15F', Session:'#00B87E', Webinar:'#8E71F4', PRT:'#97D700', CRT:'#01B0FE',
                    Bootcamp:'#00A94C', Event:'#1CA8DD', Workshop:'#0089B8', Conference:'#505861',
                    Call:'#1CA8DD', Meeting:'#01B0FE', Demo:'#4FC3F7', POC:'#8E71F4',
                    'Design Session':'#0089B8', 'Follow-up':'#8F8B90', Email:'#929BA5', 'Internal Sync':'#DBDEE1' };
/* The funnel walks blue -> teal -> purple -> lime, ending on brand green for a win.
   Closed-Lost is the only stage allowed a warning colour. */
var STAGE_COLOR = { 'Lead':'#929BA5','Qualification':'#1CA8DD','Discussion':'#01B0FE','Feature Validation':'#00B87E',
                    'Prove Value':'#8E71F4','Proposal':'#97D700','Negotiation':'#00A94C',
                    'Closed-Won':'#00D15F','Closed-Lost':'#ED2B3D' };
var STATUS_COLOR = { Proposed:'#929BA5', Planned:'#1CA8DD', Confirmed:'#01B0FE', Completed:'#00D15F',
                     Rescheduled:'#FE8A25', Cancelled:'#ED2B3D' };
var LEVEL_COLOR  = { Foundation:'#00D15F', Advanced:'#8E71F4' };
var AVAIL_COLOR  = { Free:'#00D15F', Busy:'#ED2B3D', Travelling:'#FE8A25', Holiday:'#1CA8DD', Personal:'#8E71F4' };
/* Categorical palette — brand hues only, no warning colours. */
var PALETTE = ['#00D15F','#01B0FE','#8E71F4','#97D700','#00B87E','#1CA8DD','#00A94C','#4FC3F7',
               '#6F5BC9','#7FB800','#0089B8','#00E88C','#929BA5','#505861','#DBDEE1'];

/* -------------------------------------------------------------------- dom */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}
function toast(msg, ms) {
  var t = $('#toast'); if (!t) { console.log(msg); return; }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('on'); }, ms || 3000);
}

/* ------------------------------------------------------------------- misc */
function uid(p) { return (p || 'X') + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(); }
function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
function has(v) { return v !== '' && v != null && !isNaN(parseFloat(v)); }
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return ymd(new Date()); }
function dateObj(s) { return new Date(String(s).slice(0, 10) + 'T00:00:00'); }
function dowOf(s) { return DOW[dateObj(s).getDay()]; }
function isWeekend(s) { var d = dateObj(s).getDay(); return d === 0 || d === 6; }
/* Whether Saturday and Sunday appear at all. Absent means YES — a missing
   setting must never quietly delete two days a week from the diary. Set
   showWeekends:false in config.js only if you want a Mon-Fri view. */
function showWeekends() { return CFG.showWeekends !== false; }
/* True when this date should be hidden. */
function hiddenDay(ds) { return !showWeekends() && isWeekend(ds); }
function daysBetween(a, b) { return Math.round((dateObj(b) - dateObj(a)) / 86400000); }
function daysAgo(s) { return daysBetween(s, today()); }
function addDays(s, n) { var d = dateObj(s); d.setDate(d.getDate() + n); return ymd(d); }
function niceDate(s) {
  if (!s) return '';
  var d = dateObj(s);
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2);
}
function longDate(s) {
  if (!s) return '';
  var d = dateObj(s);
  return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
}

/* --------------------------------------------------------------- quarters */
function qOf(d) {
  if (!d) return '';
  var m = +String(d).slice(5, 7), off = (CFG.firstMonthOfQ1 || 1) - 1;
  return 'Q' + (Math.floor((((m - 1 - off) + 12) % 12) / 3) + 1);
}
function fyOf(d) {
  if (!d) return '';
  var y = +String(d).slice(0, 4), m = +String(d).slice(5, 7), off = (CFG.firstMonthOfQ1 || 1);
  return (off > 1 && m < off) ? y - 1 : y;
}
function qKey(d) { return d ? fyOf(d) + '-' + qOf(d) : ''; }
function qLabel(k) { var p = String(k).split('-'); return p[1] + " '" + String(p[0]).slice(2); }
function mOf(d) { return d ? MONTHS[+String(d).slice(5, 7) - 1] : ''; }
function mKeyLabel(k) { return MONTHS[+k.slice(5, 7) - 1] + " '" + k.slice(2, 4); }
function quarterMonths(qk) {
  var p = String(qk).split('-'), y = +p[0], qn = +p[1].slice(1), off = (CFG.firstMonthOfQ1 || 1) - 1, out = [];
  for (var i = 0; i < 3; i++) {
    var mi = off + (qn - 1) * 3 + i;
    out.push((y + Math.floor(mi / 12)) + '-' + pad((mi % 12) + 1));
  }
  return out;
}

/* ------------------------------------------------------------ time / slots */
function parseT(s) {
  if (!s) return '';
  s = String(s).trim().toUpperCase().replace(/\s+/g, ' ');
  var m = s.match(/^(\d{1,2})(?:[.:](\d{1,2}))?\s*(AM|PM)?$/);
  if (!m) return '';
  var h = +m[1], mi = m[2] ? +m[2] : 0, ap = m[3];
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return (h > 23 || mi > 59) ? '' : pad(h) + ':' + pad(mi);
}
function parseRange(str) {
  if (!str) return ['', ''];
  var p = String(str).split(/\s*(?:-|–|to)\s*/i).filter(function (x) { return x.trim(); });
  if (p.length < 2) return [parseT(p[0] || ''), ''];
  var a = p[0].trim(), b = p[1].trim();
  if (!/AM|PM/i.test(a)) { var ap = (b.match(/AM|PM/i) || [''])[0]; if (ap) a += ' ' + ap; }
  return [parseT(a), parseT(b)];
}
function fmt12(hm) {
  if (!hm) return '';
  var p = String(hm).split(':'), h = +p[0], m = +p[1];
  var ap = h >= 12 ? 'PM' : 'AM', hh = h % 12; if (hh === 0) hh = 12;
  return hh + (m ? '.' + pad(m) : '') + ' ' + ap;
}
function minsBetween(a, b) {
  if (!a || !b) return 0;
  var x = String(a).split(':'), y = String(b).split(':');
  var d = (+y[0] * 60 + +y[1]) - (+x[0] * 60 + +x[1]);
  return d < 0 ? d + 1440 : d;
}
function addMins(hm, n) {
  var p = String(hm).split(':'), t = (+p[0] * 60 + +p[1] + n + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
function durLabel(a, b) {
  var d = minsBetween(a, b); if (!d) return '';
  if (d < 120) return d + ' Min';
  var h = Math.floor(d / 60), m = d % 60;
  return h + ' Hr' + (h > 1 ? 's' : '') + (m ? ' ' + m + ' Min' : '');
}
/** Minutes an activity consumed. Untimed rows fall back to the config default. */
function actMinutes(a) {
  var m = minsBetween(a.startTime, a.endTime);
  return m || (CFG.defaultActivityMinutes || 60);
}
function isTimed(a) { return !!(a.startTime && a.endTime); }
/**
 * How a whole-day status should read.
 *   Personal   -> "Personal (PTO)"
 *   Travelling -> "Travelling — Bangalore · Partner meetings"
 * `short` is for the tight corner tag on the month calendar.
 */
/* Most travel days were migrated with the city written into the day note
   ("round table in Jammu") rather than into its own column. Rather than show
   a bare "Travelling", look for a place you demonstrably visit — the list is
   built from your own records, so this can only ever surface a real one, never
   invent a city. Nothing is written back; the Sheet is left as you have it. */
var _cityList = null;
function knownPlaces() {
  if (_cityList) return _cityList;
  var s = {};
  Store.activities.forEach(function (a) { if (a.location) s[String(a.location).trim()] = 1; });
  Store.opportunities.forEach(function (o) { if (o.location) s[String(o.location).trim()] = 1; });
  Store.availability.forEach(function (a) { if (a.travelCity) s[String(a.travelCity).trim()] = 1; });
  /* Longest first, so "Navi Mumbai" wins over "Mumbai". */
  _cityList = Object.keys(s).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
  return _cityList;
}
function forgetPlaces() { _cityList = null; }
function travelCityOf(av) {
  var c = String((av && av.travelCity) || '').trim();
  if (c) return c;
  var note = String((av && av.notes) || '');
  if (!note) return '';
  var list = knownPlaces();
  for (var i = 0; i < list.length; i++) {
    var re = new RegExp('\\b' + list[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(note)) return list[i];
  }
  return '';
}

/* Four shapes of the same thing:
     short  a corner tag             "Jammu"
     bare   the status, and nothing else but the place — what the calendar
            shows, because a day you are away is not a day for meeting chips
     long   bare plus the day note   — for the availability grid row
     title  the full story, on hover                                        */
function fullDayLabel(av) {
  if (!av || !av.fullDay) return { short: '', bare: '', long: '', title: '' };
  var f = av.fullDay, city = travelCityOf(av), note = String(av.notes || '').trim();
  var mk = function (short, bare) {
    return { short: short, bare: bare,
             long: bare + (note ? ' · ' + note : ''),
             title: bare + (note ? ' — ' + note : '') };
  };
  if (f === 'Personal')   return mk('PTO', 'Personal (PTO)');
  if (f === 'Travelling') return mk(city || 'Travel', 'Travelling' + (city ? ' — ' + city : ''));
  if (f === 'Holiday')    return mk('Holiday', 'Holiday');
  return mk(f, f);
}

/* ------------------------------------------------------- travel & time
   Your rule: you are based in Mumbai, and any IN-PERSON activity somewhere
   else means you travelled for it.

   Mode matters. A Call logged against a Delhi customer carries "Delhi" as its
   location, but you were at your desk — judging by city alone would call that
   a trip. So an activity only counts as away when it says In-person. Where the
   mode is blank we cannot tell, and we say so rather than guess. */
function homeBases() {
  var h = CFG.homeBase || 'Mumbai';          /* fallback must be lowercased too */
  return (Array.isArray(h) ? h : [h])
    .map(function (x) { return String(x).trim().toLowerCase(); })
    .filter(Boolean);
}
function isHomeCity(city) {
  var c = String(city == null ? '' : city).trim().toLowerCase();
  return !c || homeBases().indexOf(c) > -1;
}
/* 'away' — travelled for it. 'home' — did it from base. 'unknown' — no mode. */
function whereDone(a) {
  var mode = String((a && a.mode) || '').trim();
  if (mode === 'Online') return 'home';
  if (!mode) return 'unknown';
  return isHomeCity(a.location) ? 'home' : 'away';
}
function isAway(a) { return whereDone(a) === 'away'; }

/* A day counts as a travel day if you marked it Travelling, or if something
   in-person happened away from base. Both are evidence; neither is ignored. */
function travelDaysIndex() {
  var out = {};
  Store.availability.forEach(function (d) {
    if (d.fullDay === 'Travelling') out[d.date] = { marked: true, city: travelCityOf(d) };
  });
  Store.activities.forEach(function (a) {
    if (!isAway(a)) return;
    if (!out[a.date]) out[a.date] = { marked: false, city: a.location };
    else if (!out[a.date].city) out[a.date].city = a.location;
  });
  return out;
}

/* Split the time on travel days between meetings and everything else. The
   remainder is transit, waiting and the rest of the day — it is honest to call
   it unlogged rather than to claim it is all flying. */
function travelStats(acts) {
  var idx = travelDaysIndex();
  var dayH = num(CFG.workingDayHours) || 9;
  var days = Object.keys(idx).sort();
  var awayMins = 0, homeMins = 0, unknownMins = 0;
  (acts || Store.activities).forEach(function (a) {
    var m = num(a.minutes);
    var w = whereDone(a);
    if (w === 'away') awayMins += m;
    else if (w === 'home') homeMins += m;
    else unknownMins += m;
  });
  var onTravelMins = 0;
  (acts || Store.activities).forEach(function (a) { if (idx[a.date]) onTravelMins += num(a.minutes); });
  var capacity = days.length * dayH * 60;
  var cities = {};
  days.forEach(function (d) { if (idx[d].city) cities[idx[d].city] = (cities[idx[d].city] || 0) + 1; });
  return {
    days: days,
    travelDays: days.length,
    markedOnly: days.filter(function (d) { return idx[d].marked; }).length,
    detected: days.filter(function (d) { return !idx[d].marked; }).length,
    cities: cities,
    cityCount: Object.keys(cities).length,
    awayHours: +(awayMins / 60).toFixed(1),
    homeHours: +(homeMins / 60).toFixed(1),
    unknownHours: +(unknownMins / 60).toFixed(1),
    meetingHoursOnTravelDays: +(onTravelMins / 60).toFixed(1),
    otherHoursOnTravelDays: +(Math.max(0, capacity - onTravelMins) / 60).toFixed(1),
    capacityHours: +(capacity / 60).toFixed(1),
    index: idx
  };
}

function slotList() {
  var out = [], t = CFG.dayStart || '09:00', end = CFG.dayEnd || '18:00', step = CFG.slotMinutes || 30, g = 0;
  while (t !== end && g++ < 96) { out.push(t); t = addMins(t, step); }
  return out;
}

/* --------------------------------------------------------------- kind rule
   The three built-in buckets above cover the types you started with. Any type
   you invent later is recorded in the Sheet — typeEnablement / typeInternal —
   when you tell the form which bucket it belongs to, so the dashboard keeps
   counting it correctly. Anything unclaimed falls to Deal support, as before. */
function kindOf(type) {
  var t = String(type == null ? '' : type).trim();
  if ((L.typeEnablement || []).indexOf(t) > -1) return 'Enablement';
  if ((L.typeInternal   || []).indexOf(t) > -1) return 'Internal';
  if (ENABLEMENT.indexOf(t) > -1) return 'Enablement';
  if (INTERNAL.indexOf(t) > -1) return 'Internal';
  return 'Deal support';
}

/* Same idea for the pipeline. "Closed-…" is closed by name; anything else you
   invent is closed only if you said so, and that answer lives in the Sheet. */
/* Where a stage sits in the funnel. -1 for anything not on the list, so an
   unknown value can never be mistaken for progress. */
function stageRank(stage) {
  var s = String(stage == null ? '' : stage).trim();
  if (!s) return -1;
  return (L.stage || []).indexOf(s);
}

/* A deal moves forward, not back. Logging a Discussion against something that
   already reached Prove Value records the discussion in the activity history
   but leaves the opportunity where it is — otherwise every catch-up call would
   undo months of progress.

   Closing is the exception: a deal can be won or lost from any stage, so those
   always take effect. Returns the stage the opportunity should now be at. */
function advanceStage(current, proposed) {
  var cur = String(current == null ? '' : current).trim();
  var nxt = String(proposed == null ? '' : proposed).trim();
  if (!nxt) return cur;                     /* "leave unchanged" */
  if (stageClosed(nxt)) return nxt;         /* won, lost or dropped — always */
  if (stageClosed(cur)) return cur;         /* already closed; do not reopen by accident */
  var rc = stageRank(cur), rn = stageRank(nxt);
  if (rc < 0) return nxt;                   /* nothing sensible to compare against */
  if (rn < 0) return cur;                   /* unknown proposed stage — leave it be */
  return rn > rc ? nxt : cur;
}

function stageClosed(stage) {
  var s = String(stage == null ? '' : stage).trim();
  if (!s) return false;
  if ((L.stageClosed || []).indexOf(s) > -1) return true;
  return s.indexOf('Closed') === 0;
}


/* ---------------------------------------------------------- Partner COE
   The Partner Centre of Excellence readiness model, carried over from the
   standalone COE dashboard. Seven domains, 41 items. Scoring is deliberately
   identical to that tool so the percentages you have already reported do not
   move: Done counts 1, In progress a half, Blocked and Not started nothing.

   The old dashboard kept all of this in localStorage, which meant one browser
   on one machine. Here it lives in the Sheet with everything else. */
var COE_DOMAINS = [
  { code: 'SETUP', name: 'Foundation & Infrastructure Setup', short: 'Setup' },
  { code: 'A', name: 'Core Backup & Recovery',            short: 'A' },
  { code: 'B', name: 'Instant Recovery & Portability',    short: 'B' },
  { code: 'C', name: 'SureBackup & Recovery Assurance',   short: 'C' },
  { code: 'D', name: 'Cyber Resilience & Ransomware',     short: 'D' },
  { code: 'E', name: 'Modern Workloads',                  short: 'E' },
  { code: 'F', name: 'Cloud & SaaS',                      short: 'F' }
];
var COE_ITEMS = {
  SETUP: [
    "Hypervisor host(s) deployed (VMware vSphere / Microsoft Hyper-V)",
    "Alternative hypervisor host (Proxmox VE / Nutanix AHV / OpenShift)",
    "Veeam Data Platform — Backup & Replication (VBR) deployed",
    "Veeam ONE deployed for monitoring & reporting",
    "Veeam Software Appliance (hardened) deployed",
    "Performance backup repository configured",
    "Hardened Linux repository (immutable) configured",
    "Object storage / Data Cloud Vault configured (offsite copy)",
    "Isolated demo VLAN + SureBackup virtual lab network",
    "Internet egress configured for SaaS / cloud demos",
    "Sample workloads provisioned (Win/Linux, SQL, AD, NAS)",
    "Cloud & SaaS tenants provisioned (M365, Entra, Salesforce, Azure/AWS/GCP)",
    "Licensing applied (VDP Premium NFR)",
    "Recovery Orchestrator deployed (VDP Premium)",
    "Kubernetes cluster provisioned (for Kasten)"
  ],
  A: [
    "Image-based backup of virtual machines",
    "Physical & cloud server protection with Agents",
    "Application-aware processing & granular restore (Explorers)",
    "Replication & disaster-recovery failover",
    "3-2-1-1-0 with immutable tiering",
    "Site DR failover: VMware-to-VMware / Hyper-V-to-Hyper-V"
  ],
  B: [
    "Instant VM Recovery",
    "Instant database & file share recovery",
    "Cross-platform & multi-hypervisor restore",
    "Instant Recovery to Microsoft Azure"
  ],
  C: [
    "SureBackup automated recovery verification",
    "Clean restore with malware scanning (Secure Restore)",
    "Data Integration API — reuse backups"
  ],
  D: [
    "Immutable backups & Zero-Trust hardening",
    "Inline malware & ransomware detection",
    "Proactive threat hunting — Threat Hunter & Recon",
    "Cyber recovery orchestration",
    "Active Directory & identity forest recovery"
  ],
  E: [
    "Kubernetes data protection with Veeam Kasten",
    "NAS & unstructured data backup",
    "Enterprise applications — Oracle & SAP HANA",
    "Alternative hypervisors — Proxmox, AHV, OpenShift"
  ],
  F: [
    "Microsoft 365 backup",
    "Entra ID backup & recovery",
    "Salesforce backup & restore",
    "Cloud-native backup — AWS, Azure & Google Cloud"
  ]
};

var COE_STATUS = ['Not started', 'In progress', 'Blocked', 'Done'];
var COE_STATUS_VAL = { 'Not started': 0, 'In progress': 0.5, 'Blocked': 0, 'Done': 1 };
var COE_RAG = ['On track', 'At risk', 'Delayed', 'Complete'];
var COE_RAG_COLOR = { 'On track': '#00D15F', 'At risk': '#FE8A25', 'Delayed': '#ED2B3D', 'Complete': '#1CA8DD' };

function coeItemId(code, i) { return code + '-' + (i + 1); }
function coeItemIds(code) {
  return (COE_ITEMS[code] || []).map(function (_, i) { return coeItemId(code, i); });
}
function coeAllIds() {
  var out = [];
  COE_DOMAINS.forEach(function (d) { out = out.concat(coeItemIds(d.code)); });
  return out;
}
function coeTotalItems() { return coeAllIds().length; }
function coeItemName(id) {
  var m = String(id || '').match(/^(.+)-(\d+)$/);
  if (!m) return id;
  var list = COE_ITEMS[m[1]] || [];
  return list[(+m[2]) - 1] || id;
}
function coeStatusOf(rec, id) {
  var it = (rec && rec.items && rec.items[id]) || null;
  var s = it && it.status;
  return COE_STATUS.indexOf(s) > -1 ? s : 'Not started';
}
/* Percent complete across a set of ids — the same weighted mean the COE
   dashboard used, rounded the same way. */
function coePct(rec, ids) {
  if (!ids || !ids.length) return 0;
  var sum = 0;
  ids.forEach(function (id) { sum += COE_STATUS_VAL[coeStatusOf(rec, id)]; });
  return Math.round(sum / ids.length * 100);
}
function coeDomainPct(rec, code) { return coePct(rec, coeItemIds(code)); }
function coeOverallPct(rec) { return coePct(rec, coeAllIds()); }
function coeBlockers(rec) {
  var n = 0;
  coeAllIds().forEach(function (id) { if (coeStatusOf(rec, id) === 'Blocked') n++; });
  return n;
}
function coeDoneCount(rec, code) {
  var n = 0;
  coeItemIds(code).forEach(function (id) { if (coeStatusOf(rec, id) === 'Done') n++; });
  return n;
}
/* Heatmap colour — red at nothing through to green at complete. */
function coeHeat(pct) {
  if (pct <= 0) return '#E4E8EA';
  return 'hsl(' + Math.round(pct * 1.2) + ',62%,46%)';
}

var COE_STR = ['id', 'partnerKey', 'name', 'region', 'owner', 'tier',
               'targetGoLive', 'nextReview', 'rag', 'notes'];

function normCoe(o) {
  var r = {};
  COE_STR.forEach(function (k) { r[k] = String(o[k] == null ? '' : o[k]).trim(); });
  if (!r.id) r.id = uid('COE-');
  if (COE_RAG.indexOf(r.rag) < 0) r.rag = 'On track';
  r.targetGoLive = asDateStr(r.targetGoLive);
  r.nextReview   = asDateStr(r.nextReview);

  /* items arrive either as an object keyed by id, or as the flat JSON string
     the Sheet stores in one cell. */
  var raw = o.items;
  if (typeof raw === 'string' && raw.trim()) {
    try { raw = JSON.parse(raw); } catch (e) { raw = {}; }
  }
  r.items = {};
  coeAllIds().forEach(function (id) {
    var src = (raw && raw[id]) || {};
    r.items[id] = {
      status:   COE_STATUS.indexOf(src.status) > -1 ? src.status : 'Not started',
      owner:    String(src.owner == null ? '' : src.owner).trim(),
      target:   asDateStr(src.target),
      verified: asDateStr(src.verified),
      notes:    String(src.notes == null ? '' : src.notes).trim()
    };
  });

  /* derived, never stored — same rule as every other computed field here */
  r.pct       = coeOverallPct(r);
  r.blockers  = coeBlockers(r);
  r.done      = 0;
  COE_DOMAINS.forEach(function (d) { r.done += coeDoneCount(r, d.code); });
  r.total     = coeTotalItems();
  r.domainPct = {};
  COE_DOMAINS.forEach(function (d) { r.domainPct[d.code] = coeDomainPct(r, d.code); });
  r.reviewDue = r.nextReview ? daysBetween(today(), r.nextReview) : null;
  r.overdueReview = r.reviewDue != null && r.reviewDue < 0;
  return r;
}

/* Dates in the COE file are d/m/Y; everything else here is ISO. */
function asDateStr(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : ymd(d);
}

/* -------------------------------------------------------------- normalize */
var ACT_STR = ['kind','type','title','oppId','customer','partner','partnerType','zone','location',
               'veeamStakeholder','se','audience','mode','category','product','link','stage',
               'nextAction','followUpDate','status','duration','remarks','outcome',
               'level','partnerTier','source'];
function normActivity(r) {
  var o = {};
  for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
  o.id = o.id || uid('A-');
  o.date = String(o.date || '').slice(0, 10);
  if (!o.startTime || !o.endTime) {
    var t = parseRange(o.time);
    o.startTime = o.startTime || t[0];
    o.endTime = o.endTime || t[1];
  }
  ACT_STR.forEach(function (k) { if (o[k] == null) o[k] = ''; });
  o.type = o.type || 'Meeting';
  o.kind = kindOf(o.type);                       /* always derived */
  o.time = (o.startTime && o.endTime) ? fmt12(o.startTime) + ' - ' + fmt12(o.endTime)
         : (o.startTime ? fmt12(o.startTime) : '');
  o.duration = o.duration || durLabel(o.startTime, o.endTime);
  o.status = o.status || 'Planned';
  o.followUpDate = String(o.followUpDate || '').slice(0, 10);
  if (o.regs == null) o.regs = '';
  if (o.attendees == null) o.attendees = '';
  if (o.uniquePartners == null) o.uniquePartners = '';
  o.quarter = qOf(o.date);
  o.month = mOf(o.date);
  o.minutes = actMinutes(o);
  o.timed = isTimed(o);
  return o;
}
/* Opportunity stops at Partner PreSales Contact, plus Stage.
   product / nextAction / followUpDate / lastTouch etc. are DERIVED in reindex()
   from the activity log, so they can never disagree with it. */
var OPP_STR = ['name','customer','industry','industryRaw','location','zone','veeamStakeholder',
               'contactPerson','contactNumber','contactEmail','partner','partnerSales',
               'partnerPreSales','partnerPreSalesContact','stage'];
function normOpp(r) {
  var o = {};
  for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
  o.id = o.id || uid('OPP-');
  OPP_STR.forEach(function (k) { if (o[k] == null) o[k] = ''; });
  o.state = stageClosed(o.stage) ? 'Closed' : 'Open';
  /* derived placeholders — filled by Store.reindex() */
  o.product = ''; o.nextAction = ''; o.followUpDate = '';
  o.firstTouch = ''; o.lastTouch = ''; o.touchCount = 0;
  return o;
}
function normAvail(r) {
  return { date: String(r.date || '').slice(0, 10), fullDay: r.fullDay || '',
           travelCity: r.travelCity || '', notes: r.notes || '', slots: r.slots || {} };
}
function normPartner(r) {
  var name = String(r.name || '').trim();
  return { key: r.key || partnerKey(name), name: name, type: r.type || 'Partner',
           tier: r.tier || '', owner: r.owner || '',
           zone: r.zone || '', sources: r.sources || '', notes: r.notes || '' };
}
function partnerKey(s) {
  return String(s || '').replace(/\s*\((P|D)\)\s*$/i, '')
    .replace(/\b(pvt|private)\.?\s*(ltd|limited)\.?\b/gi, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ store */
/* ------------------------------------------------------------ endpoint
   Redeploying the Apps Script can hand you a brand-new /exec URL. Keeping that
   only in config.js means every redeploy needs a file edit and a push — and if
   the file is ever reverted, the site silently calls a dead deployment and
   login fails for no visible reason. So the URL can also be set in the app and
   kept in this browser, which always wins over config.js. */
var API_KEY = 'ccc_api_url';
function apiUrl() {
  var saved = '';
  try { saved = localStorage.getItem(API_KEY) || ''; } catch (e) {}
  return String(saved || CFG.apiUrl || '').trim();
}
function apiIsOverridden() {
  try { return !!localStorage.getItem(API_KEY); } catch (e) { return false; }
}
function setApiUrl(u) {
  var v = String(u == null ? '' : u).trim();
  try {
    if (!v || v === String(CFG.apiUrl || '').trim()) localStorage.removeItem(API_KEY);
    else localStorage.setItem(API_KEY, v);
  } catch (e) {}
}

var Store = {
  activities: [], opportunities: [], availability: [], partners: [], layout: [], lists: {},
  backend: 0, hasOutlook: false,
  outlook: [], outlookStatus: { connected: false, last: '', status: '', hourly: false, count: 0 },
  loaded: false, updated: '', availMap: {}, oppMap: {}, actsByOpp: {}, outlookMap: {},
  coe: [], coeMap: {}, coeByPartner: {},

  /* ---- Outlook busy layer ----
     Never written into your painted availability. It sits underneath, so
     disconnecting Outlook leaves everything you set by hand untouched. */
  outlookOn: function () { return this.outlook.length > 0; },
  outlookFor: function (date) { return this.outlookMap[date] || []; },
  /** Is this slot covered by an Outlook meeting? Returns the block or null. */
  outlookAt: function (date, slot) {
    var list = this.outlookMap[date];
    if (!list) return null;
    var end = addMins(slot, CFG.slotMinutes || 30);
    for (var i = 0; i < list.length; i++) {
      if (list[i].start < end && list[i].end > slot) return list[i];
    }
    return null;
  },
  /** Minutes of Outlook busy time on a date, clipped to the working day. */
  outlookMinutes: function (date) {
    var slots = slotList(), step = CFG.slotMinutes || 30, n = 0, self = this;
    slots.forEach(function (s) { if (self.outlookAt(date, s)) n++; });
    return n * step;
  },

  /* Sheet-defined lists win over the built-ins. Anything already used in your data
     but missing from a list is appended, so a stray value never vanishes from a
     dropdown and silently gets lost on the next save. */
  applyLists: function (sheetLists) {
    this.lists = sheetLists || {};
    Object.keys(L_DEFAULT).forEach(function (k) { L[k] = L_DEFAULT[k].slice(); });
    Object.keys(this.lists).forEach(function (k) {
      var v = this.lists[k];
      if (Array.isArray(v) && v.length) L[k] = v.slice();
    }, this);
    /* Lists that are legitimately empty must stay empty — they are answers you
       gave, not lists with defaults to fall back on. */
    ['typeEnablement','typeInternal','stageClosed'].forEach(function (k) {
      L[k] = Array.isArray(this.lists[k]) ? this.lists[k].slice() : [];
    }, this);
    /* type drives kind, so keep the three kind buckets in step — via kindOf(),
       so a type you assigned yourself lands in the bucket you chose. */
    if (this.lists.type && this.lists.type.length) {
      L.enablement    = L.type.filter(function (t) { return kindOf(t) === 'Enablement'; });
      L.dealTypes     = L.type.filter(function (t) { return kindOf(t) === 'Deal support'; });
      L.internalTypes = L.type.filter(function (t) { return kindOf(t) === 'Internal'; });
    }
    this.absorbUsedValues();
  },
  /** Appends values that exist in the data but not in the list. */
  absorbUsedValues: function () {
    var self = this;
    var scan = [
      ['type', 'activities', 'type'], ['cat', 'activities', 'category'],
      ['level', 'activities', 'level'], ['mode', 'activities', 'mode'],
      ['status', 'activities', 'status'], ['product', 'activities', 'product'],
      ['zone', 'activities', 'zone'], ['stage', 'opportunities', 'stage'],
      ['industry', 'opportunities', 'industry'], ['tier', 'partners', 'tier'],
      ['partnerType', 'partners', 'type']
    ];
    scan.forEach(function (s) {
      var key = s[0], coll = s[1], field = s[2];
      if (!L[key]) return;
      (self[coll] || []).forEach(function (r) {
        var v = r[field];
        if (v && L[key].indexOf(v) === -1) L[key].push(v);
      });
    });
    /* audience is comma-separated */
    (self.activities || []).forEach(function (r) {
      String(r.audience || '').split(',').forEach(function (x) {
        x = x.trim();
        if (x && L.aud.indexOf(x) === -1) L.aud.push(x);
      });
    });
  },

  /** How many records use a given value — drives the counts in the list editor. */
  usageOf: function (key, value) {
    var n = 0, self = this;
    var map = {
      type: ['activities','type'], cat: ['activities','category'], level: ['activities','level'],
      mode: ['activities','mode'], status: ['activities','status'], product: ['activities','product'],
      stage: ['opportunities','stage'], industry: ['opportunities','industry'],
      tier: ['partners','tier'], partnerType: ['partners','type']
    };
    if (key === 'zone') {
      ['activities','opportunities','partners'].forEach(function (c) {
        (self[c] || []).forEach(function (r) { if (r.zone === value) n++; });
      });
      return n;
    }
    if (key === 'aud') {
      (self.activities || []).forEach(function (r) {
        if (String(r.audience || '').split(',').map(function (x) { return x.trim(); }).indexOf(value) > -1) n++;
      });
      return n;
    }
    var m = map[key];
    if (!m) return 0;
    (self[m[0]] || []).forEach(function (r) { if (r[m[1]] === value) n++; });
    return n;
  },

  reindex: function () {
    forgetPlaces();          /* travel-city lookup is derived from the data */
    var cm = {}, cbp = {};
    (this.coe || []).forEach(function (c) {
      cm[c.id] = c;
      if (c.partnerKey) cbp[c.partnerKey] = c;
    });
    this.coeMap = cm; this.coeByPartner = cbp;
    var am = {}, om = {}, ab = {}, ol = {};
    this.outlook.forEach(function (o) {
      if (!o.date) return;
      (ol[o.date] = ol[o.date] || []).push(o);
    });
    Object.keys(ol).forEach(function (d) {
      ol[d].sort(function (x, y) { return x.start.localeCompare(y.start); });
    });
    this.outlookMap = ol;
    this.availability.forEach(function (a) { am[a.date] = a; });
    this.opportunities.forEach(function (o) { om[o.id] = o; });
    this.activities.forEach(function (a) {
      if (a.oppId) (ab[a.oppId] = ab[a.oppId] || []).push(a);
      if (a.oppId && om[a.oppId] && !a.customer) a.customer = om[a.oppId].customer;
    });
    Object.keys(ab).forEach(function (k) {
      ab[k].sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); });
    });
    this.availMap = am; this.oppMap = om; this.actsByOpp = ab;

    /* Everything below is derived from the activity log — never stored on the
       opportunity, so the two can never drift apart. */
    this.opportunities.forEach(function (o) {
      var ts = ab[o.id] || [];                        /* newest first */
      o.touchCount = ts.length;
      o.firstTouch = ''; o.lastTouch = '';
      if (ts.length) {
        var ds = ts.map(function (t) { return t.date; }).filter(Boolean).sort();
        o.firstTouch = ds[0]; o.lastTouch = ds[ds.length - 1];
      }
      var latest = function (field) {
        for (var i = 0; i < ts.length; i++) if (ts[i][field]) return ts[i][field];
        return '';
      };
      o.product = latest('product');
      o.nextAction = latest('nextAction');
      o.followUpDate = latest('followUpDate');
      o.lastNote = latest('remarks');
      o.daysSinceTouch = o.lastTouch ? daysAgo(o.lastTouch) : null;
      o.stale = o.state === 'Open' && o.daysSinceTouch != null && o.daysSinceTouch > (CFG.staleDays || 30);
      o.overdue = o.state === 'Open' && !!o.followUpDate && o.followUpDate < today();
    });
  },

  /* Diary conflicts worth acting on:
       - anything booked on a day you marked Holiday
       - an in-person activity in one city on a day you are travelling to another
       - two timed activities that overlap
     Deliberately NOT flagged: activities on a travel day in the same city, or
     untimed ones — being on a call while travelling is normal, not a clash. */
  conflicts: function () {
    var self = this, out = [], byDate = {};
    this.activities.forEach(function (a) {
      if (!a.date || a.status === 'Cancelled') return;
      (byDate[a.date] = byDate[a.date] || []).push(a);
    });
    var sameCity = function (x, y) {
      if (!x || !y) return true;
      x = String(x).toLowerCase().trim(); y = String(y).toLowerCase().trim();
      return x === y || x.indexOf(y) > -1 || y.indexOf(x) > -1;
    };
    Object.keys(byDate).sort().forEach(function (d) {
      var av = self.availMap[d], list = byDate[d];
      if (av && av.fullDay === 'Holiday') {
        list.forEach(function (a) {
          out.push({ type: 'On a holiday', date: d, a: a, b: null,
                     msg: a.title + ' is booked on a day marked ' + fullDayLabel(av).long });
        });
      }
      if (av && av.fullDay === 'Travelling' && av.travelCity) {
        list.forEach(function (a) {
          if (a.mode === 'In-person' && a.location && !sameCity(a.location, av.travelCity)) {
            out.push({ type: 'Wrong city', date: d, a: a, b: null,
                       msg: a.title + ' is in ' + a.location + ' but you are marked ' + fullDayLabel(av).long });
          }
        });
      }
      /* something you logged sitting on top of a real Outlook meeting */
      var ol = self.outlookMap[d] || [];
      if (ol.length) {
        list.forEach(function (a) {
          if (!a.startTime || !a.endTime) return;
          for (var k = 0; k < ol.length; k++) {
            if (a.startTime < ol[k].end && a.endTime > ol[k].start) {
              out.push({ type: 'Outlook clash', date: d, a: a, b: null,
                         msg: a.title + ' (' + fmt12(a.startTime) + '–' + fmt12(a.endTime) +
                              ') runs over an Outlook meeting at ' + fmt12(ol[k].start) + '–' + fmt12(ol[k].end) });
              break;
            }
          }
        });
      }
      var timed = list.filter(function (a) { return a.startTime && a.endTime; })
                      .sort(function (x, y) { return x.startTime.localeCompare(y.startTime); });
      for (var i = 1; i < timed.length; i++) {
        if (timed[i].startTime < timed[i - 1].endTime) {
          out.push({ type: 'Overlap', date: d, a: timed[i - 1], b: timed[i],
                     msg: timed[i - 1].title + ' (' + fmt12(timed[i - 1].startTime) + '–' + fmt12(timed[i - 1].endTime) +
                          ') overlaps ' + timed[i].title + ' (' + fmt12(timed[i].startTime) + '–' + fmt12(timed[i].endTime) + ')' });
        }
      }
    });
    return out;
  },
  actsFor: function (oppId) { return this.actsByOpp[oppId] || []; },

  api: function (action, payload, tok) {
    var url = apiUrl();
    if (!url) return Promise.reject(new Error('No Google Sheet configured — set the Web App URL under Tools → Connection & token'));
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   /* simple request: no preflight */
      body: JSON.stringify({ token: tok || Auth.token(), action: action, payload: payload || {} })
    }).then(function (r) {
      return r.text().then(function (txt) {
        /* An HTML body here means Google served a sign-in or error page rather
           than the script — almost always a deployment-access problem. */
        if (/^\s*<(!doctype|html)/i.test(txt)) {
          throw new Error('The Sheet URL returned a web page instead of data. ' +
            'In Apps Script: Deploy > Manage deployments > check "Who has access" is ' +
            '"Anyone", then Deploy a New version.');
        }
        var j;
        try { j = JSON.parse(txt); }
        catch (e) { throw new Error('The Sheet sent something unreadable: ' + txt.slice(0, 160)); }
        if (!j || !j.ok) throw new Error((j && j.error) || 'Request failed');
        return j;
      });
    }, function () {
      throw new Error('Could not reach the Google Sheet at all. Check apiUrl in config.js, ' +
        'and that the deployment allows "Anyone".');
    });
  },
  ingest: function (j) {
    this.activities    = (j.activities || []).map(normActivity);
    this.opportunities = (j.opportunities || []).map(normOpp);
    this.availability  = (j.availability || []).map(normAvail);
    this.partners      = (j.partners || []).map(normPartner);

    this.coe = (j.coe || []).map(normCoe);
    this.layout        = (j.layout || []).slice();
    this.applyLists(j.lists || {});
    this.outlook       = (j.outlook || []).map(function (o) {
      return { date: String(o.date || '').slice(0, 10), start: o.start || '00:00',
               end: o.end || '23:59', allDay: !!o.allDay, source: o.source || '' };
    }).filter(function (o) { return o.date; });
    this.outlookStatus = j.outlookStatus || this.outlookStatus;
    this.backend = j.backend || 0;
    this.hasOutlook = !!j.hasOutlook;
    this.updated = j.updated || '';
    this.loaded = true;
    this.reindex();
    return this;
  },
  bootstrap: function (tok) {
    var self = this;
    return this.api('bootstrap', {}, tok).then(function (j) { return self.ingest(j); });
  },

  upsert: function (coll, rec, fn) {
    var arr = this[coll], i = -1, r = fn(rec);
    arr.forEach(function (x, k) { if (x.id === r.id) i = k; });
    if (i >= 0) arr[i] = r; else arr.push(r);
    this.reindex();
    return r;
  },
  remove: function (coll, id) {
    this[coll] = this[coll].filter(function (x) { return x.id !== id; });
    this.reindex();
  },
  upsertAvail: function (av) {
    var a = normAvail(av), i = -1;
    this.availability.forEach(function (x, k) { if (x.date === a.date) i = k; });
    if (i >= 0) this.availability[i] = a; else this.availability.push(a);
    this.reindex();
    return a;
  },
  uniq: function (coll, key) {
    var s = {};
    this[coll].forEach(function (r) { if (r[key]) s[r[key]] = 1; });
    return Object.keys(s).sort(function (a, b) { return a.localeCompare(b); });
  },
  quarters: function () {
    var s = {};
    this.activities.forEach(function (r) { if (r.date) s[qKey(r.date)] = 1; });
    return Object.keys(s).sort();
  },
  partnerName: function (n) {
    var k = partnerKey(n), hit = null;
    this.partners.forEach(function (p) { if (p.key === k) hit = p; });
    return hit ? hit.name : String(n || '').trim();
  },
  partnerType: function (n) {
    var k = partnerKey(n), t = 'Partner';
    this.partners.forEach(function (p) { if (p.key === k) t = p.type; });
    return t;
  }
};

/* ------------------------------------------------------------------- auth */
var Auth = {
  KEY: 'ccc3_token',
  token: function () {
    try { return sessionStorage.getItem(this.KEY) || localStorage.getItem(this.KEY) || ''; } catch (e) { return ''; }
  },
  set: function (t, remember) {
    try {
      sessionStorage.setItem(this.KEY, t);
      if (remember) localStorage.setItem(this.KEY, t); else localStorage.removeItem(this.KEY);
    } catch (e) {}
  },
  clear: function () { try { sessionStorage.removeItem(this.KEY); localStorage.removeItem(this.KEY); } catch (e) {} }
};

/* ------------------------------------------------------------------ stats */
function groupBy(rows, key) {
  var m = new Map();
  rows.forEach(function (r) {
    var k = r[key] || '(blank)';
    if (!m.has(k)) m.set(k, { n: 0, att: 0, reg: 0, mins: 0, rows: [] });
    var o = m.get(k);
    o.n++; o.att += num(r.attendees); o.reg += num(r.regs); o.mins += num(r.minutes); o.rows.push(r);
  });
  return m;
}
function sortKeys(map, by) {
  return Array.from(map.keys()).sort(function (a, b) { return map.get(b)[by] - map.get(a)[by]; });
}
function actStats(rows) {
  var td = today();
  var enable = rows.filter(function (r) { return r.kind === 'Enablement'; });
  var deal   = rows.filter(function (r) { return r.kind === 'Deal support'; });
  var att = enable.reduce(function (s, r) { return s + num(r.attendees); }, 0);
  var reg = enable.reduce(function (s, r) { return s + num(r.regs); }, 0);
  var wa  = enable.filter(function (r) { return has(r.attendees); });
  var both = enable.filter(function (r) { return has(r.regs) && has(r.attendees); });
  return {
    n: rows.length, enable: enable.length, deal: deal.length,
    internal: rows.filter(function (r) { return r.kind === 'Internal'; }).length,
    att: att, reg: reg, withAtt: wa.length,
    avgAtt: wa.length ? Math.round(att / wa.length) : null,
    uniquePartners: enable.reduce(function (s, r) { return s + num(r.uniquePartners); }, 0),
    withUniq: enable.filter(function (r) { return has(r.uniquePartners); }).length,
    done: rows.filter(function (r) { return r.status === 'Completed'; }).length,
    upcoming: rows.filter(function (r) { return r.date >= td && ['Completed','Cancelled'].indexOf(r.status) === -1; }),
    slipped: rows.filter(function (r) { return ['Rescheduled','Cancelled'].indexOf(r.status) > -1; }).length,
    inperson: rows.filter(function (r) { return r.mode === 'In-person'; }).length,
    conv: both.length ? Math.round(both.reduce(function (s, r) { return s + num(r.attendees); }, 0) /
                                   both.reduce(function (s, r) { return s + num(r.regs); }, 0) * 100) : null,
    missingAtt: enable.filter(function (r) { return r.status === 'Completed' && !has(r.attendees); }),
    noOpp: deal.filter(function (r) { return !r.oppId; }),
    hours: Math.round(rows.reduce(function (s, r) { return s + num(r.minutes); }, 0) / 60),
    timedPct: rows.length ? Math.round(rows.filter(function (r) { return r.timed; }).length / rows.length * 100) : 0,
    zones: Object.keys(rows.reduce(function (a, r) { if (r.zone) a[r.zone] = 1; return a; }, {})).length,
    cities: Object.keys(rows.reduce(function (a, r) { if (r.location) a[r.location] = 1; return a; }, {})).length,
    partners: Object.keys(rows.reduce(function (a, r) {
      if (r.partner && ['Internal','Partner','End Customer'].indexOf(r.partner) === -1) a[r.partner] = 1;
      return a; }, {})).length
  };
}
function oppStats(opps) {
  var open = opps.filter(function (o) { return o.state === 'Open'; });
  return {
    n: opps.length, open: open.length,
    won: opps.filter(function (o) { return o.stage === 'Closed-Won'; }).length,
    lost: opps.filter(function (o) { return o.stage === 'Closed-Lost'; }).length,
    late: open.filter(function (o) { return ['Proposal','Negotiation'].indexOf(o.stage) > -1; }).length,
    stale: open.filter(function (o) { return o.stale; }),
    overdue: open.filter(function (o) { return o.overdue; }),
    customers: Object.keys(opps.reduce(function (a, o) { if (o.customer) a[o.customer] = 1; return a; }, {})).length,
    industries: Object.keys(opps.reduce(function (a, o) { if (o.industry) a[o.industry] = 1; return a; }, {})).length,
    noPartner: opps.filter(function (o) { return !o.partner && !o.distributor; }).length,
    avgAge: open.length ? Math.round(open.reduce(function (s, o) {
      return s + (o.firstTouch ? daysAgo(o.firstTouch) : 0); }, 0) / open.length) : null
  };
}
/**
 * Availability hours for a set of dates, plus utilisation.
 * A slot you painted Free that Outlook says is booked counts as busy, not free —
 * otherwise the site would tell you you're available when you are not.
 */
function availStats(days) {
  var mins = CFG.slotMinutes || 30, free = 0, busy = 0, other = 0, travel = 0, holiday = 0,
      painted = 0, fromOutlook = 0;
  days.forEach(function (a) {
    if (a.fullDay === 'Travelling') { travel++; return; }
    if (a.fullDay === 'Holiday') { holiday++; return; }
    Object.keys(a.slots).forEach(function (k) {
      var v = a.slots[k];
      painted++;
      if (v === 'Free') {
        if (Store.outlookAt(a.date, k)) { busy++; fromOutlook++; }
        else free++;
      } else if (v === 'Busy') busy++;
      else other++;
    });
    /* Outlook meetings in slots you never painted still count as busy */
    if (Store.outlookOn()) {
      slotList().forEach(function (k) {
        if (!a.slots[k] && Store.outlookAt(a.date, k)) { busy++; fromOutlook++; }
      });
    }
  });
  var slotsPerDay = slotList().length;
  var workDays = days.length - holiday;
  return { freeH: free * mins / 60, busyH: busy * mins / 60, otherH: other * mins / 60,
           outlookH: fromOutlook * mins / 60,
           travelDays: travel, holidayDays: holiday, days: days.length,
           /* how much of the bookable day is committed */
           utilisation: (busy + free) ? Math.round(busy / (busy + free) * 100) : null,
           /* how much of the month you have actually filled in */
           coverage: (workDays && slotsPerDay)
             ? Math.round((painted + travel * slotsPerDay) / (workDays * slotsPerDay) * 100) : 0,
           travelPct: days.length ? Math.round(travel / days.length * 100) : 0 };
}
function statusPill(s) {
  var m = { Completed:'done', Planned:'plan', Confirmed:'conf', Rescheduled:'resc', Cancelled:'canc' };
  return '<span class="pill ' + (m[s] || 'plan') + '">' + esc(s || '—') + '</span>';
}
function colourPill(text, colour) {
  var c = colour || '#8b95a3';
  return '<span class="pill" style="background:' + c + '22;color:' + c + '">' + esc(text || '—') + '</span>';
}
function typePill(t) { return colourPill(t, TYPE_COLOR[t]); }
function stagePill(s) { return colourPill(s, STAGE_COLOR[s]); }
function kindChip(k) {
  var cls = k === 'Enablement' ? 'enablement' : (k === 'Deal support' ? 'deal' : 'internal');
  return '<span class="kchip ' + cls + '">' + esc(k) + '</span>';
}

/* ----------------------------------------------------------------- charts */
var CH = {};
var CH_DEF = { responsive: true, maintainAspectRatio: false };
function destroyCharts() { Object.keys(CH).forEach(function (k) { try { CH[k].destroy(); } catch (e) {} }); CH = {}; }
/* Charts are clickable. `opts.onPick(index, label, datasetIndex)` is called when
   you click a bar, slice or point; the panel decides which records that means.
   Without this a chart can only tell you a number, never show you the rows. */
function pickable(opts, labels) {
  var pick = opts && opts.onPick;
  if (!pick) return {};
  return {
    onHover: function (e, els) { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
    onClick: function (e, els, chart) {
      if (!els.length) return;
      var i = els[0].index;
      pick(i, labels[i], els[0].datasetIndex);
    }
  };
}
function bar(id, labels, datasets, opts) {
  var el = document.getElementById(id); if (!el || !global.Chart) return;
  CH[id] = new Chart(el, { type: 'bar', data: { labels: labels, datasets: datasets },
    options: Object.assign({}, CH_DEF, pickable(opts, labels), {
      plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: { x: { grid: { display: false }, stacked: !!(opts && opts.stacked),
                     ticks: { font: { size: 10.5 }, autoSkip: false, maxRotation: 60 } },
                y: { beginAtZero: true, stacked: !!(opts && opts.stacked),
                     grid: { color: '#EAECEE' }, ticks: { font: { size: 10.5 }, precision: 0 } } }
    }, opts || {}) });
}
function hbar(id, labels, data, colour, label, opts) {
  bar(id, labels, [{ label: label || 'Count', data: data, backgroundColor: colour, borderRadius: 4, maxBarThickness: 18 }], {
    indexAxis: 'y', onPick: opts && opts.onPick,
    scales: { x: { beginAtZero: true, grid: { color: '#EAECEE' }, ticks: { font: { size: 10.5 }, precision: 0 } },
              y: { grid: { display: false }, ticks: { font: { size: 10 } } } } });
}
function doughnut(id, labels, values, colours, opts) {
  var el = document.getElementById(id); if (!el || !global.Chart) return;
  CH[id] = new Chart(el, { type: 'doughnut',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: colours, borderWidth: 2, borderColor: '#fff' }] },
    options: Object.assign({}, CH_DEF, pickable(opts, labels), { cutout: '58%',
      plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } } } }) });
}
function line(id, labels, series, opts) {
  var el = document.getElementById(id); if (!el || !global.Chart) return;
  CH[id] = new Chart(el, { type: 'line',
    data: { labels: labels, datasets: series.map(function (s) {
      return { label: s.label, data: s.data, borderColor: s.colour, backgroundColor: s.colour + '20',
               fill: s.fill !== false, tension: .3, pointRadius: 3, borderWidth: 2 }; }) },
    options: Object.assign({}, CH_DEF, pickable(opts, labels), {
      plugins: { legend: { display: series.length > 1, labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 } } },
                y: { beginAtZero: true, grid: { color: '#EAECEE' }, ticks: { font: { size: 10.5 } } } } }) });
}

/* -------------------------------------------------------------- ICS / CSV */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'export';
}
function icsEsc(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;')
    .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(l) {
  if (l.length <= 73) return l;
  var out = l.slice(0, 73), rest = l.slice(73);
  while (rest.length) { out += '\r\n ' + rest.slice(0, 72); rest = rest.slice(72); }
  return out;
}
function buildIcs(recs) {
  var stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  var out = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Channel Command Center//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  recs.forEach(function (r) {
    if (!r.date) return;
    var st = r.startTime || '10:00', en = r.endTime || addMins(st, 60);
    var desc = [
      r.kind && 'Kind: ' + r.kind,
      r.type && 'Type: ' + r.type,
      r.category && 'Category: ' + r.category,
      r.customer && 'Customer: ' + r.customer,
      r.audience && 'Audience: ' + r.audience,
      r.partner && 'Partner / Disti: ' + r.partner,
      r.veeamStakeholder && 'Veeam stakeholder: ' + r.veeamStakeholder,
      r.mode && 'Mode: ' + r.mode,
      r.status && 'Status: ' + r.status,
      r.nextAction && 'Next action: ' + r.nextAction,
      r.link && 'Link: ' + r.link,
      r.remarks && 'Notes: ' + r.remarks
    ].filter(Boolean).join('\n');
    out.push('BEGIN:VEVENT');
    out.push('UID:' + r.id + '@channel-command-center');
    out.push('DTSTAMP:' + stamp);
    out.push('DTSTART:' + r.date.replace(/-/g, '') + 'T' + st.replace(':', '') + '00');
    out.push('DTEND:' + r.date.replace(/-/g, '') + 'T' + en.replace(':', '') + '00');
    out.push(fold('SUMMARY:' + icsEsc([r.type, r.title].filter(Boolean).join(' — '))));
    out.push(fold('LOCATION:' + icsEsc(r.mode === 'Online' ? (r.link || 'Online')
      : [r.location, r.zone].filter(Boolean).join(', '))));
    out.push(fold('DESCRIPTION:' + icsEsc(desc)));
    if (r.link && /^https?:/.test(r.link)) out.push(fold('URL:' + r.link));
    out.push('CATEGORIES:' + icsEsc([r.kind, r.type, r.zone].filter(Boolean).join(',')));
    out.push('STATUS:' + (r.status === 'Cancelled' ? 'CANCELLED' : (r.status === 'Planned' ? 'TENTATIVE' : 'CONFIRMED')));
    out.push('TRANSP:OPAQUE');
    out.push('END:VEVENT');
  });
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}
function download(name, text, mime) {
  try {
    var b = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1200);
    return true;
  } catch (e) { console.error(e); toast('Download was blocked by the browser'); return false; }
}
function downloadIcs(recs, name) {
  if (!recs.length) { toast('Nothing to export'); return; }
  download(name + '.ics', buildIcs(recs), 'text/calendar');
  toast(recs.length + ' event' + (recs.length > 1 ? 's' : '') + ' exported — open the .ics to add to Outlook');
}
function csvOf(rows, cols) {
  var q = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.map(function (c) { return c[1]; }).join(',')]
    .concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c[0]]); }).join(','); })).join('\r\n');
}
var CSV_ACT = [['date','Date'],['time','Time'],['kind','Kind'],['type','Type'],['level','Level'],
  ['title','Title'],['customer','Customer'],['partner','Partner / Distributor'],['category','Category'],
  ['audience','Audience'],['partnerTier','Partner Tier Targeted'],['mode','Mode'],['zone','Zone'],['location','City'],
  ['veeamStakeholder','Veeam Stakeholder'],['se','SE'],['product','Product'],['duration','Duration'],['link','Link'],
  ['regs','Registrations'],['attendees','Attendees'],['uniquePartners','Unique Partners'],
  ['stage','Stage'],['nextAction','Next Action'],['followUpDate','Follow-up'],['status','Status'],
  ['remarks','Notes'],['outcome','Outcome'],['source','Source']];
var CSV_OPP = [['id','Opportunity ID'],['name','Opportunity'],['customer','Customer'],['industry','Industry'],
  ['industryRaw','Industry as entered'],['location','Location'],['zone','Zone'],['veeamStakeholder','Internal Sales'],
  ['contactPerson','Contact Person'],['contactNumber','Contact Number'],['contactEmail','Contact Person Email'],
  ['partner','Partner'],['partnerSales','Partner Sales'],['partnerPreSales','Partner PreSales'],
  ['partnerPreSalesContact','Partner PreSales Contact'],['stage','Stage'],['state','State'],
  ['product','Product (from latest activity)'],['nextAction','Next Action (from latest activity)'],
  ['followUpDate','Follow-up (from latest activity)'],['firstTouch','First Activity'],
  ['lastTouch','Last Activity'],['touchCount','Activities']];
var CSV_AVAIL = [['date','Date'],['day','Day'],['fullDay','Full Day'],['travelCity','Travel City'],
  ['freeH','Free Hours'],['busyH','Busy Hours'],['notes','Notes']];

/* ---------------------------------------------------------------- exports */
global.APP = {
  CFG: CFG, L: L, MONTHS: MONTHS, MONTHS_FULL: MONTHS_FULL, DOW: DOW, PALETTE: PALETTE,
  KIND_COLOR: KIND_COLOR, TYPE_COLOR: TYPE_COLOR, STAGE_COLOR: STAGE_COLOR,
  STATUS_COLOR: STATUS_COLOR, AVAIL_COLOR: AVAIL_COLOR, LEVEL_COLOR: LEVEL_COLOR,
  $: $, $$: $$, esc: esc, toast: toast,
  uid: uid, num: num, has: has, pad: pad, ymd: ymd, today: today, dateObj: dateObj, dowOf: dowOf,
  isWeekend: isWeekend, showWeekends: showWeekends, hiddenDay: hiddenDay, daysBetween: daysBetween, daysAgo: daysAgo, addDays: addDays,
  niceDate: niceDate, longDate: longDate,
  qOf: qOf, fyOf: fyOf, qKey: qKey, qLabel: qLabel, mOf: mOf, mKeyLabel: mKeyLabel, quarterMonths: quarterMonths,
  parseT: parseT, parseRange: parseRange, fmt12: fmt12, minsBetween: minsBetween, addMins: addMins,
  durLabel: durLabel, actMinutes: actMinutes, isTimed: isTimed, slotList: slotList, kindOf: kindOf, stageClosed: stageClosed,
  stageRank: stageRank, advanceStage: advanceStage,
  fullDayLabel: fullDayLabel, travelCityOf: travelCityOf, knownPlaces: knownPlaces,
  whereDone: whereDone, isAway: isAway, isHomeCity: isHomeCity, homeBases: homeBases,
  travelStats: travelStats, travelDaysIndex: travelDaysIndex,
  normActivity: normActivity, normOpp: normOpp, normAvail: normAvail, normPartner: normPartner,
  normCoe: normCoe, COE_DOMAINS: COE_DOMAINS, COE_ITEMS: COE_ITEMS, COE_STATUS: COE_STATUS,
  COE_RAG: COE_RAG, COE_RAG_COLOR: COE_RAG_COLOR, COE_STATUS_VAL: COE_STATUS_VAL,
  coeItemId: coeItemId, coeItemIds: coeItemIds, coeAllIds: coeAllIds, coeItemName: coeItemName,
  coeOverallPct: coeOverallPct, coeDomainPct: coeDomainPct, coeBlockers: coeBlockers,
  coeDoneCount: coeDoneCount, coeTotalItems: coeTotalItems, coeHeat: coeHeat,
  coeStatusOf: coeStatusOf, asDateStr: asDateStr,
  partnerKey: partnerKey,
  Store: Store, Auth: Auth, apiUrl: apiUrl, setApiUrl: setApiUrl, apiIsOverridden: apiIsOverridden, L_DEFAULT: L_DEFAULT, EDITABLE_LISTS: EDITABLE_LISTS,
  NEEDS_BACKEND: 13,
  groupBy: groupBy, sortKeys: sortKeys, actStats: actStats, oppStats: oppStats, availStats: availStats,
  statusPill: statusPill, stagePill: stagePill, typePill: typePill, colourPill: colourPill, kindChip: kindChip,
  destroyCharts: destroyCharts, bar: bar, hbar: hbar, doughnut: doughnut, line: line,
  slug: slug, buildIcs: buildIcs, download: download, downloadIcs: downloadIcs, csvOf: csvOf,
  CSV_ACT: CSV_ACT, CSV_OPP: CSV_OPP, CSV_AVAIL: CSV_AVAIL
};
})(window);
