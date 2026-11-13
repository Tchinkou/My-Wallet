/**
 * My Wallet — Service Worker.
 * Met en cache tous les fichiers de l'application au premier chargement
 * puis sert depuis le cache : l'application fonctionne sans Internet.
 * Aucune donnée financière ne transite ici : elles restent dans IndexedDB.
 * Pensez à incrémenter VERSION à chaque déploiement.
 *
 * Note Cloudflare Pages : /index.html est redirigé (308) vers /. On ne met
 * donc en cache que « ./ », et toute réponse redirigée est recopiée sans son
 * statut de redirection (Chrome refuse de servir une réponse redirigée à une
 * navigation : erreur ERR_FAILED).
 */
const VERSION = 'mywallet-v1.1.0';
const SHELL = './';
const ASSETS = [
  SHELL,
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/backup.js',
  './js/calculations.js',
  './js/charts.js',
  './js/database.js',
  './js/security.js',
  './js/ui.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
];

/** Recopie une réponse redirigée en réponse « propre » utilisable partout. */
async function clean(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(ASSETS.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`Échec du cache : ${url}`);
      await cache.put(url, await clean(res));
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // jamais de requête tierce

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(SHELL);
      if (hit) return hit;
      try {
        return await clean(await fetch(req));
      } catch {
        return new Response('<h1>My Wallet</h1><p>Hors ligne : ouvrez l’application une fois avec Internet.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic' && !res.redirected) cache.put(req, res.clone());
    return res;
  })());
});
