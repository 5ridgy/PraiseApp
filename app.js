'use strict';
const VERSION = '2.5';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// Les trois recueils sont fixes. Chacun a sa propre règle pour repérer les numéros
// (utilisée seulement pendant le réglage) ; ensuite tout vient de data/tables.json.
const BOOKS = [
  { id: 'lq', name: 'Reflets 4', color: '#e8730c', file: 'LQ-Reflets', rule: 'topLeft' },
  { id: 'hec', name: 'H&C', color: '#1a1a1a', file: 'HeC_A4', rule: 'hecHeader' },
  { id: 'hc', name: 'New H&C', color: '#12a3a8', file: 'h_c_pdf-interactif', rule: 'topLeftBig' },
];
const IDS = BOOKS.map(b => b.id);
const bookDef = id => BOOKS.find(b => b.id === id);

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ---------- Stockage local (IndexedDB) ---------- */
// "meta" : nom du fichier, nombre de pages, table de réglage ; "files" : le PDF brut ;
// "marks" : niveau de connaissance d'un chant ("recueil:n") ; "ink" : annotations d'une page ("recueil:page").
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('partitions', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      for (const name of ['files', 'marks', 'ink']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (name, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode);
      const req = fn(t.objectStore(name));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    allMeta: () => tx('meta', 'readonly', s => s.getAll()),
    putMeta: m => tx('meta', 'readwrite', s => s.put(m)),
    delMeta: id => tx('meta', 'readwrite', s => s.delete(id)),
    getFile: id => tx('files', 'readonly', s => s.get(id)),
    putFile: (id, buf) => tx('files', 'readwrite', s => s.put(buf, id)),
    delFile: id => tx('files', 'readwrite', s => s.delete(id)),
    allMarks: () => new Promise(async res => {
      const out = {};
      await tx('marks', 'readonly', s => { const c = s.openCursor(); c.onsuccess = () => { const k = c.result; if (k) { out[k.key] = k.value; k.continue(); } }; return c; });
      res(out);
    }),
    setMark: (key, v) => tx('marks', 'readwrite', s => v ? s.put(v, key) : s.delete(key)),
    getInk: key => tx('ink', 'readonly', s => s.get(key)),
    putInk: (key, strokes) => tx('ink', 'readwrite', s => strokes.length ? s.put(strokes, key) : s.delete(key)),
  };
})();

let marks = {};      // "recueil:n" -> 'ok' | 'hard' | 'fail'
const MARKS = { ok: 'Bien connu', hard: 'Difficultés', fail: 'Pas encore' };
let local = {};       // id -> {id, fileName, pages, map:{n:[page,y]}}
let fixed = {};       // id -> table figée de data/tables.json
const docs = {};

function getDoc(id) {
  if (!docs[id]) docs[id] = db.getFile(id).then(buf => {
    if (!buf) throw new Error('PDF absent');
    return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  });
  return docs[id];
}

// La version 1 rangeait les recueils sous 1, 2, 3 : on les reclasse d'après le nom du fichier.
async function migrateV1(metas) {
  for (const m of metas) {
    if (IDS.includes(m.id)) continue;
    const def = BOOKS.find(b => (m.fileName || '').toLowerCase().startsWith(b.file.toLowerCase()));
    const buf = await db.getFile(m.id);
    if (def && buf && !metas.some(x => x.id === def.id)) {
      await db.putFile(def.id, buf);
      await db.putMeta({ id: def.id, fileName: m.fileName, pages: m.pages, map: {} });
    }
    await db.delMeta(m.id); await db.delFile(m.id);
  }
}

async function loadAll() {
  try {
    const r = await fetch('data/tables.json', { cache: 'no-cache' });
    fixed = (await r.json()).books || {};
  } catch { fixed = {}; }
  const metas = await db.allMeta();
  if (metas.some(m => !IDS.includes(m.id))) await migrateV1(metas);
  local = {};
  for (const m of await db.allMeta()) local[m.id] = m;
  try { marks = await db.allMarks(); } catch { marks = {}; }
}

