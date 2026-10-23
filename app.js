'use strict';
const VERSION = '1.1';
const SLOTS = [1, 2, 3];
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

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

/* ---------- Stockage local (IndexedDB) ---------- */
// Deux magasins : "meta" (nom, table numéro → page) et "files" (le PDF brut),
// pour ne pas relire 50 Mo à chaque modification de la table.
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('partitions', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('files');
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
  };
})();

let persisted = false;
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
let books = {};        // id -> meta {id, name, fileName, pages, map:{n:[page,y]}, last, source}
const docs = {};       // id -> Promise<PDFDocumentProxy>

async function loadBooks() {
  books = {};
  for (const m of await db.allMeta()) books[m.id] = m;
}
function getDoc(id) {
  if (!docs[id]) docs[id] = db.getFile(id).then(buf => {
    if (!buf) throw new Error('PDF absent');
    return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  });
  return docs[id];
}

/* ---------- Détection numéro → page ---------- */
const SCAN_VER = 2;
const NUM_ONLY = /^(?:n[°o]\s*)?(\d{1,3})\s*[.)]?$/i;
const NUM_MARK = /\bn[°o]\s*(\d{1,3})\b/i;
const NUM_TITLE = /^(\d{1,3})\s+[A-Za-zÀ-ÿŒœ«"'’]/;
const NUM_TRAIL = /[A-Za-zÀ-ÿ!?’'»)]\s+(\d{1,3})$/;
// Texte qui annonce un numéro de chant juste après : « n° », ou « TN » (lien vers la table numérique).
const LEAD = /(?:\bn[°o]|\bTN)\s*[>»]?\s*$/i;

// Pour chaque page : les nombres candidats.
//   s = 1 pour un numéro annoncé (« n° 12 », « TN 12 »), 0 sinon
//   r = taille de police / taille médiane de la page, y = hauteur (0 = haut)
// Les liens des pages de table des matières sont relevés à part.
async function scanPages(doc, onProgress) {
  const cands = [], links = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [x0, y0, , y1] = page.view;
    const h = (y1 - y0) || 1;
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const s = (it.str || '').trim();
      if (!s) continue;
      const t = it.transform;
      items.push({ s, size: Math.hypot(t[2], t[3]) || it.height || 0, x: t[4], yy: t[5], y: Math.min(1, Math.max(0, 1 - (t[5] - y0) / h)) });
    }
    const sizes = items.map(i => i.size).sort((a, b) => a - b);
    const med = sizes.length ? sizes[sizes.length >> 1] || 1 : 1;
    const raw = [];
    items.forEach((it, i) => {
      const before = items.slice(Math.max(0, i - 4), i).map(o => o.s).join(' ');
      let m, v = 0, strong = 0;
      if ((m = it.s.match(NUM_ONLY))) { v = +m[1]; strong = LEAD.test(before) || /^n[°o]/i.test(it.s) ? 1 : 0; }
      else if ((m = it.s.match(NUM_MARK))) { v = +m[1]; strong = 1; }
      else if ((m = it.s.match(/\bTN\s*[>»]?\s*(\d{1,3})$/))) { v = +m[1]; strong = 1; }
      else if ((m = it.s.match(NUM_TITLE)) || (m = it.s.match(NUM_TRAIL))) v = +m[1];
      if (v > 0) raw.push({ v, s: strong, r: +(it.size / med).toFixed(2), y: +it.y.toFixed(3) });
    });
    cands.push(raw);

    // Table des matières cliquable : un nombre posé sur un lien qui mène à une page.
    try {
      const annots = await page.getAnnotations();
      const found = [];
      for (const a of annots) {
        if (a.subtype !== 'Link' || !a.dest || !a.rect) continue;
        const [ax0, ay0, ax1, ay1] = a.rect;
        const inside = items.filter(it => it.x >= ax0 - 2 && it.x <= ax1 + 2 && it.yy >= ay0 - 3 && it.yy <= ay1 + 3);
        const num = inside.map(it => it.s.match(/^(\d{1,3})\b/)).find(Boolean);
        if (num) found.push([+num[1], a.dest]);
      }
      if (found.length >= 8) for (const [v, dest] of found) if (!links[v]) links[v] = dest;
    } catch {}
    page.cleanup();
    if (onProgress && (p % 5 === 0 || p === doc.numPages)) onProgress(p / doc.numPages);
  }
  return { cands, links };
}

