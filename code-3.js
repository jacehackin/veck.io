// ESP
VECK.state.esp.minRadius = 8;
VECK.state.esp.maxRadius = 30;       // hide bullets + particles
VECK.state.esp.showLabels = true;

// Aimbot
VECK.state.aimbot.enabled = true;
VECK.state.aimbot.fov = 250;
VECK.state.aimbot.smooth = 0.75;
VECK.state.aimbot.holdShift = true;  // only aim while holding SHIFT
VECK.state.aimbot.useMathHook = false;

// AutoFire
VECK.state.autofire.enabled = true;
VECK.state.autofire.rate = 80;       // ms between shots
VECK.state.autofire.range = 300;

// Speed
VECK.state.speed.enabled = true;
VECK.state.speed.multiplier = 3;
VECK.state.speed.mode = 'auto';      // auto | wasm | object | ws
VECK.state.speed.wasmAddr = 0;       // set from scanner

// God Mode
VECK.state.godmode.enabled = true;
VECK.state.godmode.lockValue = 100;
VECK.state.godmode.healKey = 'h';
VECK.state.godmode.healInterval = 400;
VECK.state.godmode.mode = 'auto';    // auto | wasm | object | key