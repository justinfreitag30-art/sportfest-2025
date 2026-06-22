self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Sportfest 2025', body: 'Neues Update!', url: '/' };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    try {
      payload = JSON.parse(event.data.text());
    } catch (e2) { /* use defaults */ }
  }

  const options = {
    body: payload.body || 'Neues Update!',
    data: { url: payload.url || '/' },
    vibrate: [200, 100, 200],
    tag: 'sportfest-match',
    renotify: true,
    requireInteraction: false
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Sportfest 2025', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