async function destToPage(doc, dest) {
  const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!d || !d[0]) return 0;
  return (typeof d[0] === 'number' ? d[0] : await doc.getPageIndex(d[0])) + 1;
}

// Parcourt les pages dans l'ordre en cherchant 1, 2, 3… (en tolérant
// quelques trous). Plusieurs filtres sont essayés et on garde le plus cohérent.
function sequenceFrom(cands, keep, last) {
  const map = {};
  let expected = 1, found = 0, crowded = 0;
  cands.forEach((list, i) => {
    const sel = list.filter(keep).sort((a, b) => a.y - b.y);
    const weak = new Set(sel.filter(c => !c.s).map(c => c.v));
    if (weak.size > 10) return; // page de table des matières : on l'ignore
    let here = 0;
    for (const c of sel) {
      if (c.v >= expected && c.v < expected + 6 && (!last || c.v <= last)) {
        map[c.v] = [i + 1, c.y];
        expected = c.v + 1; found++; here++;
      }
    }
    if (here > 2) crowded += here - 2;
  });
  return { map, score: found - 2 * crowded };
}
// Les numéros de page (en marge, qui suivent le numéro de la page) ne sont pas des numéros de chant.
function dropPageNumbers(cands) {
  const count = {};
  cands.forEach((list, i) => {
    for (const d of new Set(list.filter(c => !c.s && (c.y > 0.92 || c.y < 0.04)).map(c => c.v - i))) count[d] = (count[d] || 0) + 1;
  });
  const bad = new Set(Object.keys(count).filter(d => count[d] > cands.length * 0.25).map(Number));
  return cands.map((list, i) => list.filter(c => c.s || !(c.y > 0.92 || c.y < 0.04) || !bad.has(c.v - i)));
}
function detectFromText(cands, last) {
  cands = dropPageNumbers(cands);
  const strong = sequenceFrom(cands, c => c.s === 1, last);
  const filters = [];
  for (const t of [0, 1.1, 1.25, 1.5, 1.9, 2.5]) {
    filters.push(c => c.s === 1 || c.r >= t);
    filters.push(c => c.r >= t); // au cas où « n° » apparaît aussi ailleurs
  }
  let best = { map: {}, score: -1 };
  for (const f of filters) {
    const r = sequenceFrom(cands, f, last);
    if (r.score > best.score) best = r;
  }
  // Un numéro annoncé (« n° », « TN ») est bien plus sûr : on le préfère s'il couvre l'essentiel.
  if (strong.score >= best.score * 0.6) return mergeMaps(strong.map, best.map);
  return best.map;
}

// Signets du PDF (souvent présents dans les PDF « interactifs »).
async function detectFromOutline(doc) {
  const map = {};
  let outline;
  try { outline = await doc.getOutline(); } catch { return map; }
  if (!outline) return map;
  const walk = async items => {
    for (const it of items) {
      const m = (it.title || '').trim().match(/^\D{0,20}?(\d{1,3})(?!\d)/);
      if (m && it.dest && !map[+m[1]]) {
        try { const p = await destToPage(doc, it.dest); if (p) map[+m[1]] = [p, 0]; } catch {}
      }
      if (it.items && it.items.length) await walk(it.items);
    }
  };
  await walk(outline);
  return map;
}

async function detectFromLinks(doc, links) {
  const map = {};
  for (const [v, dest] of Object.entries(links || {})) {
    try { const p = await destToPage(doc, dest); if (p) map[+v] = [p, 0]; } catch {}
  }
  return map;
}

