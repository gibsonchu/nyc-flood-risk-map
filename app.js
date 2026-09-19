/* NYC Flood Risk Map
   Every building in the five boroughs, checked against the city's stormwater flood
   models and FEMA's coastal zones. Data prepared by tools/build_data.py from the
   DEP / DCP / FEMA overlay in the "flood maps" research folder. */

/* ── constants ────────────────────────────────────────── */

const C = {                                   // category colours, as [r,g,b]
  nuisance: [245, 197, 66],
  deep:     [228, 85,  63],
  tide:     [73,  185, 214],
  none:     [56,  69,  90],
  coastal:  [165, 131, 240],
};
const HEX = { nuisance:'#F5C542', deep:'#E4553F', tide:'#49B9D6', none:'#38455A', coastal:'#A583F0' };

const BIT = {                                 // must match tools/build_data.py
  ext1:1, ext2:2, ext3:4, mod1:8, mod2:16,
  slr1:32, slr2:64, slr3:128, coastal:256, coastalV:512,
};

// Each scenario is a rainfall rate paired with a sea level. bits are ordered
// [nuisance, deep, future high tide]; 0 means the scenario has no such category.
const SCEN = {
  ext: {
    label:'Extreme storm', sub:'3.66 in/hr rain · 2080 sea level',
    bits:[BIT.ext1, BIT.ext2, BIT.ext3], agg:'anyExt', year:2080,
    note:'Hurricane Ida dropped 3.15 in/hr on Central Park in September 2021.',
  },
  slr: {
    label:'Moderate storm, 2050 seas', sub:'2.13 in/hr rain · 2050 sea level',
    bits:[BIT.slr1, BIT.slr2, BIT.slr3], agg:'anySlr', year:2050,
    note:'The same rain as today’s moderate storm, arriving on a higher ocean.',
  },
  mod: {
    label:'Moderate storm, today', sub:'2.13 in/hr rain · current sea level',
    bits:[BIT.mod1, BIT.mod2, 0], agg:'anyMod', year:null,
    note:'Roughly the storm New York already gets every few years.',
  },
};
const SCEN_KEYS = ['ext','slr','mod'];

// Shares of flooded lots per ZIP run from a median of 27% under the extreme storm to
// 2% under today's moderate one, so each scenario gets its own breaks.
const RAMP = ['#0E1720','#15384C','#1E6F86','#3FAFC0','#E8C558','#E48B3C','#DE4433'];
const STOPS = {
  ext: [0, 0.08, 0.17, 0.27, 0.40, 0.65, 0.90],
  slr: [0, 0.01, 0.03, 0.07, 0.12, 0.27, 0.55],
  mod: [0, 0.005, 0.02, 0.05, 0.09, 0.16, 0.35],
};
const zipColorExpr = () => ['interpolate', ['linear'], ['get', 'v'],
  ...STOPS[scenario].flatMap((v, i) => [v, RAMP[i]])];

const CAT_NAME = {
  nuisance:'Nuisance flooding', deep:'Deep &amp; contiguous flooding',
  tide:'Future high tide', none:'Not in a modeled flood area',
};

const USE_GROUPS = [
  { id:'home',  label:'1–2 family',   lus:[1] },
  { id:'apt',   label:'Apartments',   lus:[2,3] },
  { id:'mixed', label:'Mixed use',    lus:[4] },
  { id:'comm',  label:'Commercial',   lus:[5] },
  { id:'ind',   label:'Industrial',   lus:[6] },
  { id:'civic', label:'Public',       lus:[7,8] },
  { id:'other', label:'Other',        lus:[0,9,10,11] },
];

const BORO_FROM_BBL = { 1:'MN', 2:'BX', 3:'BK', 4:'QN', 5:'SI' };

const fmt  = n => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');
const pct  = v => (v * 100 < 1 && v > 0) ? '<1%' : Math.round(v * 100) + '%';
const pct1 = v => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
const $ = s => document.querySelector(s);

/* ── state ────────────────────────────────────────────── */

let META, ZIPS, HOODS, N = 0, V = '';
let POS, FLAGS, ATTR, COLORS, RADII;         // typed arrays over mapped buildings
let SHOW, SHOW_COASTAL;                      // 1/0 masks for DataFilterExtension
let GRID = null;                              // CSR spatial index for nearest-lookup
let map, overlay;
let scenario = 'ext';
let coastalOn = false;
let bsmtOnly = false;
let useSel = new Set();
let view = 'buildings';
let selected = null;                          // { idx, rec, group }
let hoverIdx = -1, hoverZip = null;
const detailCache = new Map(), bblCache = new Map();

/* ── boot ─────────────────────────────────────────────── */

