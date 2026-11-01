'use strict';
const VERSION = '3.6';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// Les trois recueils sont fixes. Chacun a sa propre règle pour repérer les numéros
// (utilisée seulement pendant le réglage) ; ensuite tout vient de data/tables.json.
const BOOKS = [
  { id: 'lq', name: 'Reflets 4', color: '#e8730c', file: 'LQ-Reflets', rule: 'topLeft' },
  { id: 'hec', name: 'H&C', color: '#1a1a1a', file: 'HeC_A4', rule: 'hecHeader' },
  { id: 'hc', name: 'New H&C', color: '#12a3a8', file: 'h_c_pdf-interactif', rule: 'topLeftBig' },
];
const IDS = BOOKS.map(b => b.id);
const TAG = { lq: 'R', hec: 'HC', hc: 'NHC' }; // préfixe des numéros dans la recherche (R232, HC12, NHC45)
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
    const r = indexedDB.open('partitions', 4);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      for (const name of ['files', 'marks', 'ink', 'sung', 'notes']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
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
    all: name => new Promise(async res => {
      const out = {};
      await tx(name, 'readonly', s => { const c = s.openCursor(); c.onsuccess = () => { const k = c.result; if (k) { out[k.key] = k.value; k.continue(); } }; return c; });
      res(out);
    }),
    allMarks: () => db.all('marks'),
    setNote: (key, text) => tx('notes', 'readwrite', s => text ? s.put(text, key) : s.delete(key)),
    setSung: (key, dates) => tx('sung', 'readwrite', s => dates.length ? s.put(dates, key) : s.delete(key)),
    setMark: (key, v) => tx('marks', 'readwrite', s => v ? s.put(v, key) : s.delete(key)),
    getInk: key => tx('ink', 'readonly', s => s.get(key)),
    putInk: (key, strokes) => tx('ink', 'readwrite', s => strokes.length ? s.put(strokes, key) : s.delete(key)),
  };
})();

let notes = {};      // "recueil:n" -> texte libre (ex. ce qui pose difficulté)
let sung = {};       // "recueil:n" -> ['2026-11-01', …] : dates où le chant a été chanté
let marks = {};      // "recueil:n" -> 'ok' | 'hard' | 'fail'
const MARKS = { ok: 'Bien connu', hard: 'Difficultés', fail: 'Pas encore' };
let local = {};       // id -> {id, fileName, pages, map:{n:[page,y]}}
let fixed = {};       // id -> table figée de data/tables.json
let lyrics = {};      // id -> {n: {t, v:[{n, t, r?}]}} : paroles importées (jamais publiées en ligne)
let lyrPdf = {};      // id -> {fileName, pages, map:{n:[page, y]}} : PDF de paroles importé par recueil
let lyrIndex = [];    // [{id, n, title, ft, text}] : textes repliés pour la recherche
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
  try { sung = await db.all('sung'); } catch { sung = {}; }
  try { notes = await db.all('notes'); } catch { notes = {}; }
  try { lyrics = (await db.getFile('lyrics')) || {}; } catch { lyrics = {}; }
  lyrPdf = {};
  for (const id of IDS) { try { const m = await db.getFile('lyrmeta:' + id); if (m) lyrPdf[id] = m; } catch {} }
  buildIndex();
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
let mode = store.get('mode', 'score') === 'lyrics' ? 'lyrics' : 'score';
let typed = '';
const hasLyrics = id => !!lyrPdf[id] || !!(lyrics[id] && Object.keys(lyrics[id]).length);
const usable = id => mode === 'lyrics' ? hasLyrics(id) : !!local[id];
function openSong(id, n, hl) {
  if (mode === 'lyrics' && lyrPdf[id]) return openLyricsPdf(id, n);
  return mode === 'lyrics' && hasLyrics(id) ? openLyrics(id, n, hl) : openScore(id, n);
}

function renderMode() {
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#search').placeholder = lyrIndex.length ? 'Titre, mots des paroles ou n° (R232, HC12, NHC45)' : 'Titre ou n° (R232, HC12, NHC45)';
}

// Une ligne par recueil : les partitions à gauche, les paroles seules à droite.
function renderBooks() {
  const box = $('#books');
  box.innerHTML = '';
  for (const def of BOOKS) {
    const id = def.id;
    for (const m of ['score', 'lyrics']) {
      const has = m === 'lyrics' ? hasLyrics(id) : !!local[id];
      const meta = m === 'lyrics'
        ? (has ? 'Paroles uniquement' : 'Paroles à importer')
        : !has ? 'PDF à importer'
        : isFrozen(id) ? `Partitions · n° 1 à ${lastNum(id)}`
        : `Réglage en cours · ${located(id).length}/${lastNum(id)}`;
      box.append(el('button', {
        class: `book ${m === 'lyrics' ? 'lyr' : ''}` + (current === id && mode === m ? ' selected' : '') + (has ? '' : ' empty'),
        style: `--book: ${def.color}`,
        onclick: () => {
          if (!has) return showScreen('settings');
          current = id; mode = m; store.set('book', id); store.set('mode', m);
          renderMode(); renderBooks(); updateHint(); renderSearch();
        }
      }, el('span', { class: 'name' }, def.name), el('span', { class: 'meta' }, meta)));
    }
  }
}

