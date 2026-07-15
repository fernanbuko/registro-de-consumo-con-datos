// Service Worker de "Registro de Consumo Eléctrico"
// Debe publicarse en la MISMA carpeta que el archivo .html principal.
// Guarda una copia de la app para que abra sin internet una vez instalada/visitada.

const CACHE_NAME = 'registro-consumo-v2';
const ARCHIVOS_A_GUARDAR = [
  './',
  './index.html',
  './registro_consumo_electrico.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ARCHIVOS_A_GUARDAR.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Estrategia "network first, cache fallback": intenta traer la versión más
// nueva de internet; si no hay conexión, usa la copia guardada.
// Importante: solo se mete con archivos de esta misma app (mismo origen, tipo GET).
// Las llamadas a Firebase (login, guardar datos en la nube) son de otro origen y
// no se deben guardar en caché — se dejan pasar sin tocar.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const esMismoOrigen = url.origin === self.location.origin;
  const esGet = event.request.method === 'GET';
  if(!esMismoOrigen || !esGet){
    return; // no se intercepta: Firebase y cualquier otra llamada externa siguen su curso normal
  }
  event.respondWith(
    fetch(event.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(event.request))
  );
});