(async function init() {
  const step = (p, msg) => {
    $('#boot-fill').style.width = p + '%';
    if (msg) $('#boot-msg').textContent = msg;
  };
  try {
    step(8, 'Loading flood models…');
    META = await fetch('data/meta.json').then(r => r.json());
    N = META.mapped;
    V = META.build ? '?v=' + META.build : '';

    step(20, `Loading ${fmt(META.total)} buildings…`);
    const [buf, zips, hoods] = await Promise.all([
      fetch('data/points.bin' + V).then(r => r.arrayBuffer()),
      fetch('data/zips.json' + V).then(r => r.json()),
      fetch('data/neighborhoods.json' + V).then(r => r.json()),
    ]);
    ZIPS = zips; HOODS = hoods;

    step(62, 'Placing buildings…');
    decodePoints(buf);
    buildGrid();

    step(80, 'Drawing the map…');
    buildMap();
    buildUI();
    recolor();

    // A tab that loads while backgrounded gets no animation frames, so MapLibre can
    // finish its style and then sit unpainted. Nudge it when the page comes forward.
    const nudge = () => { if (map) { map.resize(); map.triggerRepaint(); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) nudge(); });
    addEventListener('pageshow', nudge);
    addEventListener('resize', nudge);
    setTimeout(nudge, 500);

    step(100, 'Ready');
    setTimeout(() => $('#boot').classList.add('gone'), 260);
    setTimeout(() => $('#boot').remove(), 900);
  } catch (err) {
    console.error(err);
    $('#boot-msg').innerHTML =
      'Could not load the map data.<br><small style="opacity:.7">' +
      String(err.message || err).slice(0, 120) + '</small>';
  }
})();

/* ── decode ───────────────────────────────────────────── */

function decodePoints(buf) {
  const qlat = new Uint16Array(buf, 0, N);
  const qlon = new Uint16Array(buf, N * 2, N);
  FLAGS      = new Uint16Array(buf, N * 4, N);
  ATTR       = new Uint8Array (buf, N * 6, N);

  const [lon0, lat0, lon1, lat1] = META.bbox;
  const sLat = (lat1 - lat0) / 65535, sLon = (lon1 - lon0) / 65535;

  // Float32 keeps ~0.3 m precision at NYC's longitude, which is finer than the
  // quantisation already applied in the build step, and deck.gl takes it directly.
  POS = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    POS[i * 2]     = lon0 + qlon[i] * sLon;
    POS[i * 2 + 1] = lat0 + qlat[i] * sLat;
  }
  QLAT = qlat; QLON = qlon;
  COLORS = new Uint8Array(N * 4);
  RADII  = new Float32Array(N);
  // radiusMinPixels would clamp a zero radius back up to a visible dot, so hiding a
  // building is done with a filter mask instead of by shrinking it away.
  SHOW = new Float32Array(N);
  SHOW_COASTAL = new Float32Array(N);
}
let QLAT, QLON;

/* A flat counting-sorted grid over the quantised coordinates, so a click on empty
   map still finds the building nearest the cursor without a 900k-entry Map. */
const CELL = 256, GW = 256;
function buildGrid() {
  const counts = new Uint32Array(GW * GW + 1);
  const cellOf = i => ((QLAT[i] >> 8) * GW) + (QLON[i] >> 8);
  for (let i = 0; i < N; i++) counts[cellOf(i) + 1]++;
  for (let c = 0; c < GW * GW; c++) counts[c + 1] += counts[c];
  const items = new Uint32Array(N), cursor = counts.slice(0, GW * GW);
  for (let i = 0; i < N; i++) items[cursor[cellOf(i)]++] = i;
  GRID = { start: counts, items };
}

