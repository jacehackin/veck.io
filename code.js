console.table({
  userscript_mounted: !!document.getElementById('__veck_host'),
  overlay_mounted:    !!document.getElementById('__veck_overlay'),
  veck_api_alive:     !!window.VECK,
  ui_handle:          !!(window.VECK && window.VECK.ui),
  shadow_support:     !!document.documentElement.attachShadow,
  tm_scripts:         (document.head.innerHTML.match(/__veck/g) || []).length
});