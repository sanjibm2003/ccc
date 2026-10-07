/* =========================================================================
   panels.js — the dashboard panel registry.

   Every panel is independent: an id, a title, a width, and a render(el, ctx).
   The Dashboard tab decides which appear and in what order; the user controls
   that from the customise bar and the layout is saved to the Sheet.

   To add a panel: append one entry to PANELS. Nothing else to change.
   ========================================================================= */
(function (global) {
'use strict';
var A = global.APP, CFG = A.CFG, S = A.Store, esc = A.esc, num = A.num, has = A.has;

/* ---------------------------------------------------------------- helpers */
function kpi(items) {
  return '<div class="grid kpis">' + items.map(function (i) {
    return '<div class="kpi' + (i[3] ? ' ' + i[3] : '') + '"><div class="k">' + esc(i[0]) +
      '</div><div class="v">' + i[1] + '</div><div class="d">' + (i[2] || '') + '</div></div>';
  }).join('') + '</div>';
}
function canvas(id, tall) { return '<div class="ch' + (tall ? ' tall' : '') + '"><canvas id="' + id + '"></canvas></div>'; }
function empty(msg) { return '<div class="empty">' + esc(msg) + '</div>'; }
function monthKeys(rows) {
  var s = {};
  rows.forEach(function (r) { if (r.date) s[r.date.slice(0, 7)] = 1; });
  return Object.keys(s).sort();
}
function inMonth(rows, mk) { return rows.filter(function (r) { return r.date.slice(0, 7) === mk; }); }
function realPartners(rows) {
  return rows.filter(function (r) {
    return r.partner && ['Internal','Partner','End Customer'].indexOf(r.partner) === -1;
  });
}
function jump(fn) { return fn; }
/* Hand the exact rows behind a chart element to the drill, and go to the tab
   that lists them. Without this a chart can only ever tell you a number. */
function drillTo(label, rows, tab) {
  global.setDrill(label, tab === 'pipe' ? 'opportunities' : 'activities', rows, tab);
}

/* ====================================================================== */
/*  PANEL REGISTRY                                                        */
/* ====================================================================== */
var PANELS = [

/* ------------------------------------------------------------- headline */
{ id: 'kpi', title: 'Headline numbers', width: 'wide',
  render: function (el, c) {
    var st = c.as, os = c.os, td = A.today(), wk = A.addDays(td, 7);
    var thisWeek = c.acts.filter(function (r) { return r.date >= td && r.date <= wk && r.status !== 'Cancelled'; });
    var cf = S.conflicts().length;
    el.innerHTML = kpi([
      ['Activities', st.n, st.enable + ' enablement · ' + st.deal + ' deal support', 'acc'],
      ['People reached', st.att.toLocaleString(), st.avgAtt == null ? 'no attendance logged' : 'avg ' + st.avgAtt + ' per event', 'acc'],
      ['Partner seats', st.uniquePartners || '—', st.withUniq ? 'across ' + st.withUniq + ' events' : 'unique-partner counts not filled', 'acc'],
      ['Hours logged', st.hours.toLocaleString(), st.timedPct + '% have exact times', ''],
      ['This week', thisWeek.length, 'activities scheduled', thisWeek.length ? 'warn' : ''],
      ['Open opportunities', os.open, os.late + ' at proposal or later', 'acc'],
      ['Overdue follow-ups', os.overdue.length, os.overdue.length ? 'needs chasing' : 'all clear', os.overdue.length ? 'bad' : ''],
      ['Partners engaged', st.partners, st.cities + ' cities · ' + st.zones + ' zones', ''],
      ['Travel days', c.avs.travelDays, c.avs.travelPct + '% of recorded days', ''],
      ['Diary conflicts', cf, cf ? 'clashes to resolve' : 'diary is clean', cf ? 'bad' : '']
    ]);
  } },


/* -------------------------------------------------------------- this week */
{ id: 'week', title: 'This week', width: 'half',
  render: function (el, c) {
    var td = A.today(), end = A.addDays(td, 13);
    var rows = c.acts.filter(function (r) { return r.date >= td && r.date <= end && r.status !== 'Cancelled'; })
      .sort(function (a, b) { return (a.date + (a.startTime || '99')).localeCompare(b.date + (b.startTime || '99')); });
    var html = '<h3>Next two weeks <span>— ' + rows.length + ' activities</span></h3>';
    if (!rows.length) { el.innerHTML = html + empty('Nothing scheduled. Time to book some partner sessions.'); return; }
    /* Group by day first. A day with a whole-day status shows that status and
       nothing else — see renderCal() for the reasoning. */
    var order = [], byDay = {};
    rows.forEach(function (r) {
      if (!byDay[r.date]) { byDay[r.date] = []; order.push(r.date); }
      byDay[r.date].push(r);
    });
    var body = '<div class="ag">';
    order.forEach(function (date) {
      var av = S.availMap[date], fd = A.fullDayLabel(av);
      body += '<div class="agd' + (date === td ? ' today' : '') + '"' +
              (fd.title ? ' title="' + esc(fd.title) + '"' : '') + '>' + A.longDate(date) +
              (date === td ? ' — today' : '') + (fd.bare ? esc(' · ' + fd.bare) : '') + '</div>';
      if (av && av.fullDay) {
        var n = byDay[date].length;
        body += '<div class="agh">' + n + ' other ' + (n === 1 ? 'thing' : 'things') +
                ' logged that day</div>';
        return;
      }
      byDay[date].forEach(function (r) {
        var col = A.TYPE_COLOR[r.type] || '#8b95a3';
        body += '<div class="agi" data-id="' + r.id + '" style="border-left-color:' + col + '">' +
          '<div class="tm">' + esc(r.startTime ? A.fmt12(r.startTime) : '—') + '</div>' +
          '<div class="bd">' + esc(r.title) +
          '<div class="mt">' + A.kindChip(r.kind) + ' ' + esc([r.type, r.partner, r.location].filter(Boolean).join(' · ')) + '</div>' +
          '</div></div>';
      });
    });
    el.innerHTML = html + body + '</div>';
    A.$$('[data-id]', el).forEach(function (x) { x.onclick = function () { global.openAct(x.dataset.id); }; });
  } },

/* ---------------------------------------------------------------- volume */
{ id: 'volume', title: 'Activity volume by month', width: 'half',
  render: function (el, c) {
    el.innerHTML = '<h3>Activity volume by month <span>— enablement vs deal support</span></h3>' + canvas('p_volume');
    var mk = monthKeys(c.acts);
    A.bar('p_volume', mk.map(A.mKeyLabel), [
      { label: 'Enablement', data: mk.map(function (k) { return inMonth(c.acts, k).filter(function (r) { return r.kind === 'Enablement'; }).length; }),
        backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 30 },
      { label: 'Deal support', data: mk.map(function (k) { return inMonth(c.acts, k).filter(function (r) { return r.kind === 'Deal support'; }).length; }),
        backgroundColor: '#1CA8DD', borderRadius: 3, maxBarThickness: 30 },
      { label: 'Internal', data: mk.map(function (k) { return inMonth(c.acts, k).filter(function (r) { return r.kind === 'Internal'; }).length; }),
        backgroundColor: '#c9d0d9', borderRadius: 3, maxBarThickness: 30 }
    ], { stacked: true, onPick: function (i, label, ds) {
      var kinds = ['Enablement', 'Deal support', 'Internal'];
      drillTo(kinds[ds] + ' in ' + label,
        inMonth(c.acts, mk[i]).filter(function (r) { return r.kind === kinds[ds]; }), 'log');
    } });
  } },

/* ------------------------------------------------------------- time split */
{ id: 'timesplit', title: 'Where my time goes', width: 'half',
  render: function (el, c) {
    var g = A.groupBy(c.acts, 'kind');
    var keys = A.L.kind.filter(function (k) { return g.has(k); });
    var hrs = keys.map(function (k) { return Math.round(g.get(k).mins / 60); });
    var total = hrs.reduce(function (a, b) { return a + b; }, 0);
    el.innerHTML = '<h3>Where my time goes <span>— ' + total.toLocaleString() + ' hours</span></h3>' +
      '<div class="stat">' + keys.map(function (k, i) {
        return '<div><b style="color:' + A.KIND_COLOR[k] + '">' + hrs[i] + 'h</b>' + esc(k) +
               ' · ' + (total ? Math.round(hrs[i] / total * 100) : 0) + '%</div>';
      }).join('') + '</div>' + canvas('p_time') +
      '<div class="hint2">Activities without a start and end time are counted at ' +
      (CFG.defaultActivityMinutes || 60) + ' minutes. ' + c.as.timedPct + '% of these have exact times — ' +
      'add times as you log new work and this gets sharper.</div>';
    A.doughnut('p_time', keys, hrs, keys.map(function (k) { return A.KIND_COLOR[k]; }),
      { onPick: function (i) { drillTo(keys[i] + ' activities', g.get(keys[i]).rows, 'log'); } });
  } },

/* ---------------------------------------------------------------- typemix */
{ id: 'typemix', title: 'Activity type mix', width: 'half',
  render: function (el, c) {
    el.innerHTML = '<h3>Activity type mix</h3>' + canvas('p_type', true);
    var g = A.groupBy(c.acts, 'type'), keys = A.sortKeys(g, 'n');
    A.hbar('p_type', keys, keys.map(function (k) { return g.get(k).n; }),
      keys.map(function (k) { return A.TYPE_COLOR[k] || '#8b95a3'; }), 'Activities',
      { onPick: function (i) { drillTo('Type: ' + keys[i], g.get(keys[i]).rows, 'log'); } });
  } },

/* ------------------------------------------------------------------ reach */
{ id: 'reach', title: 'Events & people reached', width: 'half',
  render: function (el, c) {
    var en = c.acts.filter(function (r) { return r.kind === 'Enablement'; });
    el.innerHTML = '<h3>Events &amp; people reached <span>— enablement only</span></h3>' + canvas('p_reach');
    var mk = monthKeys(en);
    if (!mk.length) { el.innerHTML = '<h3>Events &amp; people reached</h3>' + empty('No enablement activities in this filter.'); return; }
    A.line('p_reach', mk.map(A.mKeyLabel), [
      { label: 'Attendees', data: mk.map(function (k) {
          return inMonth(en, k).reduce(function (s, r) { return s + num(r.attendees); }, 0); }), colour: '#00D15F' },
      { label: 'Events', data: mk.map(function (k) { return inMonth(en, k).length; }), colour: '#97D700', fill: false }
    ]);
  } },

/* ---------------------------------------------------------------- breadth */
{ id: 'breadth', title: 'Reach breadth — heads vs partners', width: 'half',
  render: function (el, c) {
    var rows = c.acts.filter(function (r) { return has(r.uniquePartners) && has(r.attendees); })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (!rows.length) {
      el.innerHTML = '<h3>Reach breadth</h3>' +
        empty('No event yet records how many distinct partner organisations attended. ' +
              'Fill in "Unique partners" on a training and this shows whether your reach is broad or concentrated.');
      return;
    }
    var heads = rows.reduce(function (s, r) { return s + num(r.attendees); }, 0);
    var orgs = rows.reduce(function (s, r) { return s + num(r.uniquePartners); }, 0);
    el.innerHTML = '<h3>Reach breadth <span>— ' + rows.length + ' events record both</span></h3>' +
      '<div class="stat">' +
      '<div><b>' + heads + '</b>people</div>' +
      '<div><b style="color:var(--g-d)">' + orgs + '</b>partner seats</div>' +
      '<div><b>' + (orgs ? (heads / orgs).toFixed(1) : '—') + '</b>heads per partner</div>' +
      '</div>' + canvas('p_breadth') +
      '<div class="hint2">Two events with 25 attendees are not equal: 25 people from 19 partners spreads ' +
      'capability across your channel, 25 from 3 partners does not.</div>';
    A.bar('p_breadth', rows.map(function (r) { return A.niceDate(r.date); }), [
      { label: 'Attendees', data: rows.map(function (r) { return num(r.attendees); }),
        backgroundColor: '#D3EEFB', borderRadius: 3, maxBarThickness: 26 },
      { label: 'Unique partners', data: rows.map(function (r) { return num(r.uniquePartners); }),
        backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 26 }
    ], { onPick: function (i) { drillTo(rows[i].title, [rows[i]], 'events'); } });
  } },

/* ----------------------------------------------------------------- repeat */
{ id: 'repeat', title: 'Most repeated topics', width: 'half',
  render: function (el, c) {
    var en = c.acts.filter(function (r) { return r.kind === 'Enablement' && r.title; });
    var m = {};
    en.forEach(function (r) {
      var k = String(r.title).toLowerCase().replace(/\s*[-–]\s*.*$/, '').replace(/\s+/g, ' ').trim();
      if (!k) return;
      if (!m[k]) m[k] = { title: r.title, n: 0, att: 0, cities: {} };
      m[k].n++; m[k].att += num(r.attendees);
      if (r.location) m[k].cities[r.location] = 1;
    });
    var keys = Object.keys(m).filter(function (k) { return m[k].n > 1; })
      .sort(function (a, b) { return m[b].n - m[a].n; }).slice(0, 10);
    if (!keys.length) {
      el.innerHTML = '<h3>Most repeated topics</h3>' + empty('Nothing delivered more than once yet.');
      return;
    }
    el.innerHTML = '<h3>Most repeated topics <span>— candidates to turn into a reusable asset</span></h3>' +
      '<div class="att">' + keys.map(function (k) {
        var o = m[k], cities = Object.keys(o.cities);
        return '<div class="ai up" style="cursor:default"><div class="ic">' + o.n + '×</div>' +
          '<div class="bd"><b>' + esc(o.title.replace(/\s*[-–]\s*.*$/, '')) + '</b>' +
          '<div class="mt">' + o.att + ' people reached' +
          (cities.length ? ' · ' + cities.slice(0, 5).map(esc).join(', ') : '') + '</div></div></div>';
      }).join('') + '</div>' +
      '<div class="hint2">Delivered this many times by hand? A recorded session or a partner-deliverable deck ' +
      'buys the time back.</div>';
  } },

/* --------------------------------------------------------------- reachcat */
{ id: 'reachcat', title: 'Reach by enablement category', width: 'half',
  render: function (el, c) {
    var en = c.acts.filter(function (r) { return r.kind === 'Enablement' && r.category; });
    el.innerHTML = '<h3>Reach by enablement category <span>— attendees</span></h3>' + canvas('p_rcat', true);
    var g = A.groupBy(en, 'category'), keys = A.sortKeys(g, 'att').slice(0, 12);
    if (!keys.length) { el.innerHTML = '<h3>Reach by enablement category</h3>' + empty('No categorised enablement activities.'); return; }
    A.hbar('p_rcat', keys, keys.map(function (k) { return g.get(k).att; }), '#00B87E', 'Attendees',
      { onPick: function (i) { drillTo('Category: ' + keys[i], g.get(keys[i]).rows, 'events'); } });
  } },

/* ------------------------------------------------------------- conversion */
{ id: 'conversion', title: 'Registration to attendance', width: 'half',
  render: function (el, c) {
    var rows = c.acts.filter(function (r) { return has(r.regs) && has(r.attendees); })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (!rows.length) {
      el.innerHTML = '<h3>Registration to attendance</h3>' +
        empty('No activity has both a registration and an attendee count yet. Fill both and this shows your show-rate trend.');
      return;
    }
    var reg = rows.reduce(function (s, r) { return s + num(r.regs); }, 0);
    var att = rows.reduce(function (s, r) { return s + num(r.attendees); }, 0);
    el.innerHTML = '<h3>Registration to attendance <span>— ' + rows.length + ' events with both numbers</span></h3>' +
      '<div class="stat"><div><b>' + Math.round(att / reg * 100) + '%</b>overall show rate</div>' +
      '<div><b>' + reg + '</b>registered</div><div><b>' + att + '</b>attended</div></div>' + canvas('p_conv');
    A.bar('p_conv', rows.map(function (r) { return A.niceDate(r.date); }), [
      { label: 'Registered', data: rows.map(function (r) { return num(r.regs); }), backgroundColor: '#D3EEFB', borderRadius: 3, maxBarThickness: 26 },
      { label: 'Attended', data: rows.map(function (r) { return num(r.attendees); }), backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 26 }
    ], { onPick: function (i) { drillTo(rows[i].title, [rows[i]], 'events'); } });
  } },

/* ------------------------------------------------------------------- zone */
{ id: 'zone', title: 'Zone coverage', width: 'half',
  render: function (el, c) {
    el.innerHTML = '<h3>Zone coverage <span>— activities and open opportunities</span></h3>' + canvas('p_zone');
    var zones = A.L.zone.filter(function (z) {
      return c.acts.some(function (a) { return a.zone === z; }) || c.opps.some(function (o) { return o.zone === z; });
    });
    A.bar('p_zone', zones, [
      { label: 'Enablement', data: zones.map(function (z) { return c.acts.filter(function (a) { return a.zone === z && a.kind === 'Enablement'; }).length; }),
        backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 22 },
      { label: 'Deal support', data: zones.map(function (z) { return c.acts.filter(function (a) { return a.zone === z && a.kind === 'Deal support'; }).length; }),
        backgroundColor: '#1CA8DD', borderRadius: 3, maxBarThickness: 22 },
      { label: 'Open opps', data: zones.map(function (z) { return c.opps.filter(function (o) { return o.zone === z && o.state === 'Open'; }).length; }),
        backgroundColor: '#97D700', borderRadius: 3, maxBarThickness: 22 }
    ], { onPick: function (i, zone, ds) {
      if (ds === 2) drillTo(zone + ' — open opportunities',
        c.opps.filter(function (o) { return o.zone === zone && o.state === 'Open'; }), 'pipe');
      else {
        var k = ds === 0 ? 'Enablement' : 'Deal support';
        drillTo(zone + ' — ' + k, c.acts.filter(function (a) { return a.zone === zone && a.kind === k; }), 'log');
      }
    } });
  } },

/* --------------------------------------------------------- partnereffect */
{ id: 'partnereffect', title: 'Partner effectiveness', width: 'half',
  render: function (el, c) {
    var m = {};
    var bump = function (name, key, by) {
      if (!name || ['Internal','Partner','End Customer'].indexOf(name) > -1) return;
      if (!m[name]) m[name] = { en: 0, ds: 0, opps: 0 };
      m[name][key] += (by || 1);
    };
    c.acts.forEach(function (a) {
      if (a.kind === 'Enablement') bump(a.partner, 'en', 1);
      if (a.kind === 'Deal support') bump(a.partner, 'ds', 1);
    });
    c.opps.forEach(function (o) { bump(o.partner, 'opps', 1); bump(o.distributor, 'opps', 1); });
    var names = Object.keys(m).sort(function (a, b) {
      return (m[b].en + m[b].ds + m[b].opps * 2) - (m[a].en + m[a].ds + m[a].opps * 2);
    }).slice(0, 12);
    if (!names.length) { el.innerHTML = '<h3>Partner effectiveness</h3>' + empty('No named partners in this filter.'); return; }
    el.innerHTML = '<h3>Partner effectiveness <span>— enablement given vs support consumed</span></h3>' + canvas('p_peff', true) +
      '<div class="hint2">A partner whose green bar grows while its blue bar shrinks is becoming self-sufficient. ' +
      'That is enablement doing its job.</div>';
    A.bar('p_peff', names, [
      { label: 'Enablement delivered', data: names.map(function (n) { return m[n].en; }), backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 12 },
      { label: 'Deal support given', data: names.map(function (n) { return m[n].ds; }), backgroundColor: '#1CA8DD', borderRadius: 3, maxBarThickness: 12 },
      { label: 'Opportunities', data: names.map(function (n) { return m[n].opps; }), backgroundColor: '#97D700', borderRadius: 3, maxBarThickness: 12 }
    ], { indexAxis: 'y',
         onPick: function (i, name, ds) {
           if (ds === 2) drillTo(name + ' — opportunities',
             c.opps.filter(function (o) { return o.partner === name || o.distributor === name; }), 'pipe');
           else {
             var k = ds === 0 ? 'Enablement' : 'Deal support';
             drillTo(name + ' — ' + k,
               c.acts.filter(function (a) { return a.partner === name && a.kind === k; }), 'log');
           }
         },
         scales: { x: { beginAtZero: true, grid: { color: '#EAECEE' }, ticks: { font: { size: 10.5 }, precision: 0 } },
                   y: { grid: { display: false }, ticks: { font: { size: 10 } } } } });
  } },

/* ----------------------------------------------------------- toppartner */
{ id: 'toppartner', title: 'Most active partners', width: 'half',
  render: function (el, c) {
    var g = A.groupBy(realPartners(c.acts), 'partner'), keys = A.sortKeys(g, 'n').slice(0, 12);
    if (!keys.length) { el.innerHTML = '<h3>Most active partners</h3>' + empty('No named partners in this filter.'); return; }
    el.innerHTML = '<h3>Most active partners <span>— activities logged</span></h3>' + canvas('p_tp', true);
    A.hbar('p_tp', keys, keys.map(function (k) { return g.get(k).n; }), '#8E71F4', 'Activities',
      { onPick: function (i) { drillTo('Partner: ' + keys[i], g.get(keys[i]).rows, 'log'); } });
  } },

/* ----------------------------------------------------------------- funnel */
{ id: 'funnel', title: 'Pipeline funnel', width: 'half',
  render: function (el, c) {
    var open = c.opps.filter(function (o) { return o.state === 'Open'; });
    var stages = A.L.stage.filter(function (s) { return s.indexOf('Closed') !== 0; });
    var max = 1;
    stages.forEach(function (s) {
      var n = open.filter(function (o) { return o.stage === s; }).length;
      if (n > max) max = n;
    });
    var won = c.opps.filter(function (o) { return o.stage === 'Closed-Won'; }).length;
    var lost = c.opps.filter(function (o) { return o.stage === 'Closed-Lost'; }).length;
    el.innerHTML = '<h3>Pipeline funnel <span>— ' + open.length + ' open, click a stage</span></h3>' +
      '<div class="funnel">' + stages.map(function (s) {
        var n = open.filter(function (o) { return o.stage === s; }).length, col = A.STAGE_COLOR[s];
        return '<div class="fn' + (n ? ' click' : '') + '" data-stage="' + esc(s) + '">' +
          '<div class="nm">' + esc(s) + '</div>' +
          '<div class="br"><i style="width:' + (n / max * 100) + '%;background:' + col + '"></i></div>' +
          '<div class="vl" style="color:' + (n ? col : '#b6bfc9') + '">' + n + '</div></div>';
      }).join('') +
      '<div class="hint2">Closed: <b style="color:var(--g-d)">' + won + ' won</b>, ' +
      '<b style="color:var(--red)">' + lost + ' lost</b>' +
      (won + lost ? ' — win rate ' + Math.round(won / (won + lost) * 100) + '%'
                  : ' — nothing closed yet, so no win rate. Set a stage to Closed-Won or Closed-Lost when deals land.') +
      '</div></div>';
    A.$$('[data-stage]', el).forEach(function (x) {
      x.onclick = function () { global.gotoPipeline(x.dataset.stage); };
    });
  } },

/* ---------------------------------------------------------------- product */
{ id: 'product', title: 'Product mix', width: 'half',
  render: function (el, c) {
    var g = A.groupBy(c.opps.filter(function (o) { return o.product; }), 'product');
    var keys = A.sortKeys(g, 'n');
    if (!keys.length) { el.innerHTML = '<h3>Product mix</h3>' + empty('No products recorded.'); return; }
    el.innerHTML = '<h3>Product mix <span>— open and closed opportunities</span></h3>' + canvas('p_prod');
    A.doughnut('p_prod', keys, keys.map(function (k) { return g.get(k).n; }),
      keys.map(function (k, i) { return A.PALETTE[i % A.PALETTE.length]; }),
      { onPick: function (i) { drillTo('Product: ' + keys[i], g.get(keys[i]).rows, 'pipe'); } });
  } },

/* --------------------------------------------------------------- availsum */
{ id: 'availsum', title: 'Availability & travel load', width: 'half',
  render: function (el, c) {
    var byMonth = {};
    S.availability.forEach(function (a) {
      var k = a.date.slice(0, 7);
      (byMonth[k] = byMonth[k] || []).push(a);
    });
    var mk = Object.keys(byMonth).sort();
    if (!mk.length) { el.innerHTML = '<h3>Availability &amp; travel load</h3>' + empty('No availability recorded yet.'); return; }
    var all = A.availStats(S.availability);
    var totalH = all.freeH + all.busyH + all.otherH;
    el.innerHTML = '<h3>Availability &amp; travel load <span>— all recorded days</span></h3>' +
      '<div class="stat">' +
      '<div><b style="color:var(--g-d)">' + all.freeH.toFixed(0) + 'h</b>free</div>' +
      '<div><b style="color:var(--red)">' + all.busyH.toFixed(0) + 'h</b>booked</div>' +
      '<div><b>' + (all.utilisation == null ? '—' : all.utilisation + '%') + '</b>utilisation</div>' +
      '<div><b style="color:var(--amber)">' + all.travelDays + '</b>travel days</div>' +
      '<div><b>' + all.travelPct + '%</b>of days travelling</div>' +
      '</div>' + canvas('p_avail') +
      (totalH ? '<div class="hint2">Utilisation is booked hours as a share of the hours you have actually marked up. ' +
                'You have filled in about ' + all.coverage + '% of your working slots.</div>'
              : '<div class="hint2">Paint some slots on the Availability tab and this fills in.</div>');
    A.bar('p_avail', mk.map(A.mKeyLabel), [
      { label: 'Free h', data: mk.map(function (k) { return +A.availStats(byMonth[k]).freeH.toFixed(1); }),
        backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 26 },
      { label: 'Booked h', data: mk.map(function (k) { return +A.availStats(byMonth[k]).busyH.toFixed(1); }),
        backgroundColor: '#ED2B3D', borderRadius: 3, maxBarThickness: 26 },
      { label: 'Travel days', data: mk.map(function (k) { return A.availStats(byMonth[k]).travelDays; }),
        backgroundColor: '#97D700', borderRadius: 3, maxBarThickness: 26 }
    ]);
  } },

/* ------------------------------------------------------------ partner COE */
{ id: 'coeready', title: 'Partner COE readiness', width: 'half',
  render: function (el, c) {
    var rows = S.coe.slice().sort(function (a, b) { return b.pct - a.pct; });
    if (!rows.length) {
      el.innerHTML = '<h3>Partner COE readiness</h3>' +
        empty('No partners on the COE programme yet — add one from the Partner COE tab.');
      return;
    }
    var avg = Math.round(rows.reduce(function (a, r) { return a + r.pct; }, 0) / rows.length);
    el.innerHTML = '<h3>Partner COE readiness <span>\u2014 ' + rows.length + ' partners, ' +
      avg + '% average</span></h3>' + canvas('p_coeready', rows.length > 6);
    A.hbar('p_coeready', rows.map(function (r) { return r.name.length > 26 ? r.name.slice(0, 25) + '\u2026' : r.name; }),
      rows.map(function (r) { return r.pct; }), '#00D15F', '% ready',
      { onPick: function (i) { global.openCoe(rows[i].id); } });
  } },

{ id: 'coedomain', title: 'COE readiness by domain', width: 'half',
  render: function (el, c) {
    if (!S.coe.length) {
      el.innerHTML = '<h3>COE readiness by domain</h3>' + empty('Nothing on the COE programme yet.');
      return;
    }
    var labels = A.COE_DOMAINS.map(function (d) { return d.short; });
    var vals = A.COE_DOMAINS.map(function (d) {
      var t = S.coe.reduce(function (a, r) { return a + r.domainPct[d.code]; }, 0);
      return Math.round(t / S.coe.length);
    });
    var weakest = A.COE_DOMAINS[vals.indexOf(Math.min.apply(null, vals))];
    el.innerHTML = '<h3>COE readiness by domain <span>\u2014 averaged across partners</span></h3>' +
      canvas('p_coedomain') +
      '<div class="hint2">Weakest across the portfolio: <b>' + esc(weakest.name) + '</b>. ' +
      'Each bar averages that domain over all COE partners, so it shows where enablement ' +
      'effort pays back widest.</div>';
    A.bar('p_coedomain', labels, [{ label: '% ready', data: vals,
      backgroundColor: vals.map(function (v) { return A.coeHeat(v); }),
      borderRadius: 3, maxBarThickness: 34 }], {
      onPick: function (i) { A.toast(A.COE_DOMAINS[i].name + ' \u2014 ' + vals[i] + '% across the portfolio', 4500); }
    });
  } },

{ id: 'coeattention', title: 'COE needs attention', width: 'half',
  render: function (el, c) {
    var blocked = S.coe.filter(function (r) { return r.blockers > 0; });
    var due = S.coe.filter(function (r) { return r.reviewDue != null && r.reviewDue <= 7; });
    var risk = S.coe.filter(function (r) { return r.rag === 'At risk' || r.rag === 'Delayed'; });
    var html = '<h3>COE needs attention</h3>';
    if (!blocked.length && !due.length && !risk.length) {
      el.innerHTML = html + empty('Nothing blocked, nothing overdue for review, nothing off track.');
      return;
    }
    var line = function (r, why, cls) {
      return '<div class="ai ' + cls + '" data-coe="' + esc(r.id) + '" style="cursor:pointer">' +
        '<div class="ic">' + r.pct + '%</div><div class="bd"><b>' + esc(r.name) + '</b> \u2014 ' + why + '</div></div>';
    };
    var out = [];
    blocked.forEach(function (r) {
      out.push(line(r, r.blockers + ' item' + (r.blockers > 1 ? 's' : '') + ' blocked', 'od'));
    });
    risk.forEach(function (r) {
      if (!r.blockers) out.push(line(r, r.rag.toLowerCase(), 'ms'));
    });
    due.forEach(function (r) {
      if (!r.blockers && risk.indexOf(r) < 0) {
        out.push(line(r, r.reviewDue < 0 ? 'review ' + Math.abs(r.reviewDue) + ' days overdue'
                                         : 'review in ' + r.reviewDue + ' days', 'st'));
      }
    });
    el.innerHTML = html + '<div class="att">' + out.join('') + '</div>';
    A.$$('[data-coe]', el).forEach(function (x) {
      x.onclick = function () { global.openCoe(x.dataset.coe); };
    });
  } },

/* ------------------------------------------------------------ travel time */
{ id: 'traveltime', title: 'Travel vs meeting time', width: 'half',
  render: function (el, c) {
    var t = A.travelStats(c.acts);
    var base = A.homeBases().map(function (x) { return x.replace(/\b\w/g, function (m) { return m.toUpperCase(); }); });
    var cities = Object.keys(t.cities).sort(function (a, b) { return t.cities[b] - t.cities[a]; });

    el.innerHTML = '<h3>Travel vs meeting time <span>\u2014 based in ' + esc(base.join(' / ')) + '</span></h3>' +
      kpi([
        ['Travel days', t.travelDays, t.detected ? t.detected + ' found from the log' : 'all marked by you', 'acc'],
        ['Hours away', t.awayHours, 'meetings done out of base', 'acc'],
        ['Hours at base', t.homeHours, 'online or local', ''],
        ['Cities', t.cityCount, cities.slice(0, 2).join(', ') || '\u2014', '']
      ]) +
      '<div class="stat" style="margin-top:4px">' +
        '<div><b style="color:var(--g-d)">' + t.meetingHoursOnTravelDays + 'h</b>in meetings on travel days</div>' +
        '<div><b style="color:#FE8A25">' + t.otherHoursOnTravelDays + 'h</b>travelling &amp; everything else</div>' +
      '</div>' + canvas('p_travelsplit') +
      (t.unknownHours
        ? '<div class="hint2"><b>' + t.unknownHours + ' hours cannot be placed.</b> ' +
          'Travel is worked out from <b>delivery mode</b> \u2014 in-person somewhere other than ' +
          esc(base[0]) + ' means you travelled. Activities with no mode set cannot be judged either way. ' +
          'Fill it in from <b>Data \u2192 Data health \u2192 No mode</b> and these hours move into the right column.</div>'
        : '<div class="hint2">Every activity says whether it was in-person or online, so the split above is complete.</div>');

    /* The working time on travel days. The remainder is named honestly: not
       logged, rather than claimed to be all flying. */
    A.doughnut('p_travelsplit',
      ['Meetings on travel days', 'Travel & unlogged'],
      [t.meetingHoursOnTravelDays, t.otherHoursOnTravelDays],
      ['#00D15F', '#FE8A25'],
      { onPick: function (i) {
          if (i !== 0) { A.toast('Unlogged time has no records behind it \u2014 that is rather the point'); return; }
          drillTo('Activities on travel days',
            c.acts.filter(function (a) { return t.index[a.date]; }), 'log');
        } });
  } },

/* ----------------------------------------------------------------- travel */
{ id: 'travel', title: 'Where I will be', width: 'half',
  render: function (el, c) {
    var td = A.today();
    var up = S.availability.filter(function (a) { return a.fullDay === 'Travelling' && a.date >= td; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    /* collapse consecutive days in the same city into one trip */
    var trips = [];
    up.forEach(function (a) {
      var last = trips[trips.length - 1];
      if (last && last.city === (a.travelCity || '') && A.daysBetween(last.to, a.date) <= 1) { last.to = a.date; last.days++; }
      else trips.push({ city: a.travelCity || '', from: a.date, to: a.date, days: 1, notes: a.notes || '' });
    });
    el.innerHTML = '<h3>Where I will be <span>— upcoming travel</span></h3>' +
      (trips.length
        ? trips.slice(0, 12).map(function (t) {
            return '<div class="trip"><div class="ci">' + esc(t.city || 'Travelling') +
              (t.notes ? '<div class="src" style="font-weight:400;margin-top:1px">' + esc(t.notes) + '</div>' : '') +
              '</div>' +
              '<div class="dt3">' + A.niceDate(t.from) + (t.from !== t.to ? ' – ' + A.niceDate(t.to) : '') + '</div>' +
              '<div class="nd">' + t.days + 'd · in ' + A.daysBetween(td, t.from) + 'd</div></div>';
          }).join('') +
          '<div class="hint2">Set a whole day to Travelling with a city on the Availability tab and it appears here. ' +
          'Useful to send to an account manager who wants to piggyback on a trip.</div>'
        : empty('No upcoming travel booked.'));
  } },

/* -------------------------------------------------------------- conflicts */
{ id: 'conflicts', title: 'Diary conflicts', width: 'half',
  render: function (el, c) {
    var list = S.conflicts();
    el.innerHTML = '<h3>Diary conflicts' + (list.length ? ' <span>— ' + list.length + ' to look at</span>' : '') + '</h3>' +
      (list.length
        ? '<div class="att">' + list.slice(0, 20).map(function (x, i) {
            return '<div class="ai ' + (x.type === 'Overlap' ? 'od' : 'st') + '" data-c="' + i + '">' +
              '<div class="ic">' + esc(x.type.split(' ')[0]) + '</div>' +
              '<div class="bd">' + esc(x.msg) + '<div class="mt">' + A.longDate(x.date) + '</div></div></div>';
          }).join('') + '</div>'
        : empty('Nothing clashes. No activity sits on a travel or holiday day, and nothing overlaps.'));
    A.$$('[data-c]', el).forEach(function (n) {
      n.onclick = function () { global.openAct(list[+n.dataset.c].a.id); };
    });
  } },

/* --------------------------------------------------------------- levelmix */
{ id: 'levelmix', title: 'Training level mix', width: 'half', off: true,
  render: function (el, c) {
    var rows = c.acts.filter(function (r) { return r.level; });
    if (!rows.length) { el.innerHTML = '<h3>Training level mix</h3>' + empty('No trainings have a level set.'); return; }
    var g = A.groupBy(rows, 'level'), keys = A.sortKeys(g, 'n');
    el.innerHTML = '<h3>Training level mix <span>— Foundation targets Registered &amp; Silver, Advanced targets Gold &amp; Platinum</span></h3>' +
      '<div class="stat">' + keys.map(function (k) {
        return '<div><b style="color:' + (A.LEVEL_COLOR[k] || '#8b95a3') + '">' + g.get(k).n + '</b>' + esc(k) +
               ' · ' + g.get(k).att + ' people</div>';
      }).join('') + '</div>' + canvas('p_lvl');
    A.doughnut('p_lvl', keys, keys.map(function (k) { return g.get(k).n; }),
      keys.map(function (k) { return A.LEVEL_COLOR[k] || '#8b95a3'; }),
      { onPick: function (i) { drillTo('Level: ' + keys[i], g.get(keys[i]).rows, 'events'); } });
  } },

/* ------------------------------------------------------------------- tier */
{ id: 'tier', title: 'Partner tier coverage', width: 'half', off: true,
  render: function (el, c) {
    var withTier = S.partners.filter(function (p) { return p.tier; });
    if (!withTier.length) {
      el.innerHTML = '<h3>Partner tier coverage</h3>' +
        empty('No partner has a tier yet. Set Registered / Silver / Gold / Platinum on the Data tab and this shows which tiers you are actually reaching.');
      return;
    }
    var acts = {};
    c.acts.forEach(function (a) {
      var k = A.partnerKey(a.partner);
      if (k) acts[k] = (acts[k] || 0) + 1;
    });
    var tiers = A.L.tier.filter(function (t) { return withTier.some(function (p) { return p.tier === t; }); });
    el.innerHTML = '<h3>Partner tier coverage <span>— partners and activities by tier</span></h3>' + canvas('p_tier');
    A.bar('p_tier', tiers, [
      { label: 'Partners', data: tiers.map(function (t) {
          return withTier.filter(function (p) { return p.tier === t; }).length; }),
        backgroundColor: '#1CA8DD', borderRadius: 3, maxBarThickness: 30 },
      { label: 'Activities', data: tiers.map(function (t) {
          return withTier.filter(function (p) { return p.tier === t; })
            .reduce(function (s, p) { return s + (acts[p.key] || 0); }, 0); }),
        backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 30 }
    ]);
  } },

/* ----------------------------------------------------------- outlookload */
{ id: 'outlookload', title: 'Outlook load', width: 'half',
  render: function (el, c) {
    if (!S.outlookOn()) {
      el.innerHTML = '<h3>Outlook load</h3>' +
        empty('Outlook is not connected. Once it is, this shows how much of your week is already ' +
              'taken by meetings before you plan anything.');
      return;
    }
    var td = A.today(), days = [], step = CFG.slotMinutes || 30;
    for (var i = 0; i < 14; i++) {
      var d = A.addDays(td, i);
      if (A.hiddenDay(d)) continue;
      days.push(d);
    }
    var slotsPerDay = A.slotList().length;
    var mins = days.map(function (d) { return S.outlookMinutes(d); });
    var totalH = mins.reduce(function (a, b) { return a + b; }, 0) / 60;
    var capacityH = days.length * slotsPerDay * step / 60;
    el.innerHTML = '<h3>Outlook load <span>— next two working weeks</span></h3>' +
      '<div class="stat">' +
      '<div><b>' + totalH.toFixed(1) + 'h</b>already booked</div>' +
      '<div><b>' + (capacityH - totalH).toFixed(1) + 'h</b>left in the day</div>' +
      '<div><b>' + (capacityH ? Math.round(totalH / capacityH * 100) : 0) + '%</b>of your working hours</div>' +
      '</div>' + canvas('p_olload') +
      '<div class="hint2">Straight from your Outlook calendar. Meeting subjects are not copied — ' +
      'only the hours, which is what matters for planning.</div>';
    A.bar('p_olload', days.map(function (d) { return A.niceDate(d); }),
      [{ label: 'Booked hours', data: mins.map(function (m) { return +(m / 60).toFixed(1); }),
         backgroundColor: '#505861', borderRadius: 3, maxBarThickness: 24 }]);
  } },

/* ---------------------------------------------------------------- quarter */
{ id: 'quarter', title: 'Quarterly review', width: 'wide',
  render: function (el, c) {
    var qs = S.quarters();
    if (!qs.length) { el.innerHTML = '<h3>Quarterly review</h3>' + empty('No dated activities yet.'); return; }
    var qk = global.dashQuarter || (qs.indexOf(A.qKey(A.today())) > -1 ? A.qKey(A.today()) : qs[qs.length - 1]);
    if (qs.indexOf(qk) === -1) qk = qs[qs.length - 1];
    global.dashQuarter = qk;
    var months = A.quarterMonths(qk);
    var rows = c.acts.filter(function (r) { return A.qKey(r.date) === qk; });
    var st = A.actStats(rows);
    var pi = qs.indexOf(qk) - 1;
    var prev = pi >= 0 ? c.acts.filter(function (r) { return A.qKey(r.date) === qs[pi]; }) : [];
    var pst = A.actStats(prev);
    var delta = function (a, b) {
      if (!b) return 'no prior quarter';
      var d = Math.round((a - b) / b * 100);
      return (d >= 0 ? '▲ ' : '▼ ') + Math.abs(d) + '% vs ' + A.qLabel(qs[pi]);
    };
    var gz = A.groupBy(rows, 'zone'), zTop = A.sortKeys(gz, 'n')[0];
    var gc = A.groupBy(rows.filter(function (r) { return r.category; }), 'category'), cTop = A.sortKeys(gc, 'n')[0];

    el.innerHTML =
      '<div class="calhead no-print"><h3 style="margin:0">Quarterly review</h3>' +
      '<select id="p_qpick" style="border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:12.5px">' +
      qs.map(function (k) { return '<option value="' + k + '"' + (k === qk ? ' selected' : '') + '>' + A.qLabel(k) + '</option>'; }).join('') +
      '</select><button class="btn sm" id="p_qprint" style="margin-left:auto">Print this review</button></div>' +
      '<div class="bigq"><h2>' + qk.split('-')[1] + ' ' + qk.split('-')[0] + '</h2>' +
      '<span class="badge">' + A.mKeyLabel(months[0]) + ' – ' + A.mKeyLabel(months[2]) + '</span></div>' +
      '<div class="qsum" style="margin-bottom:12px">' + (st.n
        ? 'Logged <b>' + st.n + ' activities</b> — <b>' + st.enable + '</b> enablement reaching <b>' +
          st.att.toLocaleString() + ' people</b>, and <b>' + st.deal + '</b> deal-support interactions, across <b>' +
          st.cities + ' cities</b>. ' + (zTop ? 'Busiest zone <b>' + esc(zTop) + '</b> (' + gz.get(zTop).n + '). ' : '') +
          (cTop ? 'Main enablement focus <b>' + esc(cTop) + '</b>. ' : '') +
          (st.slipped ? '<b>' + st.slipped + '</b> slipped or cancelled.' : 'Nothing slipped.')
        : 'Nothing recorded in this quarter for the current filter.') + '</div>' +
      kpi([
        ['Activities', st.n, prev.length ? delta(st.n, pst.n) : 'no prior quarter', 'acc'],
        ['Enablement', st.enable, st.deal + ' deal support', ''],
        ['People reached', st.att.toLocaleString(), prev.length ? delta(st.att, pst.att) : '—', 'acc'],
        ['Hours', st.hours, 'logged this quarter', ''],
        ['In-person', st.inperson, st.n ? Math.round(st.inperson / st.n * 100) + '% of activities' : '—', ''],
        ['Cities', st.cities, st.zones + ' zones', ''],
        ['Show rate', st.conv == null ? '—' : st.conv + '%', st.reg ? st.reg + ' registrations' : 'no registration data', ''],
        ['Slipped', st.slipped, 'rescheduled or cancelled', st.slipped ? 'warn' : '']
      ]) +
      '<div class="grid two" style="margin-top:12px">' +
      '<div class="card" style="background:#fbfcfd"><h3>Quarter on quarter</h3>' + canvas('p_qoq') + '</div>' +
      '<div class="card" style="background:#fbfcfd"><h3>Month split</h3>' + canvas('p_qmon') + '</div></div>';

    A.bar('p_qoq', qs.map(A.qLabel), [
      { label: 'Enablement', data: qs.map(function (k) {
          return c.acts.filter(function (r) { return A.qKey(r.date) === k && r.kind === 'Enablement'; }).length; }),
        backgroundColor: qs.map(function (k) { return k === qk ? '#00D15F' : '#CFF6E1'; }), borderRadius: 3, maxBarThickness: 30 },
      { label: 'Deal support', data: qs.map(function (k) {
          return c.acts.filter(function (r) { return A.qKey(r.date) === k && r.kind === 'Deal support'; }).length; }),
        backgroundColor: qs.map(function (k) { return k === qk ? '#1CA8DD' : '#D3EEFB'; }), borderRadius: 3, maxBarThickness: 30 }
    ], { stacked: true });
    A.bar('p_qmon', months.map(A.mKeyLabel), [
      { label: 'Activities', data: months.map(function (k) { return inMonth(rows, k).length; }),
        backgroundColor: '#00D15F', borderRadius: 3, maxBarThickness: 44 },
      { label: 'Attendees', data: months.map(function (k) {
          return inMonth(rows, k).reduce(function (s, r) { return s + num(r.attendees); }, 0); }),
        backgroundColor: '#BEE7FA', borderRadius: 3, maxBarThickness: 44 }
    ]);
    var sel = A.$('#p_qpick', el);
    if (sel) sel.onchange = function () { global.dashQuarter = sel.value; global.renderDash(); };
    var pr = A.$('#p_qprint', el);
    if (pr) pr.onclick = function () { window.print(); };
  } },

/* ---------------------------------------------------------------- heatmap */
{ id: 'heatmap', title: 'Zone by quarter heatmap', width: 'half', off: true,
  render: function (el, c) {
    var qs = S.quarters();
    var zones = A.L.zone.filter(function (z) { return c.acts.some(function (r) { return r.zone === z; }); });
    if (!qs.length || !zones.length) { el.innerHTML = '<h3>Zone by quarter</h3>' + empty('Not enough data yet.'); return; }
    var max = 1;
    zones.forEach(function (z) { qs.forEach(function (k) {
      var v = c.acts.filter(function (r) { return r.zone === z && A.qKey(r.date) === k; }).length;
      if (v > max) max = v; }); });
    el.innerHTML = '<h3>Zone by quarter <span>— activity counts</span></h3><div style="overflow-x:auto">' +
      '<table class="dt"><thead><tr><th>Zone</th>' +
      qs.map(function (k) { return '<th style="text-align:center">' + A.qLabel(k) + '</th>'; }).join('') +
      '<th style="text-align:center">Total</th></tr></thead><tbody>' +
      zones.map(function (z) {
        var tot = 0;
        var cells = qs.map(function (k) {
          var v = c.acts.filter(function (r) { return r.zone === z && A.qKey(r.date) === k; }).length;
          tot += v;
          var a = v ? (0.12 + 0.78 * v / max) : 0;
          return '<td style="text-align:center;background:rgba(0,179,54,' + a.toFixed(2) + ');font-weight:' +
                 (v ? 700 : 400) + ';color:' + (a > .55 ? '#fff' : 'inherit') + '">' + (v || '·') + '</td>';
        }).join('');
        return '<tr style="cursor:default"><td style="font-weight:600">' + esc(z) + '</td>' + cells +
               '<td style="text-align:center;font-weight:700">' + tot + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  } },

/* --------------------------------------------------------------- industry */
{ id: 'industry', title: 'Industry spread', width: 'half', off: true,
  render: function (el, c) {
    var g = A.groupBy(c.opps.filter(function (o) { return o.industry; }), 'industry');
    var keys = A.sortKeys(g, 'n');
    if (!keys.length) { el.innerHTML = '<h3>Industry spread</h3>' + empty('No industries recorded.'); return; }
    el.innerHTML = '<h3>Industry spread <span>— opportunities</span></h3>' + canvas('p_ind', true);
    A.hbar('p_ind', keys, keys.map(function (k) { return g.get(k).n; }), '#1CA8DD', 'Opportunities',
      { onPick: function (i) { drillTo('Industry: ' + keys[i], g.get(keys[i]).rows, 'pipe'); } });
  } },

/* ------------------------------------------------------------ stakeholder */
{ id: 'stakeholder', title: 'Activity by Veeam stakeholder', width: 'half', off: true,
  render: function (el, c) {
    var g = A.groupBy(c.acts.filter(function (r) { return r.veeamStakeholder; }), 'veeamStakeholder');
    var keys = A.sortKeys(g, 'n').slice(0, 14);
    if (!keys.length) { el.innerHTML = '<h3>Activity by Veeam stakeholder</h3>' + empty('No stakeholders recorded.'); return; }
    el.innerHTML = '<h3>Activity by Veeam stakeholder <span>— who I work with most</span></h3>' + canvas('p_stake', true);
    A.hbar('p_stake', keys, keys.map(function (k) { return g.get(k).n; }), '#00B87E', 'Activities',
      { onPick: function (i) { drillTo('Stakeholder: ' + keys[i], g.get(keys[i]).rows, 'log'); } });
  } },

/* --------------------------------------------------------- attention */
{ id: 'attention', title: 'Needs my attention', width: 'wide',
  render: function (el, c) {
    var items = [], td = A.today(), wk = A.addDays(td, 7);
    c.os.overdue.slice().sort(function (a, b) { return a.followUpDate.localeCompare(b.followUpDate); })
      .forEach(function (o) {
        items.push({ cls: 'od', tag: 'Overdue',
          html: '<b>' + esc(o.customer || o.name) + '</b> — follow-up was due ' + A.niceDate(o.followUpDate) +
                ', ' + A.daysAgo(o.followUpDate) + ' days ago',
          meta: [o.nextAction || 'no next action set', A.stagePill(o.stage), o.veeamStakeholder].filter(Boolean).join(' · '),
          go: function () { global.openOppView(o.id); } });
      });
    c.opps.filter(function (o) { return o.state === 'Open' && o.followUpDate >= td && o.followUpDate <= wk; })
      .forEach(function (o) {
        items.push({ cls: 'up', tag: 'Due', html: '<b>' + esc(o.customer || o.name) + '</b> — follow-up ' + A.niceDate(o.followUpDate),
          meta: [o.nextAction, o.veeamStakeholder].filter(Boolean).join(' · '),
          go: function () { global.openOppView(o.id); } });
      });
    c.as.missingAtt.forEach(function (r) {
      items.push({ cls: 'ms', tag: 'No count',
        html: '<b>' + esc(r.title) + '</b> on ' + A.niceDate(r.date) + ' is Completed but has no attendee number',
        meta: [r.type, r.partner].filter(Boolean).join(' · '), go: function () { global.openAct(r.id); } });
    });
    c.os.stale.slice().sort(function (a, b) { return (b.daysSinceTouch || 0) - (a.daysSinceTouch || 0); })
      .slice(0, 10).forEach(function (o) {
        items.push({ cls: 'st', tag: 'Quiet', html: '<b>' + esc(o.customer || o.name) + '</b> — nothing logged for ' + o.daysSinceTouch + ' days',
          meta: [A.stagePill(o.stage), o.partner || 'no partner'].filter(Boolean).join(' · '),
          go: function () { global.openOppView(o.id); } });
      });
    c.as.noOpp.slice(0, 6).forEach(function (r) {
      items.push({ cls: 'ms', tag: 'Unlinked',
        html: '<b>' + esc(r.title) + '</b> on ' + A.niceDate(r.date) + ' is not linked to an opportunity',
        meta: [r.type, r.partner].filter(Boolean).join(' · '), go: function () { global.openAct(r.id); } });
    });

    el.innerHTML = '<h3>Needs my attention' + (items.length ? ' <span>— ' + items.length + ' items</span>' : '') + '</h3>' +
      (items.length
        ? '<div class="att">' + items.slice(0, 40).map(function (it, i) {
            return '<div class="ai ' + it.cls + '" data-i="' + i + '"><div class="ic">' + it.tag + '</div>' +
                   '<div class="bd">' + it.html + '<div class="mt">' + it.meta + '</div></div></div>';
          }).join('') + '</div>'
        : empty('Nothing to chase. Every follow-up is current and every completed event has its numbers.'));
    A.$$('[data-i]', el).forEach(function (x) { x.onclick = jump(items[+x.dataset.i].go); });
  } }
];

global.PANELS = PANELS;
})(window);