function nearestTo(lon, lat, maxMeters = 260) {
  const [lon0, lat0, lon1, lat1] = META.bbox;
  const qx = Math.round((lon - lon0) / (lon1 - lon0) * 65535);
  const qy = Math.round((lat - lat0) / (lat1 - lat0) * 65535);
  const cx = Math.max(0, Math.min(GW - 1, qx >> 8));
  const cy = Math.max(0, Math.min(GW - 1, qy >> 8));
  const mPerLat = 111320, mPerLon = 111320 * Math.cos(lat * Math.PI / 180);
  let best = -1, bestD = Infinity;
  for (let ring = 0; ring <= 3; ring++) {
    for (let gy = cy - ring; gy <= cy + ring; gy++) {
      if (gy < 0 || gy >= GW) continue;
      for (let gx = cx - ring; gx <= cx + ring; gx++) {
        if (gx < 0 || gx >= GW) continue;
        if (ring && Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue;
        const c = gy * GW + gx;
        for (let k = GRID.start[c]; k < GRID.start[c + 1]; k++) {
          const i = GRID.items[k];
          const dx = (POS[i * 2] - lon) * mPerLon, dy = (POS[i * 2 + 1] - lat) * mPerLat;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best >= 0 && Math.sqrt(bestD) <= (ring + 1) * 180) break;
  }
  return (best >= 0 && Math.sqrt(bestD) <= maxMeters) ? best : -1;
}

/* ── risk logic ───────────────────────────────────────── */

// Tidal inundation outranks a storm: it is the chronic condition, not an event.
function categoryOf(flags, scen) {
  const [n, d, t] = SCEN[scen].bits;
  if (t && (flags & t)) return 'tide';
  if (flags & d) return 'deep';
  if (flags & n) return 'nuisance';
  return 'none';
}
function passesFilter(i) {
  if (bsmtOnly) { const b = ATTR[i] & 7; if (b !== 2 && b !== 4) return false; }
  if (useSel.size) { const lu = ATTR[i] >> 3; if (!useSel.has(lu)) return false; }
  return true;
}

function recolor() {
  const s = SCEN[scenario];
  const [bn, bd, bt] = s.bits;
  let shown = 0, risky = 0;
  for (let i = 0; i < N; i++) {
    if (!passesFilter(i)) { SHOW[i] = 0; SHOW_COASTAL[i] = 0; continue; }
    SHOW[i] = 1;
    shown++;
    const f = FLAGS[i];
    let c, r, a;
    if (bt && (f & bt))      { c = C.tide;     r = 6.5; a = 240; risky++; }
    else if (f & bd)         { c = C.deep;     r = 6.5; a = 240; risky++; }
    else if (f & bn)         { c = C.nuisance; r = 6.2; a = 230; risky++; }
    else                     { c = C.none;     r = 4.6; a = 140; }
    const o = i * 4;
    COLORS[o] = c[0]; COLORS[o + 1] = c[1]; COLORS[o + 2] = c[2]; COLORS[o + 3] = a;
    RADII[i] = r;
    SHOW_COASTAL[i] = (f & BIT.coastal) ? 1 : 0;
  }
  if (overlay) drawLayers();
  updateCounts(shown, risky);
}

/* ── map ──────────────────────────────────────────────── */

function buildMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [-73.94, 40.70], zoom: 10.1, minZoom: 9, maxZoom: 19,
    maxBounds: [[-74.75, 40.25], [-73.2, 41.15]],
    attributionControl: { compact: true },
    dragRotate: false, pitchWithRotate: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true }, showAccuracyCircle: false,
  }), 'bottom-right');
  map.touchZoomRotate.disableRotation();

  map.on('load', async () => {
    // Mute the basemap's own water/labels a little so the dots carry the image.
    try {
      map.setPaintProperty('water', 'fill-color', '#0B1A24');
    } catch (e) { /* style ids vary; not worth failing over */ }

    const gj = await fetch('data/zips.geojson' + V).then(r => r.json());
    gj.features.forEach(ft => {
      const z = ZIPS[ft.properties.z];
      ft.properties.v = z ? z[SCEN[scenario].agg] : 0;
      ft.properties.nm = z && z.detailed ? z.detailed : 'ZIP ' + ft.properties.z;
    });
    map.addSource('zips', { type: 'geojson', data: gj, promoteId: 'z' });
    map.addLayer({
      id: 'zip-fill', type: 'fill', source: 'zips',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': zipColorExpr(),
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.9, 0.7],
      },
    });
    map.addLayer({
      id: 'zip-line', type: 'line', source: 'zips',
      layout: { visibility: 'none' },
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#E8EEF6', '#0A1017'],
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.8, 0.6],
      },
    });

    map.on('mousemove', 'zip-fill', e => {
      const f = e.features[0]; if (!f) return;
      if (hoverZip && hoverZip !== f.id) map.setFeatureState({ source:'zips', id:hoverZip }, { hover:false });
      hoverZip = f.id;
      map.setFeatureState({ source: 'zips', id: hoverZip }, { hover: true });
      showZipReadout(f.properties.z);
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'zip-fill', () => {
      if (hoverZip) map.setFeatureState({ source:'zips', id:hoverZip }, { hover:false });
      hoverZip = null; $('#zip-readout').hidden = true; map.getCanvas().style.cursor = '';
    });
    map.on('click', 'zip-fill', e => {
      if (view !== 'zips') return;
      const b = new maplibregl.LngLatBounds();
      const geom = e.features[0].geometry;
      const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
      rings.forEach(r => r.forEach(p => b.extend(p)));
      map.fitBounds(b, { padding: 70, duration: 900 });
    });

    overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    drawLayers();
    // A shared link carries its own destination; don't stomp on it with the city fit.
    if (hashBBL()) restoreFromHash(); else frameCity({ duration: 0 });

    map.on('click', e => {
      if (view !== 'buildings') return;
      // deck's own onClick handles direct hits; this catches clicks on bare map
      const picked = overlay.pickObject
        ? overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 8, layerIds: ['bldg'] })
        : null;
      if (picked && picked.index >= 0) return;         // deck onClick will fire
      const i = nearestTo(e.lngLat.lng, e.lngLat.lat, map.getZoom() > 15 ? 120 : 400);
      if (i >= 0) selectIndex(i); else clearSelection();
    });
  });
}