/* ---------- Table effective : figée si disponible, sinon celle du réglage ---------- */
function isFrozen(id) {
  const f = fixed[id];
  return !!(f && f.pages && Object.values(f.songs || {}).some(s => s.p));
}
function table(id) {
  const f = fixed[id] || { songs: {} };
  const out = {};
  for (const [n, s] of Object.entries(f.songs || {})) out[n] = { t: s.t || '', p: s.p || 0, y: s.y || 0 };
  if (!isFrozen(id) && local[id]) {
    for (const [n, v] of Object.entries(local[id].map || {})) out[n] = { t: (out[n] && out[n].t) || '', p: v[0], y: v[1] || 0 };
  }
  return out;
}
function lastNum(id) {
  const t = table(id);
  return (fixed[id] && fixed[id].last) || Math.max(0, ...Object.keys(t).map(Number));
}
function located(id) {
  const t = table(id);
  return Object.keys(t).map(Number).filter(n => t[n].p).sort((a, b) => a - b);
}
function missing(id) {
  const t = table(id), out = [];
  for (let n = 1; n <= lastNum(id); n++) if (!(t[n] && t[n].p)) out.push(n);
  return out;
}
function rangeFor(id, n) {
  const t = table(id), ks = located(id), pages = (local[id] && local[id].pages) || 9999;
  const nextK = ks.find(k => k > n);
  const next = nextK !== undefined ? t[nextK] : null;
  if (t[n] && t[n].p) {
    const start = t[n].p;
    let end;
    if (!next) end = Math.min(start + 3, pages);
    else if (next.p <= start) end = start;
    else end = next.y > 0.3 ? next.p : next.p - 1; // la suivante commence en bas de page
    return { start, end: Math.max(start, end), exact: true, y: t[n].y };
  }
  const prevK = ks.filter(k => k < n).pop();
  const start = prevK !== undefined ? t[prevK].p : 1;
  const end = next ? next.p : Math.min(start + 4, pages);
  return { start, end: Math.min(end, start + 12, pages), exact: false, y: 0 };
}

