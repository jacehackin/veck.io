# Veck.io Trainer v3 — Un-hideable UI

Userscript for veck.io. The previous version's UI failed to appear for six
specific, now-fixed reasons — v3 mounts to `<html>` at `document-start` inside a
Shadow DOM, so the game's CSS and its SPA router cannot reach it.

## Why the v1 / v2 UI never showed up

| # | Cause | v1/v2 symptom | v3 fix |
|---|---|---|---|
| 1 | `buildUI()` ran when `document.body` was `null` (document-start) | Silent nothing, no console error | Mounts to `document.documentElement`, which exists at document-start |
| 2 | `console-probe.js` had a literal syntax error (`inst\`.exports` — stray backtick) | Whole file threw `SyntaxError`, nothing ran | Removed; parser verified line-by-line |
| 3 | `@match` missed the real host (port / subdomain / wrong domain) | Tampermonkey never injected anything | Regex `@include` + four `@match` lines |
| 4 | Game CSS or canvas stacking context hid the panel | Panel existed in DOM, invisible on screen | `:host { all: initial }` inside Shadow DOM — game CSS cannot cross the boundary |
| 5 | Game SPA router nuked the DOM mid-session | Panel flashed then disappeared | Re-mount guard every 750 ms |
| 6 | Panel rendered under the game's HUD | Invisible behind minimap | Draggable header + `VECK` pill fallback when hidden |

## Diagnose in 10 seconds

Paste this in DevTools **on the veck.io tab**:

```js
console.table({
  userscript_mounted: !!document.getElementById('__veck_host'),
  overlay_mounted:    !!document.getElementById('__veck_overlay'),
  veck_api_alive:     !!window.VECK,
  ui_handle:          !!(window.VECK && window.VECK.ui),
  shadow_support:     !!document.documentElement.attachShadow,
  boot_stages:        window.VECK ? window.VECK.boot.join(' → ') : '(VECK not loaded)'
});