/* Fit the five boroughs into whatever is left of the window once the panel,
   the top bar and the mobile sheet have taken their share. */
function frameCity(opts = {}) {
  const narrow = innerWidth <= 760;
  const railOff = document.body.classList.contains('rail-off');
  const [lon0, lat0, lon1, lat1] = META.bbox;
  map.fitBounds([[lon0, lat0], [lon1, lat1]], Object.assign({
    padding: {
      left:   narrow ? 24 : (railOff ? 72 : 372 + 34),
      right:  24,
      top:    narrow ? 96 : 66,
      bottom: narrow ? 96 : 40,
    },
    duration: 700,
  }, opts));
}

function drawLayers() {
  if (!overlay) return;
  const visible = view === 'buildings';
  const attrs = {
    getPosition: { value: POS, size: 2 },
    getFillColor: { value: COLORS, size: 4 },
    getRadius: { value: RADII, size: 1 },
  };
  const filt = new deck.DataFilterExtension({ filterSize: 1 });
  const layers = [
    new deck.ScatterplotLayer({
      id: 'halo', visible: visible && coastalOn,
      data: { length: N, attributes: {
        getPosition: attrs.getPosition,
        getFilterValue: { value: SHOW_COASTAL, size: 1 } } },
      getFillColor: [...C.coastal, 62], getRadius: 22,
      radiusUnits: 'meters', radiusMinPixels: 1.8, radiusMaxPixels: 9,
      extensions: [filt], filterRange: [0.5, 1.5],
      pickable: false, parameters: { depthTest: false },
    }),
    new deck.ScatterplotLayer({
      id: 'bldg', visible,
      data: { length: N, attributes: Object.assign({}, attrs, {
        getFilterValue: { value: SHOW, size: 1 } }) },
      radiusUnits: 'meters', radiusMinPixels: 0.75, radiusMaxPixels: 6,
      extensions: [filt], filterRange: [0.5, 1.5],
      pickable: true, autoHighlight: false, parameters: { depthTest: false },
      onClick: info => { if (info.index >= 0) selectIndex(info.index); return true; },
      onHover: info => onHover(info),
    }),
  ];
  if (selected) {
    const pts = selected.group.filter(i => i < N).map(i => [POS[i * 2], POS[i * 2 + 1]]);
    if (pts.length) layers.push(new deck.ScatterplotLayer({
      id: 'sel', data: pts, getPosition: d => d,
      getRadius: 15, radiusUnits: 'meters', radiusMinPixels: 6, radiusMaxPixels: 26,
      stroked: true, filled: false, getLineColor: [255, 255, 255, 235], lineWidthMinPixels: 2.2,
      pickable: false, parameters: { depthTest: false },
    }));
  }
  overlay.setProps({ layers });
}

function onHover(info) {
  const tip = $('#tooltip');
  if (!info || info.index < 0 || view !== 'buildings') {
    if (hoverIdx !== -1) { hoverIdx = -1; tip.hidden = true; }
    return;
  }
  if (info.index !== hoverIdx) {
    hoverIdx = info.index;
    const f = FLAGS[hoverIdx], cat = categoryOf(f, scenario);
    const lu = META.landuse[ATTR[hoverIdx] >> 3] || 'Unknown';
    tip.innerHTML =
      `<span class="tt-risk" style="color:${HEX[cat]}">${CAT_NAME[cat]}</span><br>` +
      `<small>${lu}${(f & BIT.coastal) ? ' · FEMA coastal zone' : ''}</small><br>` +
      `<small style="opacity:.65">Click for the address</small>`;
    tip.hidden = false;
  }
  tip.style.left = Math.min(info.x + 14, innerWidth - 272) + 'px';
  tip.style.top  = Math.min(info.y + 14, innerHeight - 86) + 'px';
}

/* ── selection & detail ───────────────────────────────── */

async function detailFor(idx) {
  const sid = idx >> META.detailShift;
  if (!detailCache.has(sid)) {
    detailCache.set(sid, fetch(`data/details/d${sid}.json${V}`).then(r => r.json()));
  }
  const rows = await detailCache.get(sid);
  const row = rows[idx - (sid << META.detailShift)];
  if (!row) return null;
  const [addr, zip, bbl, flags, attr] = row;
  return { idx, addr, zip, bbl, flags, attr,
           boro: BORO_FROM_BBL[bbl[0]] || '',
           block: Math.floor(Number(bbl) / 1e4) % 1e5, lot: Number(bbl) % 1e4 };
}

