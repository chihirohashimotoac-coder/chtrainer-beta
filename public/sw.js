/*
 * Darts Training Analyzer - Service Worker
 * 方針:
 *  - install 時にアプリシェルをキャッシュ
 *  - 同一オリジンの GET はキャッシュ優先 + バックグラウンド更新 (stale-while-revalidate)
 *  - ナビゲーションはネットワーク失敗時に index.html へフォールバック
 *  - 新しい SW が waiting になったらクライアントへ更新可能を通知
 */
// __APP_VERSION__ はビルド時に package.json の version へ置換される
// (vite.config.ts の inject-sw-version プラグイン)。これにより新リリースごとに
// sw.js の内容が変わり、Service Worker の更新検知(updatefound)と更新バナーが
// 正しく発火する。dev では SW 未登録のためプレースホルダのままでも影響しない。
// ベータ版は本番版と同一オリジン(github.io)で公開されるため、キャッシュ名を
// 本番版のもの(接頭辞に beta を含まない名前)と必ず別名にする。同名だと
// activate 時の古いキャッシュ削除で、本番アプリのキャッシュまで消してしまう。
// 本番版の識別子はコメントにも書かない(src/beta/betaIsolation.test.ts が
// 機械的に検査するため、ここへ書き写すと検査が意味を失う)。
const CACHE_VERSION = "dta-beta-v__APP_VERSION__";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

async function cacheAppShell(cache) {
  await cache.addAll(APP_SHELL);
  const indexResponse = await fetch("./index.html", { cache: "no-cache" });
  if (!indexResponse.ok) return;

  await cache.put("./index.html", indexResponse.clone());
  const html = await indexResponse.text();
  const assetUrls = [...html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], self.location.href))
    .filter(
      (url) =>
        url.origin === self.location.origin &&
        (url.pathname.endsWith(".js") || url.pathname.endsWith(".css"))
    )
    .map((url) => url.href);

  await Promise.all(
    [...new Set(assetUrls)].map(async (url) => {
      try {
        await cache.add(url);
      } catch {
        // The shell still works with stale-while-revalidate if an optional asset is unavailable.
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cacheAppShell));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE_VERSION);
          cache.put("./index.html", response.clone());
          return response;
        } catch {
          const cached = await caches.match("./index.html");
          if (cached) return cached;
          return new Response("offline", { status: 503 });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const fetchAndCache = fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);
      if (cached) {
        fetchAndCache.catch(() => undefined);
        return cached;
      }
      const fresh = await fetchAndCache;
      if (fresh) return fresh;
      return new Response("offline", { status: 503 });
    })()
  );
});
