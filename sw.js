// Met en cache l'appli pour qu'elle fonctionne hors ligne.
const CACHE = 'partitions-v16';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'data/tables.json',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' contourne le cache HTTP du navigateur, sinon une mise à jour peut reprendre d'anciens fichiers.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