async function indicesForBBL(bbl) {
  const sid = Number(bbl) % META.bblShards;
  if (!bblCache.has(sid)) {
    bblCache.set(sid, fetch(`data/bbl/b${sid}.json${V}`).then(r => r.json()));
  }
  const m = await bblCache.get(sid);
  const v = m[String(bbl)];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

async function selectIndex(idx, opts = {}) {
  const rec = await detailFor(idx);
  if (!rec) return;
  const group = await indicesForBBL(rec.bbl);
  selected = { idx, rec, group: group.length ? group : [idx], searched: opts.searched || null };
  renderCard();
  drawLayers();
  history.replaceState(null, '', '#b=' + rec.bbl);
  if (opts.fly !== false && idx < N) {
    map.flyTo({ center: [POS[idx * 2], POS[idx * 2 + 1]],
                zoom: Math.max(map.getZoom(), 16.4), duration: 1100 });
  }
}
function clearSelection() {
  selected = null; $('#card').hidden = true; drawLayers();
  history.replaceState(null, '', location.pathname + location.search);
}

function renderCard() {
  const { rec, group, searched } = selected;
  const card = $('#card');
  const f = rec.flags;
  const cat = categoryOf(f, scenario);
  const s = SCEN[scenario];
  const z = ZIPS[rec.zip];
  const bsmt = rec.attr & 7, lu = rec.attr >> 3;
  const belowGrade = bsmt === 2 || bsmt === 4;
  const atRisk = cat !== 'none';

  const verdictSub = {
    tide: `This land is projected to sit below the ordinary high tide in ${s.year}. That is chronic inundation, not a storm.`,
    deep: 'The city models a foot or more of standing water here, spread across at least a quarter-acre.',
    nuisance: 'The city models 4 inches to a foot of standing water here — enough to flood a below-grade unit or stall a car.',
    none: 'No modeled stormwater flooding at this location under this scenario. Other scenarios and coastal surge may still apply.',
  }[cat];

  const rows = SCEN_KEYS.map(k => {
    const c = categoryOf(f, k);
    return `<div class="scen-row ${k === scenario ? 'cur' : ''}">
      <span class="dot" style="background:${HEX[c]}"></span>
      <span class="nm">${SCEN[k].label}</span>
      <span class="vl" style="color:${c === 'none' ? 'var(--ink-3)' : HEX[c]}">${
        c === 'none' ? 'No flooding' : CAT_NAME[c].replace(' flooding','').replace('Future high tide','High tide ' + SCEN[k].year)}</span>
    </div>`;
  }).join('');

  const coastalTxt = (f & BIT.coastalV) ? 'FEMA VE — surge + waves'
                   : (f & BIT.coastal)  ? 'FEMA 1% annual chance' : 'Outside FEMA 1% zone';

  const ctx = z ? `<div class="ctx">
      In ZIP ${rec.zip}${z.detailed ? ' · ' + z.detailed : ''}, <b>${pct(z[s.agg])}</b> of
      ${fmt(z.n)} tax lots fall inside this scenario's flood area.
      <div class="bar"><i style="width:${Math.max(2, z[s.agg] * 100)}%;background:${
        z[s.agg] > 0.5 ? HEX.deep : z[s.agg] > 0.2 ? HEX.nuisance : HEX.tide}"></i></div>
    </div>` : '';

  card.innerHTML = `
    <div class="card-top">
      <div>
        <div class="card-addr">${rec.addr || 'Address not recorded'}</div>
        <p class="card-sub">${META.boros[rec.boro] || ''}${rec.zip && rec.zip !== '0' ? ' · ' + rec.zip : ''}
          ${z && z.parent ? ' · ' + z.parent : ''}</p>
      </div>
      <button class="card-x" id="card-close" aria-label="Close">×</button>
    </div>

    <div class="verdict" style="--vc:${HEX[cat]}">
      <div class="v-kicker">${s.label}</div>
      <div class="v-main">${CAT_NAME[cat]}</div>
      <p class="v-sub">${verdictSub}</p>
    </div>

    ${searched && !sameAddress(searched, rec.addr) ? `<p class="multi">You searched
      <b style="color:var(--ink)">${searched.split(',')[0]}</b> — this is the tax lot it sits on,
      filed under its address of record.</p>` : ''}

    ${group.length > 1 ? `<p class="multi">This tax lot carries <b>${group.length}</b> buildings;
      all of them share the lot's flood designation.</p>` : ''}

    <div class="scen-rows">${rows}</div>

    <dl class="facts">
      <div class="fact ${belowGrade && atRisk ? 'alert' : ''}">
        <dt>Basement</dt><dd>${META.bsmt[bsmt]}</dd></div>
      <div class="fact"><dt>Coastal</dt><dd>${coastalTxt}</dd></div>
      <div class="fact"><dt>Building type</dt><dd>${META.landuse[lu] || 'Unknown'}</dd></div>
      <div class="fact"><dt>Block / lot</dt><dd class="mono">${rec.block} / ${rec.lot}</dd></div>
      <div class="fact wide"><dt>BBL</dt><dd class="mono">${rec.bbl}</dd></div>
    </dl>

    ${belowGrade && atRisk ? `<p class="card-note" style="color:var(--nuisance)">
      This building has a <b>below-grade basement</b> inside a flood footprint. Eleven of the
      thirteen people who died in New York during Hurricane Ida drowned in basement apartments.</p>` : ''}

    ${ctx}

    <p class="card-note">A lot is flagged when any part of it intersects the modeled flood
      area, so a large lot can be flagged when its building is not. Not a flood-insurance
      determination — see <a href="https://msc.fema.gov/portal/home" target="_blank" rel="noopener">FEMA's Map Service Center</a>.</p>
  `;
  card.hidden = false;
  $('#card-close').onclick = clearSelection;
  // bring the card into view: the rail may be scrolled down, or collapsed on a phone
  const rail = $('#rail');
  if (rail.classList.contains('hidden')) {
    rail.classList.remove('hidden');
    document.body.classList.remove('rail-off');
    $('#rail-open').hidden = true;
  }
  rail.scrollTo({ top: 0, behavior: 'smooth' });
}

function sameAddress(a, b) {
  const norm = t => String(t || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|PLACE|PL|DRIVE|DR)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  return norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
}

/* ── UI ───────────────────────────────────────────────── */

function buildUI() {
  // scenario
  const seg = $('#scenario');
  seg.innerHTML = SCEN_KEYS.map(k => `
    <button role="radio" data-s="${k}" aria-checked="${k === scenario}" class="${k === scenario ? 'on' : ''}">
      <b>${SCEN[k].label}</b><em>${SCEN[k].sub}</em>
    </button>`).join('');
  seg.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    scenario = b.dataset.s;
    [...seg.children].forEach(c => {
      c.classList.toggle('on', c === b); c.setAttribute('aria-checked', c === b);
    });
    $('#scenario-note').textContent = SCEN[scenario].note;
    recolor(); paintZips(); renderLegend(); renderRank();
    if (selected) renderCard();
    if (hoverZip) showZipReadout(hoverZip);
  };
  $('#scenario-note').textContent = SCEN[scenario].note;

  renderLegend();

  // filters
  $('#use-chips').innerHTML = USE_GROUPS
    .map(g => `<button data-g="${g.id}">${g.label}</button>`).join('');
  $('#use-chips').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const g = USE_GROUPS.find(x => x.id === b.dataset.g);
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    g.lus.forEach(l => on ? useSel.add(l) : useSel.delete(l));
    syncFilterUI(); recolor();
  };
  $('#bsmt-tog').onchange = e => { bsmtOnly = e.target.checked; syncFilterUI(); recolor(); };
  $('#coastal-tog').onchange = e => { coastalOn = e.target.checked; recolor(); };
  $('#reset-filters').onclick = () => {
    useSel.clear(); bsmtOnly = false;
    $('#bsmt-tog').checked = false;
    [...$('#use-chips').children].forEach(c => c.classList.remove('on'));
    syncFilterUI(); recolor();
  };

  // view mode
  $('#viewmode').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    view = b.dataset.v;
    [...e.currentTarget.children].forEach(c => {
      c.classList.toggle('on', c === b); c.setAttribute('aria-checked', c === b);
    });
    const vis = view === 'zips' ? 'visible' : 'none';
    ['zip-fill','zip-line'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis); });
    $('#tooltip').hidden = true;
    if (view === 'buildings') $('#zip-readout').hidden = true;
    document.body.classList.toggle('zips-view', view === 'zips');
    renderLegend();
    drawLayers();
  };

  // rail toggle
  const setRail = hide => {
    $('#rail').classList.toggle('hidden', hide);
    document.body.classList.toggle('rail-off', hide);
    if (innerWidth > 760) $('#rail-open').hidden = !hide;
    setTimeout(() => map && map.resize(), 340);
  };
  $('#rail-toggle').onclick = () => setRail(!$('#rail').classList.contains('hidden'));
  $('#rail-open').onclick = () => setRail(false);

  // methodology
  const openM = () => { $('#method').hidden = false; };
  $('#open-method').onclick = openM;
  $('#open-method-2').onclick = openM;
  $('#close-method').onclick = () => { $('#method').hidden = true; };
  $('#method').onclick = e => { if (e.target.id === 'method') $('#method').hidden = true; };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#method').hidden) $('#method').hidden = true;
      else if (!$('#q-list').hidden) $('#q-list').hidden = true;
      else if (selected) clearSelection();
    }
  });
  $('#m-bsmt').textContent = fmt(META.counts.bsmtExt);

  // On a phone the panel is a sheet; start it peeking so the map leads.
  if (innerWidth <= 760) {
    $('#rail').classList.add('hidden');
    document.body.classList.add('rail-off');
  }

  buildSearch();
  renderRank();
  syncFilterUI();
}

function renderLegend() {
  const el = $('#legend');
  if (view === 'zips') {
    const st = STOPS[scenario];
    el.innerHTML = `<li class="ramp-li">
        <span class="ramp" style="background:linear-gradient(90deg,${RAMP.join(',')})"></span>
        <span class="ramp-ends"><b>0%</b><b>${Math.round(st[st.length - 1] * 100)}%+</b></span>
        <em>Share of a ZIP's tax lots inside the flood area</em>
      </li>`;
  } else {
    el.innerHTML = [
      ['tide','Future high tide','Below the projected daily high tide'],
      ['deep','Deep &amp; contiguous flooding','1 foot or more of standing water'],
      ['nuisance','Nuisance flooding','4 inches to 1 foot'],
      ['none','No modeled flooding',''],
    ].map(([k, t, sub]) => `<li><span class="sw-dot" style="background:${HEX[k]}"></span>
        <span>${t}${sub ? `<em>${sub}</em>` : ''}</span>
        <span class="ct" data-ct="${k}"></span></li>`).join('');
    updateLegendCounts();
  }
}

function syncFilterUI() {
  $('#reset-filters').hidden = !(useSel.size || bsmtOnly);
}

// Citywide counts per category, ignoring the filters — the legend is a key to the
// whole city, not to whatever slice is on screen.
function updateLegendCounts() {
  const [bn, bd, bt] = SCEN[scenario].bits;
  const tally = { tide: 0, deep: 0, nuisance: 0, none: 0 };
  for (let i = 0; i < N; i++) {
    const f = FLAGS[i];
    if (bt && (f & bt)) tally.tide++;
    else if (f & bd) tally.deep++;
    else if (f & bn) tally.nuisance++;
    else tally.none++;
  }
  document.querySelectorAll('[data-ct]').forEach(el => {
    const v = tally[el.dataset.ct];
    el.textContent = v ? fmt(v) : '—';
  });
}

function updateCounts(shown, risky) {
  const s = SCEN[scenario];
  if (view !== 'zips') updateLegendCounts();

  const total = META.counts[s.agg];
  $('#headline').innerHTML =
    `Under a <b>${s.label.toLowerCase()}</b>, <b>${fmt(total)}</b> of ${fmt(META.total)} buildings —
     <b>${pct(total / META.total)}</b> — stand in a modeled flood area.`;

  const filtered = useSel.size || bsmtOnly;
  $('#filter-count').innerHTML = filtered
    ? `Showing <b style="color:var(--ink)">${fmt(shown)}</b> buildings ·
       <b style="color:var(--ink)">${fmt(risky)}</b> (${pct(risky / (shown || 1))}) in a flood area`
    : 'All buildings shown. Filters narrow the dots on the map.';
}

function paintZips() {
  if (!map || !map.getSource('zips')) return;
  const src = map.getSource('zips');
  const gj = src._data;
  gj.features.forEach(ft => {
    const z = ZIPS[ft.properties.z];
    ft.properties.v = z ? z[SCEN[scenario].agg] : 0;
  });
  src.setData(gj);
  map.setPaintProperty('zip-fill', 'fill-color', zipColorExpr());
}

function showZipReadout(zip) {
  const z = ZIPS[zip]; if (!z) return;
  const s = SCEN[scenario];
  const el = $('#zip-readout');
  el.innerHTML = `<h4>${z.detailed || 'ZIP ' + zip}</h4>
    <p>ZIP ${zip} · ${META.boros[z.boro] || ''} · ${fmt(z.n)} tax lots</p>
    <div class="big" style="color:${z[s.agg] > 0.5 ? HEX.deep : z[s.agg] > 0.2 ? HEX.nuisance : HEX.tide}">${pct1(z[s.agg])}</div>
    <p>in the ${s.label.toLowerCase()} flood area</p>`;
  el.hidden = false;
}

function renderRank() {
  const s = SCEN[scenario];
  const rows = Object.entries(HOODS.parent)
    .filter(([, v]) => v.n >= 400)
    .sort((a, b) => b[1][s.agg] - a[1][s.agg])
    .slice(0, 12);
  const max = rows.length ? rows[0][1][s.agg] : 1;
  $('#rank').innerHTML = rows.map(([name, v]) => `
    <li data-nm="${name.replace(/"/g, '&quot;')}">
      <span class="nm" title="${name}">${name}</span>
      <span class="mini"><i style="width:${Math.max(4, v[s.agg] / max * 100)}%;background:${
        v[s.agg] > 0.5 ? HEX.deep : v[s.agg] > 0.25 ? HEX.nuisance : HEX.tide}"></i></span>
      <span class="pc">${pct(v[s.agg])}</span>
    </li>`).join('');
  $('#rank').onclick = e => {
    const li = e.target.closest('li'); if (!li) return;
    const rec = HOODS.parent[li.dataset.nm];
    const pts = (rec.zips || []).map(z => ZIPS[z] && ZIPS[z].c).filter(Boolean);
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds();
    pts.forEach(p => b.extend(p));
    map.fitBounds(b, { padding: 150, maxZoom: 14.5, duration: 1000 });
  };
}

/* ── address search (NYC Planning Labs GeoSearch) ─────── */

function buildSearch() {
  const input = $('#q'), list = $('#q-list'), hint = $('#q-hint'), clear = $('#q-clear');
  let timer = null, results = [], active = -1;

  const close = () => { list.hidden = true; active = -1; };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clear.hidden = !q;
    clearTimeout(timer);
    if (q.length < 3) { close(); hint.textContent = ''; return; }
    timer = setTimeout(() => lookup(q), 220);
  });
  input.addEventListener('keydown', e => {
    if (list.hidden) { if (e.key === 'Enter' && results.length) choose(results[0]); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      [...list.children].forEach((c, i) => c.classList.toggle('act', i === active));
    } else if (e.key === 'Enter') {
      e.preventDefault(); choose(results[active >= 0 ? active : 0]);
    }
  });
  clear.onclick = () => { input.value = ''; clear.hidden = true; close(); hint.textContent = ''; input.focus(); };
  document.addEventListener('click', e => { if (!e.target.closest('#sec-search')) close(); });

  async function lookup(q) {
    hint.className = 'hint'; hint.textContent = 'Searching…';
    try {
      const r = await fetch('https://geosearch.planninglabs.nyc/v2/autocomplete?size=6&text=' +
                            encodeURIComponent(q));
      if (!r.ok) throw new Error('geocoder ' + r.status);
      const j = await r.json();
      results = (j.features || []).filter(f => f.geometry && f.geometry.coordinates);
      if (!results.length) { close(); hint.textContent = 'No matching NYC address.'; return; }
      hint.textContent = '';
      list.innerHTML = results.map(f => {
        const p = f.properties;
        return `<li>${p.name || p.label}<small>${[p.borough, p.postalcode].filter(Boolean).join(' · ')}</small></li>`;
      }).join('');
      [...list.children].forEach((li, i) => li.onclick = () => choose(results[i]));
      list.hidden = false; active = -1;
    } catch (err) {
      close();
      hint.className = 'hint warn';
      hint.textContent = 'Address lookup is unavailable — click a building on the map instead.';
    }
  }

  async function choose(f) {
    if (!f) return;
    close();
    const p = f.properties;
    input.value = p.label || p.name || '';
    clear.hidden = false;
    const [lon, lat] = f.geometry.coordinates;
    const bbl = p.addendum && p.addendum.pad && p.addendum.pad.bbl;

    if (bbl) {
      const idxs = await indicesForBBL(String(bbl));
      if (idxs.length) {
        const mapped = idxs.filter(i => i < N);
        if (mapped.length) {
          // land on the building closest to the geocoder's own point
          let best = mapped[0], bd = Infinity;
          for (const i of mapped) {
            const d = (POS[i*2] - lon) ** 2 + (POS[i*2+1] - lat) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
          hint.className = 'hint'; hint.textContent = '';
          selectIndex(best, { searched: p.label || p.name });
          return;
        }
        // in PLUTO but with no building coordinate on record
        hint.className = 'hint';
        hint.innerHTML = 'No mapped building footprint for this lot — showing its record.';
        map.flyTo({ center: [lon, lat], zoom: 16.4, duration: 900 });
        selectIndex(idxs[0], { fly: false, searched: p.label || p.name });
        return;
      }
    }

    map.flyTo({ center: [lon, lat], zoom: 16.8, duration: 1000 });
    const i = nearestTo(lon, lat, 160);
    if (i >= 0) {
      const rec = await detailFor(i);
      hint.className = 'hint';
      hint.innerHTML = `Not in the tax-lot file — showing the nearest mapped building,
                        <b style="color:var(--ink)">${rec ? rec.addr : ''}</b>.`;
      selectIndex(i, { fly: false });
    } else {
      hint.className = 'hint warn';
      hint.textContent = 'No building on record near that address.';
    }
  }
}

/* ── deep link ────────────────────────────────────────── */

const hashBBL = () => (/[#&]b=(\d{10})/.exec(location.hash) || [])[1] || null;

async function restoreFromHash() {
  const bbl = hashBBL();
  if (!bbl) return;
  const idxs = await indicesForBBL(bbl);
  if (idxs.length) selectIndex(idxs.find(i => i < N) ?? idxs[0]);
}
