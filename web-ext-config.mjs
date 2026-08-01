import { readFileSync } from 'node:fs'

// Project-local Firefox Developer Edition, fetched by `npm run setup`. When
// setup hasn't run, web-ext falls back to whatever Firefox it finds itself.
let firefox
try {
  firefox = JSON.parse(
    readFileSync(new URL('./.cache/firefox/current.json', import.meta.url), 'utf8')
  ).binary
} catch {
  // no local browser yet
}

const run = {
  startUrl: ['about:debugging#/runtime/this-firefox'],
  pref: [
    'browser.dom.window.dump.enabled=true',
    'devtools.console.stdout.chrome=true',
    // the two prefs the extension itself cannot set; the temp profile gets
    // them so development always happens in the safe configuration
    'network.proxy.failover_direct=false',
    'network.trr.mode=5'
  ]
  // Never add keepProfileChanges here. A reused profile caches the permission
  // grant set for the extension id, so a permission added to the manifest
  // later stays silently ungranted (browser.privacy === undefined and
  // friends). Fresh temp profiles per run are the point.
}
if (firefox) run.firefox = firefox

export default {
  sourceDir: 'src',
  artifactsDir: 'dist',
  run,
  build: {
    overwriteDest: true
  }
}