function updateHint() {
  $('#num').textContent = typed || ' ';
  const id = current, n = +typed, t = table(id);
  let hint = ' ';
  const L = mode === 'lyrics' && (lyrPdf[id] ? n >= 1 && n <= lastNum(id) && !beyondLyrics(id, n) : lyrics[id] && lyrics[id][n]);
  if (!usable(id)) hint = mode === 'lyrics' ? 'Importez d’abord les paroles de ce recueil' : 'Importez d’abord ce recueil';
  else if (mode === 'lyrics' && typed && n <= lastNum(id) && !L) hint = 'Pas de paroles pour ce numéro';
  else if (L) hint = (L.t || (t[n] && t[n].t) || ' ') + (lyrPdf[id] && !(lyrPdf[id].map || {})[n] ? ' (emplacement approximatif)' : '');
  else if (typed && n > lastNum(id)) hint = `Ce recueil va jusqu’au n° ${lastNum(id)}`;
  else if (typed && t[n]) hint = t[n].t || `page ${t[n].p}`;
  else if (typed) hint = 'emplacement approximatif';
  const mk = typed && marks[`${id}:${n}`];
  $('#hint').textContent = hint;
  if (mk) $('#hint').prepend(el('span', { class: `dot ${mk}` }));
  $('#btn-open').disabled = !usable(id) || !n || n > lastNum(id) || (mode === 'lyrics' && !L);
}

function press(k) {
  if (k === 'C') typed = '';
  else if (k === 'B') typed = typed.slice(0, -1);
  else if (typed.length < 3) typed = (typed + k).replace(/^0+/, '');
  updateHint();
}

// Recherche (sans tenir compte des accents, de la casse ni de la ponctuation).
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[œ]/g, 'oe').replace(/[æ]/g, 'ae').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const songText = s => (s.v || []).map(v => v.t).join('\n');

function buildIndex() {
  lyrIndex = [];
  for (const def of BOOKS) {
    const id = def.id, t = table(id);
    const add = (n, title, text) => lyrIndex.push({ id, n: +n, title, ft: ' ' + fold(title), fx: ' ' + fold(text), text });
    if (lyrics[id] && Object.keys(lyrics[id]).length) {
      for (const [n, s] of Object.entries(lyrics[id])) add(n, s.t || (t[n] || {}).t || '', songText(s));
    } else if (lyrPdf[id] && lyrPdf[id].text) {
      for (const [n, text] of Object.entries(lyrPdf[id].text)) add(n, (t[n] || {}).t || '', text);
    }
  }
}

// Texte de chaque chant, lu dans le PDF de paroles (pour la recherche par mots).
async function lyrTexts(id) {
  const m = lyrPdf[id], map = m.map || {};
  const ks = Object.keys(map).map(Number).sort((a, b) => a - b);
  if (!ks.length) return {};
  const doc = await getDoc(lyrKey(id));
  const lines = []; // {p, y, s}
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = readItems(await page.getTextContent(), page).sort((a, b) => a.y - b.y || a.x - b.x);
    let cur = null;
    for (const it of items) {
      if (cur && Math.abs(it.y - cur.y) < 0.006) cur.s += ' ' + it.s;
      else { cur = { p, y: it.y, s: it.s }; lines.push(cur); }
    }
    page.cleanup();
  }
  const pos = (p, y) => p * 2 + y;
  const out = {};
  ks.forEach((n, i) => {
    const a = pos(map[n][0], map[n][1] - 0.01);
    const b = i + 1 < ks.length ? pos(map[ks[i + 1]][0], map[ks[i + 1]][1] - 0.01) : Infinity;
    out[n] = lines.filter(l => pos(l.p, l.y) >= a && pos(l.p, l.y) < b).map(l => l.s).join('\n');
  });
  return out;
}
async function refreshLyrTexts(id) {
  try {
    lyrPdf[id].text = await lyrTexts(id);
    await db.putFile('lyrmeta:' + id, lyrPdf[id]);
    buildIndex(); renderSearch();
  } catch {}
}

// Chaque mot tapé doit se trouver dans le chant, en début de mot (« glo » trouve « gloire »).
const terms = q => fold(q).split(' ').filter(Boolean);
const hasAll = (hay, ts) => ts.every(w => hay.includes(' ' + w));

// Extrait de texte autour du premier mot trouvé, mots trouvés surlignés.
function marked(text, ts) {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\s+)/)) {
    const f = fold(part);
    if (f && ts.some(w => f.split(' ').some(x => x.startsWith(w)))) frag.append(el('mark', {}, part));
    else frag.append(part);
  }
  return frag;
}
function snippet(text, ts) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => ts.some(w => (' ' + fold(l)).includes(' ' + w)));
  if (i < 0) return null;
  return lines.slice(i, i + 2).join(' / ');
}

// Recueils où chercher : choisis au-dessus du champ de recherche (un ou plusieurs).
let scope = (store.get('scope', IDS) || []).filter(id => IDS.includes(id));
if (!scope.length) scope = [...IDS];
function renderScope() {
  const box = $('#scope');
  box.innerHTML = '';
  for (const def of BOOKS) {
    const on = scope.includes(def.id);
    box.append(el('button', { class: 'scope-b' + (on ? ' on' : ''), style: `--book: ${def.color}`, 'aria-pressed': String(on),
      onclick: () => {
        scope = on ? scope.filter(x => x !== def.id) : IDS.filter(x => x === def.id || scope.includes(x));
        if (!scope.length) scope = [def.id];
        store.set('scope', scope); renderScope(); renderSearch();
      } }, el('b', {}, TAG[def.id]), ' ', def.name));
  }
}

function openHit(id, n, ts) {
  if (mode === 'lyrics' && hasLyrics(id) && !(lyrPdf[id] && beyondLyrics(id, n))) return lyrPdf[id] ? openLyricsPdf(id, n) : openLyrics(id, n, ts);
  if (local[id]) return openScore(id, n);
  if (hasLyrics(id)) return lyrPdf[id] ? openLyricsPdf(id, n) : openLyrics(id, n, ts);
}

