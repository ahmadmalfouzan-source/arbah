/* Service Worker — حصّالة اليوم (v7)
   التنقلات: الشبكة أولًا (قرار واعٍ موثق — لا نعرض HTML قديمًا أبدًا)،
   ثم الكاش، ثم صفحة الأوفلاين الاحتياطية.
   ملفات الموقع: الكاش أولًا | الخطوط الخارجية: stale-while-revalidate
   قاعدة صارمة: لا يُخزَّن أي رد شبكة غير ناجح (فحص res.ok قبل كل put) */
const CACHE = 'arbah-v8';
const CORE = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './fonts/cairo-600-arabic.woff2',
  './fonts/cairo-600-latin.woff2',
  './fonts/cairo-700-arabic.woff2',
  './fonts/cairo-700-latin.woff2',
  './fonts/cairo-800-arabic.woff2',
  './fonts/cairo-800-latin.woff2',
  './fonts/plexmono-600-latin.woff2',
  './fonts/plexmono-700-latin.woff2'
];

/* put آمن: يخزّن فقط الردود الناجحة، والفشل صامت ولا يُسقط شيئًا */
function putIfOk(cache, req, res) {
  if (!res || !res.ok) return Promise.resolve(false);
  return cache.put(req, res.clone()).then(
    function () { return true; },
    function () { return false; }
  );
}

var CORE_URLS = null;
function coreUrls() {
  if (!CORE_URLS) CORE_URLS = CORE.map(function (u) { return new URL(u, self.location.href).href; });
  return CORE_URLS;
}

/* P2-1: سقف 30 مدخلًا تشغيليًا (LRU مبسّط — الأقدم أولًا) — مدخلات CORE مستثناة دائمًا */
function trimOp(cache) {
  try {
    cache.keys().then(function (keys) {
      var cu = coreUrls();
      var op = keys.filter(function (r) { return cu.indexOf(r.url) < 0; });
      var ex = op.length - 30;
      if (ex <= 0) return;
      Promise.all(
        op.slice(0, ex).map(function (r) { return cache.delete(r).catch(function () {}); })
      ).catch(function () {});
    }).catch(function () {});
  } catch (e) {}
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) =>
        /* ملف فاشل واحد لا يُفشل التثبيت كله */
        Promise.all(CORE.map((u) => c.add(u).catch(() => null)))
          .then((results) => {
            /* U4 — بوابة تثبيت: لا skipWaiting قبل نجاح المدخلين الحاسمين
               للإقلاع الأوفلاين (./index.html + ./offline.html) على الأقل.
               فشل أحدهما = رفض waitUntil ← يبقى العامل القديم مسيطرًا. */
            var ok = results.every(function (r, i) {
              return r !== null || (CORE[i] !== './index.html' && CORE[i] !== './offline.html');
            });
            if (!ok) throw new Error('core-critical-missing');
            return c;
          })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  /* U5: سلسلة التنظيف/التحقق محمية — فشلها لا يمنع السيطرة */
  e.waitUntil(
    (async function () {
      try {
        const keys = await caches.keys();
        /* V1: حذف الكاشات القديمة للتطبيق فقط (بادئة arbah-) — لا نلمس
           كاشات أي تطبيق شقيق على نفس الـorigin المشترك (github.io) */
        await Promise.all(keys.filter((k) => k !== CACHE && k.indexOf('arbah-') === 0).map((k) => caches.delete(k)));
        /* تحقق خلفي من CORE: إعادة جلب كل مدخل، والاستبدال فقط عند res.ok.
           الفشل هنا صامت ولا يُسقط التفعيل — يحمي من «كاش قديم عالق». */
        const c = await caches.open(CACHE);
        await Promise.all(
          CORE.map((u) =>
            fetch(new Request(u, { cache: 'reload' }))
              .then((res) => putIfOk(c, u, res))
              .catch(() => false)
          )
        );
      } catch (err) { /* فشل صامت: العامل يسيطر رغم ذلك */ }
    })()
  );
  /* U5: clients.claim() في waitUntil مستقل — فشل التنظيف لا يمنع السيطرة */
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // التنقل بين الصفحات: الشبكة أولًا ثم الكاش ثم الأوفلاين
  // (رد غير ناجح = فشل شبكة: لا يُخزَّن ولا يُقدَّم — fallback للكاش ثم offline.html)
  // P2-2: cache:'no-store' يتجاوز كاش HTTP المتصفح — تبقى network-first كما هي
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(e.request, { cache: 'no-store' }))
        .then((res) => {
          if (!res || !res.ok) throw new Error('bad-response');
          caches.open(CACHE).then((c) => putIfOk(c, './index.html', res));
          return res;
        })
        .catch(() =>
          caches.match('./index.html').then(
            /* O2: أي hit غير-200 (تسميم تاريخي) يُتجاوز إلى offline.html */
            (hit) => (hit && hit.ok) ? hit : caches.match('./offline.html')
          )
        )
    );
    return;
  }

  // ملفات نفس الموقع: الكاش أولًا (تخزين الشبكة فقط عند res.ok)
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (!res || !res.ok) return res;
            caches.open(CACHE).then((c) => putIfOk(c, e.request, res).then(function (ok) { if (ok) trimOp(c); }));
            return res;
          })
      )
    );
    return;
  }

  // خارجي (خطوط قوقل): stale-while-revalidate (تخزين الشبكة فقط عند res.ok)
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => putIfOk(c, e.request, res).then(function (ok) { if (ok) trimOp(c); }));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
