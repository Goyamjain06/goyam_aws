// Bump CACHE on each deploy: activate deletes every other cache, so old files cannot linger.
const CACHE = 'rideclean-v1'
const PRECACHE = ['/index.html', '/data/delhi_aq.json', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

async function cacheFirst(req) {
  const c = await caches.open(CACHE)
  const hit = await c.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) c.put(req, res.clone())
  return res
}

// Pages are network-first so a new deploy shows up on the next load. Offline, every route gets the cached shell.
async function page(req) {
  const c = await caches.open(CACHE)
  try {
    const res = await fetch(req)
    if (res.ok && res.headers.get('content-type')?.includes('text/html')) c.put('/index.html', res.clone())
    return res
  } catch {
    return (await c.match('/index.html')) || Response.error()
  }
}

self.addEventListener('fetch', e => {
  const req = e.request
  const url = new URL(req.url)
  // Only same-origin GETs are handled. API calls (/ask, /speak, /live, other origins) go straight to the network
  // and are never cached; the app has its own on-device fallback when they fail.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (/^\/(ask|speak|live)(\/|$)/.test(url.pathname)) return
  if (req.mode === 'navigate') e.respondWith(page(req))
  else if (url.pathname === '/sw.js') return
  else e.respondWith(cacheFirst(req))
})