function renderSearch() {
  const raw = $('#search').value || '';
  const box = $('#results');
  box.innerHTML = '';
  // « R232 », « HC 12 », « NHC45 » : ouvre directement ce numéro
  const direct = raw.trim().match(/^(nhc|hc|r)\s*(\d{1,3})$/i);
  const ts = terms(raw);
  if (fold(raw).length < 2 && !direct) return;
  const hits = [];
  if (direct) {
    const id = Object.keys(TAG).find(k => TAG[k] === direct[1].toUpperCase()), n = +direct[2];
    if (n >= 1 && n <= lastNum(id)) hits.push({ id, n, title: (table(id)[n] || {}).t || '', score: -1 });
  } else {
    for (const id of scope) {
      const t = table(id), seen = new Set();
      for (const n of Object.keys(t).map(Number))
        if (t[n].t && hasAll(' ' + fold(t[n].t), ts)) { hits.push({ id, n, title: t[n].t, score: 0 }); seen.add(n); }
      for (const s of lyrIndex) {
        if (s.id !== id || seen.has(s.n)) continue;
        if (hasAll(s.ft, ts)) hits.push({ id, n: s.n, title: s.title, score: 0 });
        else if (hasAll(s.ft + ' ' + s.fx, ts)) hits.push({ id, n: s.n, title: s.title, snip: snippet(s.text, ts), score: 1 });
      }
    }
  }
  hits.sort((a, b) => a.score - b.score || IDS.indexOf(a.id) - IDS.indexOf(b.id) || a.n - b.n);
  if (!hits.length) box.append(el('div', { class: 'r-empty' }, 'Aucun chant trouvé'));
  const shown = hits.slice(0, 50);
  for (const h of shown) {
    const def = bookDef(h.id);
    const b = el('button', { class: 'r-item', style: `--book: ${def.color}`, onclick: () => openHit(h.id, h.n, ts) });
    b.append(el('b', {}, TAG[h.id] + h.n), ' ', marked(h.title || '', ts));
    const mk = marks[`${h.id}:${h.n}`];
    if (mk) b.append(el('span', { class: `dot ${mk}` }));
    if (h.snip) b.append(el('span', { class: 'r-snip' }, marked(h.snip, ts)));
    box.append(b);
  }
  if (hits.length > shown.length) box.append(el('div', { class: 'r-empty' }, `… et ${hits.length - shown.length} autres : ajoutez un mot pour préciser.`));
}

/* ---------- Paroles seules ---------- */
let lview = { id: '', n: 0, hl: [] };
let lsize = store.get('lsize', 24);
function openLyrics(id, n, hl) {
  const L = lyrics[id] || {};
  if (n < 1 || n > lastNum(id)) return;
  lview = { id, n, hl: hl || [] };
  showScreen('lyrics');
  const s = L[n];
  const title = (s && s.t) || (table(id)[n] || {}).t || '';
  $('#l-title').textContent = `${bookDef(id).name} · n° ${n}${title ? ' · ' + title : ''}`;
  $('#l-score').classList.toggle('hidden', !local[id]);
  lyrBar(false);
  renderSung();
  const body = $('#l-body');
  body.innerHTML = '';
  body.scrollTop = 0;
  const wrap = el('div', { class: 'l-wrap' });
  wrap.style.setProperty('--lsize', lsize + 'px');
  if (!s) wrap.append(el('div', { class: 'l-empty' }, 'Pas de paroles pour ce numéro.'));
  else for (const v of s.v || []) {
    const t = el('div', { class: 't' });
    t.append(lview.hl.length ? marked(v.t, lview.hl) : v.t);
    wrap.append(el('div', { class: 'l-verse' + (v.r ? ' refrain' : '') }, el('span', { class: 'n' }, v.r ? 'R.' : String(v.n || '')), t));
  }
  body.append(wrap);
  const m = body.querySelector('mark');
  if (m) m.scrollIntoView({ block: 'center' });
}
function stepLyrics(d) {
  if (lview.pdf) return openLyricsPdf(lview.id, lview.n + d);
  const L = lyrics[lview.id] || {};
  let n = lview.n + d;
  while (n >= 1 && n <= lastNum(lview.id) && !L[n]) n += d;
  if (L[n]) openLyrics(lview.id, n);
}

// Fichier de paroles : {"books": {"hec": {"1": {"t": "…", "v": [{"n": 1, "t": "…"}, …]}, …}, "hc": …, "lq": …}}
async function importLyrics(file) {
  try {
    busy('Lecture des paroles…', 0.3);
    const data = JSON.parse(await file.text());
    const books = data.books || data;
    let count = 0;
    const next = { ...lyrics };
    for (const id of IDS) {
      if (!books[id]) continue;
      const songs = {};
      for (const [n, s] of Object.entries(books[id])) {
        if (!/^\d+$/.test(n) || !s) continue;
        const v = (s.v || []).map((x, i) => typeof x === 'string' ? { n: i + 1, t: x } : x).filter(x => x && x.t);
        songs[+n] = { t: s.t || '', v };
        count++;
      }
      next[id] = songs;
    }
    if (!count) throw new Error('aucun chant trouvé dans ce fichier');
    await db.putFile('lyrics', next);
    lyrics = next; buildIndex();
    alert(`Paroles importées : ${count} chants.`);
  } catch (e) {
    alert('Import des paroles impossible : ' + e.message);
  } finally {
    busy(false); renderSettings(); renderBooks(); renderMode(); updateHint();
  }
}