// Complète une table avec une autre, seulement si la page reste dans l'ordre.
function mergeMaps(main, extra) {
  const out = { ...main };
  const keys = () => Object.keys(out).map(Number).sort((a, b) => a - b);
  for (const n of Object.keys(extra).map(Number).sort((a, b) => a - b)) {
    if (out[n]) continue;
    const ks = keys();
    const prev = ks.filter(k => k < n).pop();
    const next = ks.find(k => k > n);
    const p = extra[n][0];
    if ((prev === undefined || out[prev][0] <= p) && (next === undefined || p <= out[next][0])) out[n] = extra[n];
  }
  return out;
}

// Garde la plus longue suite de numéros dont les pages vont croissant
// (élimine les liens ou signets qui pointeraient de travers).
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

async function detect(id, onProgress) {
  const b = books[id];
  const doc = await getDoc(id);
  if (!b.cands || b.scanVer !== SCAN_VER) {
    const r = await scanPages(doc, onProgress);
    b.cands = r.cands; b.links = r.links; b.scanVer = SCAN_VER;
  }
  const last = b.last || 0;
  const sources = [
    ['signets', monotonic(await detectFromOutline(doc))],
    ['liens', monotonic(await detectFromLinks(doc, b.links))],
    ['texte', detectFromText(b.cands, last)],
  ].map(([name, m]) => {
    if (last) for (const k of Object.keys(m)) if (+k > last) delete m[k];
    return [name, m];
  }).sort((a, c) => Object.keys(c[1]).length - Object.keys(a[1]).length);
  let map = sources[0][1];
  for (const [, m] of sources.slice(1)) map = mergeMaps(map, m);
  const text = sources.find(([n]) => n === 'texte')[1];
  for (const k of Object.keys(map)) if (text[k] && text[k][0] === map[k][0]) map[k] = text[k];
  b.source = sources.filter(([, m]) => Object.keys(m).length).map(([n]) => n).join(' + ') || 'rien';
  b.map = map;
  b.pages = doc.numPages;
  await db.putMeta(b);
}

/* ---------- Plage de pages d'une partition ---------- */
function nums(b) { return Object.keys(b.map || {}).map(Number).sort((a, c) => a - c); }
function maxNum(b) { return b.last || (nums(b).pop() || 0); }
function missing(b) {
  const out = [];
  for (let n = 1; n <= maxNum(b); n++) if (!b.map[n]) out.push(n);
  return out;
}
function rangeFor(b, n) {
  const ks = nums(b);
  const nextK = ks.find(k => k > n);
  const next = nextK !== undefined ? b.map[nextK] : null;
  if (b.map[n]) {
    const start = b.map[n][0];
    let end;
    if (!next) end = Math.min(start + 3, b.pages);
    else if (next[0] <= start) end = start;
    else end = next[1] > 0.3 ? next[0] : next[0] - 1; // la suivante commence en bas de page
    return { start, end: Math.max(start, end), exact: true };
  }
  const prevK = ks.filter(k => k < n).pop();
  const start = prevK !== undefined ? b.map[prevK][0] : 1;
  const end = next ? next[0] : Math.min(start + 4, b.pages);
  return { start, end: Math.min(end, start + 12), exact: false };
}

/* ---------- Accueil ---------- */
let current = store.get('book', 1);
let typed = '';

function bookLabel(id) { return (books[id] && books[id].name) || `Recueil ${id}`; }

function renderBooks() {
  const box = $('#books');
  box.innerHTML = '';
  for (const id of SLOTS) {
    const b = books[id];
    const meta = b ? `n° 1 à ${maxNum(b)} · ${b.pages} pages` : 'Aucun PDF : touchez pour en importer un';
    box.append(el('button', {
      class: 'book' + (current === id ? ' selected' : '') + (b ? '' : ' empty'),
      onclick: () => {
        if (!b) return showScreen('settings');
        current = id; store.set('book', id); renderBooks(); updateHint();
      }
    }, el('span', { class: 'name' }, bookLabel(id)), el('span', { class: 'meta' }, meta)));
  }
}