/* ---------- Réglage : règles propres à chaque recueil ---------- */
const NUM = /^(\d{1,3})\b/;
// Tolère les coquilles du recueil (« Hymne et Cantique », « Hymes », « Hympnes »…).
const HEC = /Hy\w*\s+et\s+can\w*\s*[»"”]?\s*n\s*[°ºo]\s*(\d{1,3})\b/i;
// Dans Reflets, les chants 271 à 292 utilisent une police au codage décalé : « OTN » = 271.
const digits = s => /^\d{1,3}$/.test(s) ? s : /^[M-V]{1,3}$/.test(s) ? [...s].map(c => c.charCodeAt(0) - 77).join('') : null;

function readItems(tc, page) {
  const [x0, y0, x1, y1] = page.view;
  const w = (x1 - x0) || 1, h = (y1 - y0) || 1;
  const items = [];
  for (const it of tc.items) {
    const s = (it.str || '').trim();
    if (!s) continue;
    const t = it.transform;
    items.push({ s, size: Math.hypot(t[2], t[3]) || it.height || 0,
      x: (t[4] - x0) / w, y: Math.min(1, Math.max(0, 1 - (t[5] - y0) / h)) });
  }
  return items;
}

// Renvoie les numéros qui commencent sur cette page : [[n, y], …]
const RULES = {
  // H&C interactif : le numéro est toujours en haut à gauche, en gros.
  topLeftBig(items) {
    const sizes = items.map(i => i.size).sort((a, b) => a - b);
    const med = sizes[sizes.length >> 1] || 1;
    const c = items.filter(i => i.y < 0.25 && i.x < 0.35 && /^\d{1,3}$/.test(i.s) && i.size >= med * 1.3)
      .sort((a, b) => b.size - a.size)[0];
    return c ? [[+c.s, c.y]] : [];
  },
  // HeC A4 : en petit, juste après « Hymnes et cantiques » n° (guillemets parfois absents).
  hecHeader(items) {
    const text = items.map(i => i.s).join(' ');
    const m = text.match(HEC);
    return m ? [[+m[1], 0]] : [];
  },
  // Reflets : le numéro est en haut, dans la marge extérieure (à gauche ou à droite selon la page),
  // parfois découpé chiffre par chiffre.
  topLeft(items) {
    const groups = {};
    for (const i of items) {
      if (i.y >= 0.2 || (i.x >= 0.13 && i.x <= 0.85) || i.size < 15 || digits(i.s) === null) continue;
      (groups[`${i.y.toFixed(2)}|${i.x < 0.5}`] ||= []).push(i);
    }
    for (const k of Object.keys(groups).sort()) {
      const n = groups[k].sort((a, b) => a.x - b.x).map(i => digits(i.s)).join('');
      if (n.length <= 3) return [[+n, groups[k][0].y]];
    }
    return [];
  },
};

// Garde la plus longue suite de numéros dont les pages vont croissant.
function monotonic(map) {
  const ks = Object.keys(map).map(Number).sort((a, b) => a - b);
  const prevIdx = [], tails = [];
  ks.forEach((k, i) => {
    const p = map[k][0];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (map[ks[tails[mid]]][0] <= p) lo = mid + 1; else hi = mid; }
    prevIdx[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const out = {};
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prevIdx[i]) out[ks[i]] = map[ks[i]];
  return out;
}

async function tune(id, onProgress) {
  const doc = await getDoc(id);
  const rule = RULES[bookDef(id).rule];
  const last = (fixed[id] && fixed[id].last) || 999;
  const map = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = readItems(await page.getTextContent(), page);
    for (const [n, y] of rule(items)) if (n >= 1 && n <= last && !map[n]) map[n] = [p, +y.toFixed(3)];
    page.cleanup();
    if (onProgress && (p % 5 === 0 || p === doc.numPages)) onProgress(p / doc.numPages);
  }
  const m = local[id];
  m.map = monotonic(map);
  m.pages = doc.numPages;
  m.tunedWith = VERSION;
  await db.putMeta(m);
}

/* ---------- Accueil ---------- */
let current = IDS.includes(store.get('book')) ? store.get('book') : IDS[0];
let typed = '';

function renderBooks() {
  const box = $('#books');
  box.innerHTML = '';
  for (const def of BOOKS) {
    const id = def.id, has = !!local[id];
    const meta = !has ? 'PDF à importer : touchez ici'
      : isFrozen(id) ? `n° 1 à ${lastNum(id)}`
      : `Réglage en cours · ${located(id).length}/${lastNum(id)} repérés`;
    box.append(el('button', {
      class: 'book' + (current === id ? ' selected' : '') + (has ? '' : ' empty'),
      style: `--book: ${def.color}`,
      onclick: () => {
        if (!has) return showScreen('settings');
        current = id; store.set('book', id); renderBooks(); updateHint(); renderSearch();
      }
    }, el('span', { class: 'name' }, def.name), el('span', { class: 'meta' }, meta)));
  }
}

function updateHint() {
  $('#num').textContent = typed || ' ';
  const id = current, n = +typed, t = table(id);
  let hint = ' ';
  if (!local[id]) hint = 'Importez d’abord ce recueil';
  else if (typed && n > lastNum(id)) hint = `Ce recueil va jusqu’au n° ${lastNum(id)}`;
  else if (typed && t[n]) hint = t[n].t || `page ${t[n].p}`;
  else if (typed) hint = 'emplacement approximatif';
  const mk = typed && marks[`${id}:${n}`];
  $('#hint').textContent = hint;
  if (mk) $('#hint').prepend(el('span', { class: `dot ${mk}` }));
  $('#btn-open').disabled = !local[id] || !n || n > lastNum(id);
}

function press(k) {
  if (k === 'C') typed = '';
  else if (k === 'B') typed = typed.slice(0, -1);
  else if (typed.length < 3) typed = (typed + k).replace(/^0+/, '');
  updateHint();
}

// Recherche par titre (sans tenir compte des accents ni de la ponctuation).
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function renderSearch() {
  const q = fold($('#search').value || '');
  const box = $('#results');
  box.innerHTML = '';
  if (q.length < 2 || !local[current]) return;
  const t = table(current);
  const hits = Object.keys(t).map(Number).filter(n => t[n].t && fold(t[n].t).includes(q)).sort((a, b) => a - b).slice(0, 8);
  if (!hits.length) box.append(el('div', { class: 'r-empty' }, 'Aucun titre trouvé'));
  for (const n of hits) box.append(el('button', { class: 'r-item', onclick: () => openScore(current, n) },
    el('b', {}, String(n)), ' ', t[n].t, marks[`${current}:${n}`] ? el('span', { class: `dot ${marks[`${current}:${n}`]}` }) : ''));
}

/* ---------- Visionneuse ---------- */
let view = { id: '', n: 0, fixing: false, token: 0 };
let fit = store.get('fit', 'width');

async function openScore(id, n) {
  if (!local[id] || n < 1 || n > lastNum(id)) return;
  view = { id, n, fixing: false, token: view.token + 1 };
  const token = view.token;
  showScreen('viewer');
  const t = table(id)[n];
  $('#v-title').textContent = `n° ${n}${t && t.t ? ' · ' + t.t : ''}`;
  $('#btn-fit').textContent = fit === 'width' ? 'Page entière' : 'Pleine largeur';
  $('#btn-fix').textContent = 'Corriger';
  $('#btn-fix').classList.toggle('hidden', isFrozen(id));
  renderMarks();
  ink.undo = [];
  const r = rangeFor(id, n);
  const warn = $('#v-warn');
  warn.classList.toggle('hidden', r.exact);
  if (!r.exact) warn.textContent = `Le n° ${n} n’est pas encore repéré. Voici les pages où il devrait être : touchez « Corriger » puis la page où il commence.`;
  const box = $('#pages');
  box.innerHTML = '';
  box.scrollTop = 0;
  const doc = await getDoc(id);
  if (token !== view.token) return;
  const W = box.clientWidth - 24, H = box.clientHeight - 24;
  for (let p = r.start; p <= r.end; p++) {
    const page = await doc.getPage(p);
    if (token !== view.token) return;
    const vp1 = page.getViewport({ scale: 1 });
    const cssScale = fit === 'width' ? Math.min(W, 1600) / vp1.width : Math.min(W / vp1.width, H / vp1.height);
    const cssW = vp1.width * cssScale, cssH = vp1.height * cssScale;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = cssScale * dpr;
    const maxPx = 16e6;
    if (vp1.width * vp1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (vp1.width * vp1.height));
    const vp = page.getViewport({ scale });
    const canvas = el('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const layer = el('canvas', { class: 'ink' });
    layer.width = Math.round(cssW * dpr); layer.height = Math.round(cssH * dpr);
    const div = el('div', { class: 'page', 'data-page': p }, canvas, layer, el('span', { class: 'tag' }, `p. ${p}`));
    div.style.width = cssW + 'px'; div.style.height = cssH + 'px';
    setupInk(layer, `${id}:${p}`);
    div.addEventListener('click', () => fixHere(p));
    box.append(div);
    // Si la partition commence plus bas sur la page, on descend jusqu'à elle.
    if (p === r.start && r.y > 0.3) box.scrollTop = div.offsetTop - box.offsetTop + (r.y - 0.06) * cssH;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}

/* ---------- Niveau de connaissance du chant ---------- */
function renderMarks() {
  const v = marks[`${view.id}:${view.n}`];
  document.querySelectorAll('#v-marks button').forEach(b => b.classList.toggle('on', b.dataset.m === v));
}
async function setMark(m) {
  const key = `${view.id}:${view.n}`;
  const v = marks[key] === m ? null : m; // toucher la pastille active l'enlève
  if (v) marks[key] = v; else delete marks[key];
  renderMarks();
  try { await db.setMark(key, v); } catch {}
}

/* ---------- Annotations au stylet ---------- */
// Les traits sont stockés en coordonnées relatives à la page (0..1), donc ils suivent le zoom.
const INK_TOOLS = {
  black: { c: '#111111', w: 0.0025, a: 1 },
  red: { c: '#d62828', w: 0.0025, a: 1 },
  blue: { c: '#1d4ed8', w: 0.0025, a: 1 },
  marker: { c: '#ffd60a', w: 0.018, a: 0.35 },
};
const ink = { on: false, tool: 'black', undo: [] };

function drawStroke(ctx, W, H, s) {
  if (!s.pts.length) return;
  ctx.save();
  ctx.globalAlpha = s.a; ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(1, s.w * W);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.pts[0][0] * W, s.pts[0][1] * H);
  for (const [x, y] of s.pts) ctx.lineTo(x * W, y * H);
  if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * W + 0.1, s.pts[0][1] * H);
  ctx.stroke();
  ctx.restore();
}
function redraw(layer) {
  const ctx = layer.getContext('2d');
  ctx.clearRect(0, 0, layer.width, layer.height);
  for (const s of layer._strokes) drawStroke(ctx, layer.width, layer.height, s);
}
async function saveInk(layer) {
  try { await db.putInk(layer._key, layer._strokes); } catch {}
}

async function setupInk(layer, key) {
  layer._key = key;
  layer._strokes = [];
  try { layer._strokes = (await db.getInk(key)) || []; } catch {}
  redraw(layer);
  let cur = null;
  const pos = e => { const r = layer.getBoundingClientRect(); return [+((e.clientX - r.left) / r.width).toFixed(4), +((e.clientY - r.top) / r.height).toFixed(4)]; };
  const canDraw = e => ink.on && (e.pointerType === 'pen' || e.pointerType === 'mouse');
  const erase = e => {
    const [x, y] = pos(e), r = 0.015;
    const before = layer._strokes.length;
    const removed = layer._strokes.filter(s => s.pts.some(([a, b]) => Math.hypot(a - x, b - y) < r));
    if (!removed.length) return;
    layer._strokes = layer._strokes.filter(s => !removed.includes(s));
    ink.undo.push({ layer, removed });
    if (layer._strokes.length !== before) redraw(layer);
  };
  layer.addEventListener('pointerdown', e => {
    if (!canDraw(e)) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    if (ink.tool === 'eraser') { cur = 'erase'; erase(e); return; }
    const t = INK_TOOLS[ink.tool];
    cur = { c: t.c, w: t.w, a: t.a, pts: [pos(e)] };
    layer._strokes.push(cur);
    redraw(layer);
  });
  layer.addEventListener('pointermove', e => {
    if (!cur || !canDraw(e)) return;
    e.preventDefault();
    if (cur === 'erase') return erase(e);
    for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) cur.pts.push(pos(ev));
    redraw(layer);
  });
  const end = () => {
    if (!cur) return;
    if (cur !== 'erase') ink.undo.push({ layer, added: cur });
    cur = null;
    saveInk(layer);
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  // Sur iPad, empêche le défilement quand c'est l'Apple Pencil qui touche l'écran (le doigt fait toujours défiler).
  const block = e => { if (ink.on && [...e.touches].some(t => t.touchType === 'stylus')) e.preventDefault(); };
  layer.addEventListener('touchstart', block, { passive: false });
  layer.addEventListener('touchmove', block, { passive: false });
}

function toggleInk() {
  ink.on = !ink.on;
  $('#btn-ink').classList.toggle('on', ink.on);
  $('#v-tools').classList.toggle('hidden', !ink.on);
  document.querySelectorAll('.page').forEach(d => d.classList.toggle('inking', ink.on));
}
function pickTool(t) {
  ink.tool = t;
  document.querySelectorAll('#v-tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
}
function undoInk() {
  const u = ink.undo.pop();
  if (!u) return;
  if (u.added) u.layer._strokes = u.layer._strokes.filter(s => s !== u.added);
  if (u.removed) u.layer._strokes.push(...u.removed);
  redraw(u.layer); saveInk(u.layer);
}
async function clearInk() {
  const layers = [...document.querySelectorAll('canvas.ink')].filter(l => l._strokes && l._strokes.length);
  if (!layers.length || !confirm('Effacer toutes les annotations de ce chant ?')) return;
  for (const l of layers) { ink.undo.push({ layer: l, removed: l._strokes }); l._strokes = []; redraw(l); saveInk(l); }
}

function toggleFix() {
  view.fixing = !view.fixing;
  $('#btn-fix').textContent = view.fixing ? 'Annuler' : 'Corriger';
  document.querySelectorAll('.page').forEach(d => d.classList.toggle('fixable', view.fixing));
  const warn = $('#v-warn');
  if (view.fixing) { warn.classList.remove('hidden'); warn.textContent = `Touchez la page où commence le n° ${view.n}.`; }
  else warn.classList.add('hidden');
}

async function fixHere(p) {
  if (!view.fixing) return;
  const m = local[view.id];
  m.map[view.n] = [p, 0];
  await db.putMeta(m);
  openScore(view.id, view.n);
}

/* ---------- Recueils et réglage ---------- */
function busy(text, frac) {
  const o = $('#busy');
  if (text === false) return o.classList.add('hidden');
  o.classList.remove('hidden');
  $('#busy-text').textContent = text;
  $('#busy-bar').style.width = Math.round((frac || 0) * 100) + '%';
}

async function importPdf(id, file) {
  try {
    busy('Enregistrement du PDF…', 0);
    await db.putFile(id, await file.arrayBuffer());
    delete docs[id];
    const doc = await getDoc(id);
    local[id] = { id, fileName: file.name, pages: doc.numPages, map: (local[id] && local[id].map) || {} };
    await db.putMeta(local[id]);
    const f = fixed[id];
    if (isFrozen(id) && f.pages !== doc.numPages)
      alert(`Attention : ce PDF a ${doc.numPages} pages, la table attend ${f.pages} pages. Ce n’est peut-être pas la bonne version du recueil.`);
    if (!isFrozen(id) && !Object.keys(local[id].map).length) await tune(id, f2 => busy('Repérage des numéros…', f2));
  } catch (e) {
    alert('Import impossible : ' + e.message);
  } finally {
    busy(false); renderSettings(); renderBooks(); updateHint();
  }
}

// Plusieurs PDF choisis d'un coup : on les range d'après leur nom.
async function importMany(files) {
  for (const f of files) {
    const def = BOOKS.find(b => f.name.toLowerCase().startsWith(b.file.toLowerCase()));
    if (def) await importPdf(def.id, f);
    else alert(`« ${f.name} » ne correspond à aucun des trois recueils.`);
  }
}

async function retune(id) {
  if (Object.keys(local[id].map).length && !confirm('Refaire le repérage ? Les corrections faites à la main seront perdues.')) return;
  try { busy('Repérage des numéros…', 0); await tune(id, f => busy('Repérage des numéros…', f)); }
  catch (e) { alert('Erreur : ' + e.message); }
  finally { busy(false); renderSettings(); renderBooks(); }
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

function exportTable(id) {
  const m = local[id];
  const songs = {};
  for (const n of Object.keys(m.map).map(Number).sort((a, b) => a - b)) songs[n] = m.map[n];
  download(`table-${id}.json`, JSON.stringify({ book: id, file: m.fileName, pages: m.pages, app: VERSION, songs }));
}

function renderSettings() {
  const body = $('#settings-body');
  body.innerHTML = '';
  const many = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: '', class: 'hidden' });
  many.addEventListener('change', () => importMany([...many.files]));
  body.append(el('div', { class: 's-card' },
    el('div', { class: 'status' }, standalone()
      ? 'Les PDF importés restent enregistrés sur cet iPad : on ne les importe qu’une fois.'
      : 'Importez les PDF depuis l’appli installée sur l’écran d’accueil (pas depuis un onglet Safari) : c’est là qu’ils restent enregistrés.'),
    el('div', { class: 's-row' }, el('button', { class: 'btn main', onclick: () => many.click() }, 'Importer les 3 PDF…'), many)));

  for (const def of BOOKS) {
    const id = def.id, m = local[id];
    const fileIn = el('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'hidden' });
    fileIn.addEventListener('change', () => fileIn.files[0] && importPdf(id, fileIn.files[0]));
    const card = el('div', { class: 's-card' }, el('h3', {}, def.name), el('div', { class: 'status' }, `Fichier attendu : ${def.file}….pdf`));
    if (!m) {
      card.append(el('div', { class: 's-row' }, el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Importer ce PDF…'), fileIn));
      body.append(card);
      continue;
    }
    const miss = missing(id);
    card.append(el('div', { class: 'status' }, `${m.fileName} · ${m.pages} pages`));
    if (isFrozen(id)) {
      card.append(el('div', { class: 'status' }, `Table validée ✓ (${located(id).length} chants). Plus rien ne change.`));
    } else {
      card.append(
        el('div', { class: 'status' }, `Réglage : ${located(id).length} numéros sur ${lastNum(id)} repérés.`),
        el('div', { class: 'missing' }, miss.length
          ? `Non repérés (${miss.length}) : ${miss.slice(0, 80).join(', ')}${miss.length > 80 ? '…' : ''}. Ouvrez-les depuis l’accueil puis « Corriger ».`
          : 'Tous les numéros sont repérés ✓'),
        el('div', { class: 's-row' },
          el('button', { class: 'btn main', onclick: () => exportTable(id) }, 'Exporter la table'),
          el('button', { class: 'btn', onclick: () => retune(id) }, 'Refaire le repérage')));
    }
    card.append(el('div', { class: 's-row' },
      el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Remplacer le PDF…'), fileIn,
      el('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`Retirer « ${def.name} » de cet iPad ?`)) return;
        await db.delMeta(id); await db.delFile(id); delete local[id]; delete docs[id];
        renderSettings(); renderBooks(); updateHint();
      } }, 'Retirer')));
    body.append(card);
  }
}

/* ---------- Navigation ---------- */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === name));
  if (name === 'settings') renderSettings();
  if (name === 'home') { renderBooks(); updateHint(); renderSearch(); }
}

