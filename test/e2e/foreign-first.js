'use strict'
// Prepended to background.scripts by test/e2e/run.mjs, never shipped. A
// proxy.onRequest listener registered before Bulkhead's stands in for
// another extension that loaded first: Firefox hands its answer to the next
// listener as the default, and keeps it as the failover behind whatever
// that listener returns unless the list is ended. Off until the selftest
// names a container.

/* global TEST_FOREIGN_PORT */

/** @type {Set<string>} */
globalThis.testForeignFirst = new Set()

browser.proxy.onRequest.addListener((d) => {
  if (!d.cookieStoreId || !globalThis.testForeignFirst.has(d.cookieStoreId)) return undefined
  return { type: 'socks', host: '127.0.0.1', port: TEST_FOREIGN_PORT, proxyDNS: true, failoverTimeout: 1 }
}, { urls: ['<all_urls>'] })