/* ---------- PDF de paroles ---------- */
// Le PDF est rangé dans le magasin « files » : 'lyrbuf:<id>' (le fichier) et 'lyrmeta:<id>' (nom, pages, repérage).
const lyrKey = id => 'lyrbuf:' + id;
function lyrBar(pdf) {
  $('#l-smaller').classList.toggle('hidden', pdf);
  $('#l-bigger').classList.toggle('hidden', pdf);
  $('#l-fix').classList.toggle('hidden', !pdf);
  $('#l-fix').textContent = 'Corriger';
  $('#l-warn').classList.add('hidden');
}

// Repère le début de chaque chant : un numéro seul (ou en tête de ligne) qui se suit d'un chant à l'autre.
// On garde la taille de caractère qui donne la meilleure suite 1, 2, 3… (les numéros de couplets sont d'ordinaire plus petits).
// Reflets 4 : une page par chant, numéro en haut à droite (parfois en police au codage décalé, cf. digits()).
function topRightNum(items, last) {
  const top = items.filter(i => i.y < 0.2 && i.x > 0.55 && digits(i.s) !== null);
  const lines = {};
  for (const i of top) (lines[i.y.toFixed(2)] ||= []).push(i);
  for (const k of Object.keys(lines).sort()) {
    const n = +lines[k].sort((a, b) => a.x - b.x).map(i => digits(i.s)).join('');
    if (n >= 1 && n <= last) return n;
  }
  return 0;
}
// Comble les trous quand l'écart de pages égale l'écart de numéros (une page par chant).
function fillGaps(map) {
  const ks = Object.keys(map).map(Number).sort((a, b) => a - b);
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i], b = ks[i + 1];
    if (b - a > 1 && map[b][0] - map[a][0] === b - a)
      for (let k = a + 1; k < b; k++) map[k] = [map[a][0] + k - a, 0];
  }
  return map;
}

async function tuneLyrics(id, onProgress) {
  const doc = await getDoc(lyrKey(id));
  const last = lastNum(id) || 999;
  const cands = [];
  const perPage = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = readItems(await page.getTextContent(), page).sort((a, b) => a.y - b.y || a.x - b.x);
    if (id === 'lq') {
      const n = topRightNum(items, last);
      if (n && !perPage[n]) perPage[n] = [p, 0];
      page.cleanup();
      if (onProgress && (p % 5 === 0 || p === doc.numPages)) onProgress(p / doc.numPages);
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // « n° 12 » n'importe où dans la ligne : repère prioritaire
      const nm = it.s.match(/\bn\s*[°º]\s*(\d{1,3})\b/i) || ((/\bn\s*[°º]\s*$/i.test(it.s) && items[i + 1] && /^\d{1,3}\b/.test(items[i + 1].s)) ? [0, items[i + 1].s.match(/^\d{1,3}/)[0]] : null);
      if (nm && +nm[1] >= 1 && +nm[1] <= last) { cands.push({ n: +nm[1], p, y: +it.y.toFixed(3), size: 1000 }); continue; }
      const m = it.s.match(/^(?:n\s*°\s*)?(\d{1,3})(?:[.):\-–]|\s|$)/i);
      if (!m) continue;
      const n = +m[1];
      if (n < 1 || n > last) continue;
      // en tête de ligne : rien à gauche sur la même ligne
      const lineLeft = items.some(o => o !== it && Math.abs(o.y - it.y) < 0.006 && o.x < it.x - 0.01);
      if (lineLeft) continue;
      cands.push({ n, p, y: +it.y.toFixed(3), size: Math.round(it.size * 2) / 2 });
    }
    page.cleanup();
    if (onProgress && (p % 5 === 0 || p === doc.numPages)) onProgress(p / doc.numPages);
  }
  const walk = list => {
    const map = {};
    let expect = 1;
    for (const c of list) {
      if (c.n >= expect && c.n <= expect + 3 && !map[c.n]) { map[c.n] = [c.p, c.y]; expect = c.n + 1; }
    }
    return map;
  };
  if (id === 'lq') return fillGaps(monotonic(perPage));
  let best = {};
  for (const size of [...new Set(cands.map(c => c.size))].sort((a, b) => b - a)) {
    const map = walk(cands.filter(c => c.size >= size));
    if (Object.keys(map).length > Object.keys(best).length) best = map;
  }
  return monotonic(best);
}

async function importLyricsPdf(id, file) {
  try {
    busy('Enregistrement des paroles…', 0);
    await db.putFile(lyrKey(id), await file.arrayBuffer());
    delete docs[lyrKey(id)];
    const doc = await getDoc(lyrKey(id));
    const meta = { fileName: file.name, pages: doc.numPages, map: {} };
    meta.map = await tuneLyrics(id, f => busy('Repérage des chants…', f));
    lyrPdf[id] = meta;
    busy('Lecture du texte pour la recherche…', 1);
    meta.text = await lyrTexts(id);
    await db.putFile('lyrmeta:' + id, meta);
    lyrPdf[id] = meta;
    buildIndex();
    const found = Object.keys(meta.map).length;
    alert(`Paroles de ${bookDef(id).name} : ${found} chants repérés sur ${lastNum(id)}.` +
      (found < lastNum(id) && !beyondLyrics(id, found + 1) ? ' Pour les autres, ouvrez le chant puis « Corriger ».' : ''));
  } catch (e) {
    alert('Import impossible : ' + e.message);
  } finally {
    busy(false); renderSettings(); renderBooks(); updateHint();
  }
}

