// 1. ui is alive?
VECK.snapshot()
// → { uiMounted: true, uiOpen: true, canvasEntities: ~10-100, ... }

// 2. has the game rendered entities to hook?
VECK.screenArcs.length   // > 0 means the canvas hook is live

// 3. is the game WebGL (arc hook dead) or 2D (arc hook live)?
document.querySelector('canvas:not(#__veck_overlay)').getContext('webgl')
// null → 2D → ESP works. object → WebGL → rely on VECK.netEntities.

// 4. is there WASM?
VECK.wasm.memory ? VECK.wasm.memory.buffer.byteLength : 0
// >0 → scanner is available
VECK.scanner.scan('i32', 100)   // "100" = whatever your HP reads in the HUD
VECK.scanner.refine('i32', 87)  // after taking damage
VECK.scanner.write('i32', hits[0].addr, 9999)

// 5. wire a custom WS parser if the generic walker missed fields
VECK.hooks.onPacket = (msg) => { /* inspect msg */ };
VECK.dumpWsLog()