function wire() {
  document.querySelectorAll('.keypad button').forEach(b => b.addEventListener('click', () => press(b.dataset.k)));
  $('#btn-open').addEventListener('click', () => openScore(current, +typed));
  $('#search').addEventListener('input', renderSearch);
  $('#btn-settings').addEventListener('click', () => showScreen('settings'));
  $('#btn-settings-back').addEventListener('click', () => showScreen('home'));
  $('#btn-back').addEventListener('click', () => { typed = ''; showScreen('home'); });
  $('#btn-prev').addEventListener('click', () => openScore(view.id, view.n - 1));
  $('#btn-next').addEventListener('click', () => openScore(view.id, view.n + 1));
  $('#btn-fit').addEventListener('click', () => { fit = fit === 'width' ? 'page' : 'width'; store.set('fit', fit); openScore(view.id, view.n); });
  $('#btn-fix').addEventListener('click', toggleFix);
  document.querySelectorAll('#v-marks button').forEach(b => b.addEventListener('click', () => setMark(b.dataset.m)));
  $('#btn-ink').addEventListener('click', toggleInk);
  document.querySelectorAll('#v-tools [data-tool]').forEach(b => b.addEventListener('click', () => pickTool(b.dataset.tool)));
  $('#btn-undo').addEventListener('click', undoInk);
  $('#btn-clear').addEventListener('click', clearInk);
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const home = $('#home').classList.contains('active');
    if (home && /^\d$/.test(e.key)) press(e.key);
    else if (home && e.key === 'Backspace') press('B');
    else if (home && e.key === 'Enter') $('#btn-open').click();
    else if (!home && e.key === 'Escape') $('#btn-back').click();
  });
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if ($('#viewer').classList.contains('active')) openScore(view.id, view.n); }, 300);
  });
}

(async function init() {
  $('#ver').textContent = VERSION;
  wire();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      // Cherche une nouvelle version à chaque retour sur l'appli.
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  await loadAll();
  // PDF repris de la version 1 : on applique la nouvelle règle du recueil.
  for (const id of IDS) {
    if (local[id] && !isFrozen(id) && !local[id].tunedWith) {
      try { await tune(id, f => busy(`Repérage : ${bookDef(id).name}…`, f)); } catch {}
    }
  }
  busy(false);
  if (!local[current]) current = IDS.find(i => local[i]) || IDS[0];
  showScreen('home');
})();