// Le PDF de paroles s'arrête avant la fin du recueil (ex. Reflets : paroles jusqu'au n° 292).
function beyondLyrics(id, n) {
  const m = lyrPdf[id], ks = Object.keys((m && m.map) || {}).map(Number);
  if (!ks.length) return false;
  const top = Math.max(...ks);
  return n > top && m.map[top][0] >= m.pages - 1;
}
function lyrRange(id, n) {
  const m = lyrPdf[id], map = m.map || {}, pages = m.pages || 1;
  const ks = Object.keys(map).map(Number).sort((a, b) => a - b);
  const nextK = ks.find(k => k > n), next = nextK !== undefined ? map[nextK] : null;
  if (map[n]) {
    const [start, y] = map[n];
    let end = !next ? Math.min(start + 2, pages) : next[0] <= start ? start : next[1] > 0.3 ? next[0] : next[0] - 1;
    return { start, end: Math.min(Math.max(start, end), start + 6), y, exact: true };
  }
  const prevK = ks.filter(k => k < n).pop();
  const start = prevK !== undefined ? map[prevK][0] : 1;
  const end = next ? next[0] : Math.min(start + 3, pages);
  return { start, end: Math.min(end, start + 8, pages), y: 0, exact: false };
}

async function openLyricsPdf(id, n) {
  if (n < 1 || n > lastNum(id) || beyondLyrics(id, n)) return;
  lview = { id, n, hl: [], pdf: true, fixing: false, token: (lview.token || 0) + 1 };
  const token = lview.token;
  showScreen('lyrics');
  const title = (table(id)[n] || {}).t || '';
  $('#l-title').textContent = `${bookDef(id).name} · n° ${n}${title ? ' · ' + title : ''}`;
  $('#l-score').classList.toggle('hidden', !local[id]);
  lyrBar(true);
  renderSung();
  const r = lyrRange(id, n);
  const warn = $('#l-warn');
  if (!r.exact) { warn.classList.remove('hidden'); warn.textContent = `Le n° ${n} n’est pas repéré dans ce PDF. Touchez « Corriger » puis la page où il commence.`; }
  const body = $('#l-body');
  body.innerHTML = '';
  body.scrollTop = 0;
  const box = el('div', { class: 'pages' });
  box.style.paddingBottom = '60vh'; // pour pouvoir amener un chant du bas de page en haut de l'écran
  body.append(box);
  const doc = await getDoc(lyrKey(id));
  if (token !== lview.token) return;
  const W = body.clientWidth - 48;
  for (let p = r.start; p <= r.end; p++) {
    const page = await doc.getPage(p);
    if (token !== lview.token) return;
    const vp1 = page.getViewport({ scale: 1 });
    const cssScale = Math.min(W, 1000) / vp1.width;
    const cssW = vp1.width * cssScale, cssH = vp1.height * cssScale;
    let scale = cssScale * Math.min(window.devicePixelRatio || 1, 3);
    if (vp1.width * vp1.height * scale * scale > 16e6) scale = Math.sqrt(16e6 / (vp1.width * vp1.height));
    const vp = page.getViewport({ scale });
    const canvas = el('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const div = el('div', { class: 'page', 'data-page': p }, canvas, el('span', { class: 'tag' }, `p. ${p}`));
    div.style.width = cssW + 'px'; div.style.height = cssH + 'px';
    if (lview.fixing) div.classList.add('fixable');
    div.addEventListener('click', e => fixLyrHere(p, e.offsetY / cssH));
    box.append(div);
    if (p === r.start && r.y > 0.08) body.scrollTop = div.offsetTop - body.offsetTop + (r.y - 0.04) * cssH;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}

function toggleLyrFix() {
  lview.fixing = !lview.fixing;
  $('#l-fix').textContent = lview.fixing ? 'Annuler' : 'Corriger';
  document.querySelectorAll('#l-body .page').forEach(d => d.classList.toggle('fixable', lview.fixing));
  const warn = $('#l-warn');
  if (lview.fixing) { warn.classList.remove('hidden'); warn.textContent = `Touchez l’endroit où commence le n° ${lview.n}.`; }
  else warn.classList.add('hidden');
}

async function fixLyrHere(p, y) {
  if (!lview.fixing) return;
  const m = lyrPdf[lview.id];
  m.map[lview.n] = [p, +Math.max(0, Math.min(1, y)).toFixed(3)];
  await db.putFile('lyrmeta:' + lview.id, m);
  openLyricsPdf(lview.id, lview.n);
  refreshLyrTexts(lview.id);
}

/* ---------- Visionneuse ---------- */
// Icônes au trait, dans l'esprit des symboles Apple.
const svg = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  // page entière : quatre coins qui s'écartent
  page: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  // pleine largeur : flèches gauche / droite
  width: svg('<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>'),
};
let view = { id: '', n: 0, fixing: false, token: 0 };
let fit = store.get('fit', 'width');

async function openScore(id, n) {
  if (!local[id] || n < 1 || n > lastNum(id)) return;
  view = { id, n, fixing: false, token: view.token + 1 };
  const token = view.token;
  showScreen('viewer');
  const t = table(id)[n];
  $('#v-title').textContent = `n° ${n}${t && t.t ? ' · ' + t.t : ''}`;
  const fb = $('#btn-fit');
  fb.innerHTML = fit === 'width' ? ICONS.page : ICONS.width;
  fb.setAttribute('aria-label', fit === 'width' ? 'Page entière' : 'Pleine largeur');
  fb.title = fb.getAttribute('aria-label');
  $('#btn-fix').textContent = 'Corriger';
  $('#btn-fix').classList.toggle('hidden', isFrozen(id));
  renderMarks();
  renderSung();
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
  const key = `${view.id}:${view.n}`;
  const v = marks[key];
  document.querySelectorAll('#v-marks button[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === v));
  $('#btn-note').classList.toggle('has', !!notes[key]);
  $('#btn-note').title = notes[key] ? notes[key] : 'Ajouter une note';
  closeNote();
}
async function setMark(m) {
  const key = `${view.id}:${view.n}`;
  const v = marks[key] === m ? null : m; // toucher la pastille active l'enlève
  if (v) marks[key] = v; else delete marks[key];
  renderMarks();
  try { await db.setMark(key, v); } catch {}
  // En jaune ou en rouge, on propose tout de suite de noter ce qui coince.
  if ((v === 'hard' || v === 'fail') && !notes[key]) openNote();
}

/* ---------- Note libre sur un chant (bulle flottante) ---------- */
let noteTimer;
function openNote() {
  const key = `${view.id}:${view.n}`;
  const pop = $('#note-pop'), ta = $('#note-text');
  const m = marks[key];
  $('#note-head').textContent = m === 'hard' ? 'Qu’est-ce qui est difficile ?' : m === 'fail' ? 'Qu’est-ce qui bloque ?' : 'Note sur ce chant';
  ta.value = notes[key] || '';
  pop.classList.remove('hidden');
  const r = $('#btn-note').getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.left = Math.max(12, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 12)) + 'px';
  ta.focus();
}
function closeNote() {
  const pop = $('#note-pop');
  if (pop && !pop.classList.contains('hidden')) { saveNote(); pop.classList.add('hidden'); }
}
function saveNote() {
  clearTimeout(noteTimer);
  const key = `${view.id}:${view.n}`, text = $('#note-text').value.trim();
  if (text) notes[key] = text; else delete notes[key];
  $('#btn-note').classList.toggle('has', !!text);
  $('#btn-note').title = text || 'Ajouter une note';
  db.setNote(key, text).catch(() => {});
}

/* ---------- Chants chantés : une date par fois ---------- */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const frDate = iso => iso ? iso.split('-').reverse().join('/') : '';
function sungKey() {
  return $('#lyrics').classList.contains('active') ? `${lview.id}:${lview.n}` : `${view.id}:${view.n}`;
}
function renderSung() {
  const dates = sung[sungKey()] || [];
  const on = dates.includes(today());
  const tip = dates.length ? `Chanté ${dates.length} fois · dernière fois le ${frDate(dates[dates.length - 1])}` : 'Jamais marqué comme chanté';
  document.querySelectorAll('.sung-btn').forEach(b => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    b.title = tip;
    b.querySelector('.sung-n').textContent = dates.length ? `×${dates.length}` : '';
  });
}
// Coché = chanté aujourd'hui ; décocher retire seulement la date du jour.
async function toggleSung() {
  const key = sungKey(), d = today();
  const dates = (sung[key] || []).filter(x => x !== d);
  if (dates.length === (sung[key] || []).length) dates.push(d);
  dates.sort();
  if (dates.length) sung[key] = dates; else delete sung[key];
  renderSung();
  try { await db.setSung(key, dates); } catch {}
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

function download(name, text, type = 'application/json') {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
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
    // PDF de paroles seules (facultatif)
    const L = lyrPdf[id];
    const lyrIn = el('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'hidden' });
    lyrIn.addEventListener('change', () => lyrIn.files[0] && importLyricsPdf(id, lyrIn.files[0]));
    const lyrRow = el('div', { class: 's-sub' },
      el('div', { class: 'status' }, L
        ? `Paroles : ${L.fileName} · ${L.pages} pages · ${Object.keys(L.map || {}).length}/${lastNum(id)} chants repérés`
        : 'Paroles : aucun PDF importé'),
      el('div', { class: 's-row' },
        el('button', { class: 'btn', onclick: () => lyrIn.click() }, L ? 'Remplacer le PDF de paroles…' : 'Importer le PDF de paroles…'), lyrIn,
        ...(L ? [
          el('button', { class: 'btn', onclick: async () => {
            if (!confirm('Refaire le repérage des chants ? Les corrections faites à la main seront perdues.')) return;
            try { busy('Repérage des chants…', 0); L.map = await tuneLyrics(id, f => busy('Repérage des chants…', f)); L.text = await lyrTexts(id); await db.putFile('lyrmeta:' + id, L); buildIndex(); }
            catch (e) { alert('Erreur : ' + e.message); }
            finally { busy(false); renderSettings(); }
          } }, 'Refaire le repérage'),
          el('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(`Retirer les paroles de « ${def.name} » de cet iPad ?`)) return;
            await db.delFile(lyrKey(id)); await db.delFile('lyrmeta:' + id); delete lyrPdf[id]; delete docs[lyrKey(id)]; buildIndex();
            renderSettings(); renderBooks(); updateHint();
          } }, 'Retirer les paroles')] : [])));

    if (!m) {
      card.append(el('div', { class: 's-row' }, el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Importer ce PDF…'), fileIn));
      card.append(lyrRow);
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
    card.append(lyrRow);
    body.append(card);
  }
}

/* ---------- Tableau récapitulatif ---------- */
// Une ligne par chant des trois recueils : titre, page, pastille, pages annotées. Exportable pour Excel.
let grid = { book: 'all', mark: 'all', sung: 'all', sort: 'num', q: '', inkKeys: new Set() };
const MARK_CYCLE = [undefined, 'ok', 'hard', 'fail'];

function gridRows() {
  const rows = [];
  for (const def of BOOKS) {
    if (grid.book !== 'all' && grid.book !== def.id) continue;
    const t = table(def.id);
    for (let n = 1; n <= lastNum(def.id); n++) {
      const s = t[n] || {};
      const r = s.p ? rangeFor(def.id, n) : null;
      const inked = [];
      if (r) for (let p = r.start; p <= r.end; p++) if (grid.inkKeys.has(`${def.id}:${p}`)) inked.push(p);
      const dates = sung[`${def.id}:${n}`] || [];
      rows.push({ id: def.id, book: def.name, n, title: s.t || '', page: s.p || '', mark: marks[`${def.id}:${n}`], inked,
        times: dates.length, last: dates[dates.length - 1] || '', dates, note: notes[`${def.id}:${n}`] || '' });
    }
  }
  const q = fold(grid.q);
  const out = rows.filter(r => (grid.mark === 'all' || (grid.mark === 'none' ? !r.mark : r.mark === grid.mark))
    && (grid.sung === 'all' || (grid.sung === 'yes' ? r.times : !r.times))
    && (!q || fold(`${r.n} ${r.title} ${r.note}`).includes(q)));
  // Les tris gardent l'ordre recueil / n° en cas d'égalité (Array.sort est stable).
  if (grid.sort === 'times') out.sort((a, b) => b.times - a.times || b.last.localeCompare(a.last));
  if (grid.sort === 'last') out.sort((a, b) => b.last.localeCompare(a.last));
  if (grid.sort === 'oldest') out.sort((a, b) => (a.last || '0').localeCompare(b.last || '0'));
  return out;
}

async function openGrid() {
  showScreen('grid');
  try { grid.inkKeys = new Set(Object.keys(await db.all('ink'))); } catch { grid.inkKeys = new Set(); }
  renderGrid();
}

function renderGrid() {
  const chips = (list, key) => list.map(([v, label, cls]) => el('button', {
    class: 'chip' + (grid[key] === v ? ' on' : '') + (cls ? ' ' + cls : ''),
    onclick: () => { grid[key] = v; renderGrid(); }
  }, label));
  $('#g-books').replaceChildren(...chips([['all', 'Tous'], ...BOOKS.map(d => [d.id, d.name])], 'book'));
  $('#g-marks').replaceChildren(...chips([['all', 'Toutes'], ['ok', 'Vert', 'c-ok'], ['hard', 'Jaune', 'c-hard'], ['fail', 'Rouge', 'c-fail'], ['none', 'Sans']], 'mark'));
  $('#g-sung').replaceChildren(...chips([['all', 'Chantés ou non'], ['yes', 'Déjà chantés'], ['no', 'Jamais chantés']], 'sung'));
  $('#g-sort').replaceChildren(...chips([['num', 'Tri : n°'], ['times', 'Plus chantés'], ['last', 'Récemment'], ['oldest', 'Pas chantés depuis longtemps']], 'sort'));
  const rows = gridRows();
  const counts = { ok: 0, hard: 0, fail: 0 };
  rows.forEach(r => r.mark && counts[r.mark]++);
  const times = rows.reduce((a, r) => a + r.times, 0), distinct = rows.filter(r => r.times).length;
  $('#g-count').textContent = `${rows.length} chants · ${counts.ok} verts · ${counts.hard} jaunes · ${counts.fail} rouges · ${distinct} chants chantés, ${times} fois au total`;
  const body = $('#g-body');
  body.replaceChildren(...rows.map(r => el('tr', {},
    el('td', { class: 'g-book' }, el('span', { class: 'swatch', style: `--book: ${bookDef(r.id).color}` }), r.book),
    el('td', { class: 'g-num' }, el('button', { class: 'link', onclick: () => openSong(r.id, r.n) }, String(r.n))),
    el('td', {}, r.title),
    el('td', { class: 'g-page' }, String(r.page)),
    el('td', {}, el('button', {
      class: 'g-mark', title: 'Toucher pour changer',
      onclick: async e => {
        const key = `${r.id}:${r.n}`;
        const next = MARK_CYCLE[(MARK_CYCLE.indexOf(marks[key]) + 1) % MARK_CYCLE.length];
        if (next) marks[key] = next; else delete marks[key];
        try { await db.setMark(key, next); } catch {}
        renderGrid();
      }
    }, r.mark ? el('span', { class: `dot ${r.mark}` }) : '·', r.mark ? MARKS[r.mark] : '')),
    el('td', { class: 'g-times' }, r.times ? String(r.times) : ''),
    el('td', { class: 'g-last', title: r.dates.map(frDate).join(', ') }, frDate(r.last)),
    el('td', { class: 'g-note' }, r.note),
    el('td', { class: 'g-ink' }, r.inked.length ? `✎ p. ${r.inked.join(', ')}` : ''))));
}

function exportGridCsv() {
  const lines = [['Recueil', 'N°', 'Titre', 'Page PDF', 'Connaissance', 'Fois chanté', 'Dernière fois', 'Note', 'Pages annotées']]
    .concat(gridRows().map(r => [r.book, r.n, r.title, r.page, r.mark ? MARKS[r.mark] : '', r.times, frDate(r.last), r.note, r.inked.join(' ')]));
  saveCsv(`partitions-${today()}.csv`, lines);
}
const csvEsc = v => /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
// Point-virgule et BOM : Excel en français ouvre le fichier directement avec les accents.
function saveCsv(name, lines) {
  download(name, '\ufeff' + lines.map(l => l.map(csvEsc).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
}
// Une ligne par fois où un chant a été chanté : idéal pour un tableau croisé dynamique.
function exportHistoryCsv() {
  const lines = [['Date', 'Année', 'Mois', 'Recueil', 'N°', 'Titre', 'Connaissance']];
  const all = [];
  for (const [key, dates] of Object.entries(sung)) {
    const [id, n] = key.split(':');
    const def = bookDef(id);
    if (!def) continue;
    const t = (table(id)[n] || {}).t || '';
    for (const d of dates) all.push([d, def.name, +n, t, marks[key] ? MARKS[marks[key]] : '']);
  }
  all.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
  for (const [d, book, n, t, m] of all) lines.push([frDate(d), d.slice(0, 4), d.slice(5, 7), book, n, t, m]);
  if (all.length < 1) return alert('Aucun chant n’a encore été marqué comme chanté.');
  saveCsv(`partitions-historique-${today()}.csv`, lines);
}

// Sauvegarde complète (pastilles + annotations) pour la restaurer sur cet iPad ou un autre.
async function exportBackup() {
  const data = { app: 'partitions', version: VERSION, date: new Date().toISOString(), marks: await db.all('marks'), sung: await db.all('sung'), notes: await db.all('notes'), ink: await db.all('ink') };
  download(`partitions-sauvegarde-${data.date.slice(0, 10)}.json`, JSON.stringify(data));
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'partitions') throw new Error('ce fichier n’est pas une sauvegarde de l’appli');
    const nm = Object.keys(data.marks || {}).length, ni = Object.keys(data.ink || {}).length, ns = Object.keys(data.sung || {}).length;
    if (!confirm(`Restaurer ${nm} pastilles, l’historique de ${ns} chants chantés et les annotations de ${ni} pages ? Les dates chantées sont ajoutées, le reste remplace ce qui existe pour les mêmes chants et pages.`)) return;
    for (const [k, v] of Object.entries(data.sung || {})) {
      if (!Array.isArray(v)) continue;
      const dates = [...new Set([...(sung[k] || []), ...v.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))])].sort();
      sung[k] = dates; await db.setSung(k, dates);
    }
    for (const [k, v] of Object.entries(data.marks || {})) { if (MARKS[v]) { marks[k] = v; await db.setMark(k, v); } }
    for (const [k, v] of Object.entries(data.notes || {})) if (typeof v === 'string' && v.trim()) { notes[k] = v; await db.setNote(k, v); }
    for (const [k, v] of Object.entries(data.ink || {})) if (Array.isArray(v)) await db.putInk(k, v);
    await openGrid();
    alert('Sauvegarde restaurée.');
  } catch (e) { alert('Restauration impossible : ' + e.message); }
}

