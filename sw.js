const CACHE_NAME = 'soberpace-cache-v35';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching app shell assets');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch network-first/cache-fallback
self.addEventListener('fetch', (event) => {
  // Avoid interception for chrome extensions or non-http protocols
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // CRITICAL: NEVER cache backend database API calls!
  if (event.request.url.includes('/api/')) {
    return;
  }
  
  // Network-first, cache-fallback: always try the network so code/style updates
  // take effect immediately; fall back to the cache only when offline. (Previously
  // this was cache-first, which made every deploy require a manual cache clear.)
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request)) // offline -> serve last cached copy
  );
});