function updateHint() {
  $('#num').textContent = typed || ' ';
  const b = books[current];
  const n = +typed;
  let hint = ' ';
  if (!b) hint = 'Importez d’abord ce recueil';
  else if (typed && n > maxNum(b)) hint = `Le ${bookLabel(current)} va jusqu’au n° ${maxNum(b)}`;
  else if (typed && b.map[n]) hint = `${bookLabel(current)} · page ${b.map[n][0]}`;
  else if (typed) hint = `${bookLabel(current)} · emplacement approximatif`;
  $('#hint').textContent = hint;
  $('#btn-open').disabled = !b || !n || n > maxNum(b);
}

function press(k) {
  if (k === 'C') typed = '';
  else if (k === 'B') typed = typed.slice(0, -1);
  else if (typed.length < 3) typed = (typed + k).replace(/^0+/, '');
  updateHint();
}

/* ---------- Visionneuse ---------- */
let view = { id: 0, n: 0, fixing: false, token: 0 };
let fit = store.get('fit', 'width');

async function openScore(id, n) {
  const b = books[id];
  if (!b || n < 1 || n > maxNum(b)) return;
  view = { id, n, fixing: false, token: view.token + 1 };
  const token = view.token;
  showScreen('viewer');
  $('#v-title').textContent = `${bookLabel(id)} · n° ${n}`;
  $('#btn-fit').textContent = fit === 'width' ? 'Page entière' : 'Pleine largeur';
  $('#btn-fix').textContent = 'Corriger';
  const r = rangeFor(b, n);
  const warn = $('#v-warn');
  warn.classList.toggle('hidden', r.exact);
  if (!r.exact) warn.textContent = `Le n° ${n} n’a pas été repéré automatiquement. Voici les pages où il devrait se trouver : touchez « Corriger » puis la page où il commence.`;
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
    const div = el('div', { class: 'page', 'data-page': p }, canvas, el('span', { class: 'tag' }, `p. ${p}`));
    div.style.width = cssW + 'px'; div.style.height = cssH + 'px';
    div.addEventListener('click', () => fixHere(p));
    box.append(div);
    // Si la partition commence plus bas sur la page, on descend jusqu'à elle.
    const y = r.exact && p === r.start ? b.map[n][1] : 0;
    if (y > 0.3) box.scrollTop = div.offsetTop - box.offsetTop + (y - 0.06) * cssH;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
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
  const b = books[view.id];
  b.map[view.n] = [p, 0];
  await db.putMeta(b);
  openScore(view.id, view.n);
}

/* ---------- Réglages ---------- */
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
    const buf = await file.arrayBuffer();
    await db.putFile(id, buf);
    delete docs[id];
    const old = books[id];
    books[id] = { id, name: (old && old.name) || file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '), fileName: file.name, map: {}, last: old ? old.last : 0 };
    await detect(id, f => busy('Recherche des numéros…', f));
  } catch (e) {
    alert('Import impossible : ' + e.message);
  } finally {
    busy(false); renderSettings(); renderBooks(); updateHint();
  }
}