/* ---------- Navigation ---------- */
function showScreen(name) {
  if (name !== 'viewer') closeNote();
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === name));
  if (name === 'settings') renderSettings();
  if (name === 'home') { renderMode(); renderScope(); renderBooks(); updateHint(); renderSearch(); }
}

function wire() {
  document.querySelectorAll('.keypad button').forEach(b => b.addEventListener('click', () => press(b.dataset.k)));
  $('#btn-open').addEventListener('click', () => openSong(current, +typed));
  document.querySelectorAll('#mode button').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode; store.set('mode', mode);
    if (!usable(current)) current = IDS.find(usable) || current;
    renderMode(); renderBooks(); updateHint(); renderSearch();
  }));
  $('#l-back').addEventListener('click', () => { typed = ''; showScreen('home'); });
  $('#btn-grid').addEventListener('click', openGrid);
  $('#g-back').addEventListener('click', () => showScreen('home'));
  $('#g-search').addEventListener('input', e => { grid.q = e.target.value; renderGrid(); });
  $('#g-csv').addEventListener('click', exportGridCsv);
  $('#g-hist').addEventListener('click', exportHistoryCsv);
  $('#btn-note').addEventListener('click', e => { e.stopPropagation(); $('#note-pop').classList.contains('hidden') ? openNote() : closeNote(); });
  $('#note-done').addEventListener('click', closeNote);
  $('#note-text').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 500); });
  $('#note-pop').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', closeNote);
  document.querySelectorAll('.sung-btn').forEach(b => b.addEventListener('click', toggleSung));
  $('#g-save').addEventListener('click', () => exportBackup().catch(e => alert('Sauvegarde impossible : ' + e.message)));
  const restoreIn = $('#g-restore-in');
  $('#g-restore').addEventListener('click', () => restoreIn.click());
  restoreIn.addEventListener('change', () => { if (restoreIn.files[0]) importBackup(restoreIn.files[0]); restoreIn.value = ''; });
  $('#l-prev').addEventListener('click', () => stepLyrics(-1));
  $('#l-next').addEventListener('click', () => stepLyrics(1));
  const resize = d => { lsize = Math.max(16, Math.min(44, lsize + d)); store.set('lsize', lsize); $('.l-wrap') && $('.l-wrap').style.setProperty('--lsize', lsize + 'px'); };
  $('#l-smaller').addEventListener('click', () => resize(-2));
  $('#l-bigger').addEventListener('click', () => resize(2));
  $('#l-score').addEventListener('click', () => openScore(lview.id, lview.n));
  $('#l-fix').addEventListener('click', toggleLyrFix);
  $('#search').addEventListener('input', renderSearch);
  $('#btn-settings').addEventListener('click', () => showScreen('settings'));
  $('#btn-settings-back').addEventListener('click', () => showScreen('home'));
  $('#btn-back').addEventListener('click', () => { typed = ''; showScreen('home'); });
  $('#btn-prev').addEventListener('click', () => openScore(view.id, view.n - 1));
  $('#btn-next').addEventListener('click', () => openScore(view.id, view.n + 1));
  $('#btn-fit').addEventListener('click', () => { fit = fit === 'width' ? 'page' : 'width'; store.set('fit', fit); openScore(view.id, view.n); });
  $('#btn-fix').addEventListener('click', toggleFix);
  document.querySelectorAll('#v-marks button[data-m]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); setMark(b.dataset.m); }));
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
    else if (!home && e.key === 'Escape') ($('#lyrics').classList.contains('active') ? $('#l-back') : $('#btn-back')).click();
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
  if (!usable(current)) current = IDS.find(usable) || IDS[0];
  showScreen('home');
  // PDF de paroles importés avant la recherche par mots : on lit leur texte en arrière-plan.
  for (const id of IDS) if (lyrPdf[id] && !lyrPdf[id].text) await refreshLyrTexts(id);
})();
