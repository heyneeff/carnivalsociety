// The raven on your phone. Pushes arrive with no payload; this worker wakes,
// asks the members app what's waiting, and squawks it as a notification.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let list = [];
    try {
      const res = await fetch('/api/me/notifications/pending', { credentials: 'include', cache: 'no-store' });
      if (res.ok) list = (await res.json()).notifications || [];
    } catch (e) { /* offline: fall through to the generic squawk */ }
    if (!list.length) list = [{ id: 'generic', title: 'SQUAWK!', body: 'Something is waiting for you in your Dressing Room.', url: '#/dressing-room' }];
    await Promise.all(list.slice(0, 3).map(n => self.registration.showNotification(n.title, {
      body: n.body || '',
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/badge-96.png',
      tag: `csi-${n.id}`,
      data: { url: '/?n=1' + (n.url || '#/dressing-room') },
    })));
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(target); }
    }
    return self.clients.openWindow(target);
  })());
});