async function redetect(id) {
  try { busy('Recherche des numéros…', 0); await detect(id, f => busy('Recherche des numéros…', f)); }
  catch (e) { alert('Erreur : ' + e.message); }
  finally { busy(false); renderSettings(); renderBooks(); }
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

function renderSettings() {
  const body = $('#settings-body');
  body.innerHTML = '';
  body.append(el('div', { class: 's-card' },
    el('div', { class: 'status' }, standalone()
      ? 'Les PDF importés restent enregistrés sur cet iPad : pas besoin de les réimporter.'
      : 'Importez les PDF depuis l’appli installée sur l’écran d’accueil (pas depuis un onglet Safari) : c’est là qu’ils restent enregistrés.')));
  for (const id of SLOTS) {
    const b = books[id];
    const fileIn = el('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'hidden' });
    fileIn.addEventListener('change', () => fileIn.files[0] && importPdf(id, fileIn.files[0]));
    const card = el('div', { class: 's-card' }, el('h3', {}, `Recueil ${id}`));
    if (!b) {
      card.append(el('div', { class: 'status' }, 'Aucun PDF importé.'),
        el('div', { class: 's-row' }, el('button', { class: 'btn main', onclick: () => fileIn.click() }, 'Importer le PDF…'), fileIn));
      body.append(card);
      continue;
    }
    const name = el('input', { type: 'text', value: b.name || '' });
    name.addEventListener('change', async () => { b.name = name.value.trim(); await db.putMeta(b); renderBooks(); });
    const last = el('input', { type: 'number', min: '1', max: '999', value: b.last || '', placeholder: 'auto' });
    last.addEventListener('change', async () => { b.last = +last.value || 0; await redetect(id); });
    const miss = missing(b);
    const found = nums(b).length;
    const jsonIn = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
    jsonIn.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await jsonIn.files[0].text());
        const map = {};
        for (const [k, v] of Object.entries(data.map || data)) map[+k] = Array.isArray(v) ? v : [+v, 0];
        b.map = map; b.source = 'table importée';
        if (data.last) b.last = data.last;
        await db.putMeta(b); renderSettings(); renderBooks();
      } catch (e) { alert('Fichier de table invalide : ' + e.message); }
    });
    card.append(
      el('div', { class: 's-row' }, name),
      el('div', { class: 'status' }, `${b.fileName} · ${b.pages} pages · ${found} numéros repérés (via ${b.source || '?'})`),
      el('div', { class: 'missing' }, miss.length
        ? `Non repérés (${miss.length}) : ${miss.slice(0, 60).join(', ')}${miss.length > 60 ? '…' : ''}. Ils s’ouvrent quand même à l’emplacement approximatif, et vous pouvez les corriger depuis la partition.`
        : 'Tous les numéros ont été repérés ✓'),
      el('div', { class: 's-row' }, el('span', {}, 'Dernier numéro du recueil :'), last),
      el('div', { class: 's-row' },
        el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Remplacer le PDF…'), fileIn,
        el('button', { class: 'btn', onclick: () => redetect(id) }, 'Relancer la détection'),
        el('button', { class: 'btn', onclick: () => download(`table-recueil-${id}.json`, JSON.stringify({ name: b.name, last: b.last, map: b.map })) }, 'Exporter la table'),
        el('button', { class: 'btn', onclick: () => jsonIn.click() }, 'Importer une table…'), jsonIn,
        el('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`Supprimer « ${bookLabel(id)} » de cet appareil ?`)) return;
          await db.delMeta(id); await db.delFile(id); delete books[id]; delete docs[id];
          renderSettings(); renderBooks(); updateHint();
        } }, 'Supprimer'))
    );
    body.append(card);
  }
}

/* ---------- Navigation ---------- */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === name));
  if (name === 'settings') renderSettings();
  if (name === 'home') { renderBooks(); updateHint(); }
}

function wire() {
  document.querySelectorAll('.keypad button').forEach(b => b.addEventListener('click', () => press(b.dataset.k)));
  $('#btn-open').addEventListener('click', () => openScore(current, +typed));
  $('#btn-settings').addEventListener('click', () => showScreen('settings'));
  $('#btn-settings-back').addEventListener('click', () => showScreen('home'));
  $('#btn-back').addEventListener('click', () => { typed = ''; showScreen('home'); });
  $('#btn-prev').addEventListener('click', () => openScore(view.id, view.n - 1));
  $('#btn-next').addEventListener('click', () => openScore(view.id, view.n + 1));
  $('#btn-fit').addEventListener('click', () => { fit = fit === 'width' ? 'page' : 'width'; store.set('fit', fit); openScore(view.id, view.n); });
  $('#btn-fix').addEventListener('click', toggleFix);
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
  try { if (navigator.storage && navigator.storage.persist) persisted = await navigator.storage.persist(); } catch {}
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await loadBooks();
  // Après une mise à jour de l'appli, on relance la détection sur les PDF déjà importés.
  for (const id of SLOTS) {
    const b = books[id];
    if (b && b.scanVer !== SCAN_VER) {
      try { await detect(id, f => busy(`Mise à jour de « ${bookLabel(id)} »…`, f)); } catch {}
    }
  }
  busy(false);
  if (!books[current]) current = SLOTS.find(i => books[i]) || 1;
  showScreen('home');
})();
