// Helio G99 Control - KernelSU WebUI (v4)
const APP_VERSION = 'v4';

// ---------- KernelSU bridge ----------
// ksu.exec is synchronous: the whole page freezes while the command runs.
// ksu.spawn is asynchronous, so it is used when it works (self-tested once at start).
function execSync(command) {
  return new Promise((resolve, reject) => {
    const cb = 'exec_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    window[cb] = (errno, stdout, stderr) => {
      resolve({ errno, stdout, stderr });
      delete window[cb];
    };
    try {
      ksu.exec(command, '{}', cb);
    } catch (error) {
      reject(error);
      delete window[cb];
    }
  });
}

function spawnRaw(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cb = 'sp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const out = [];
    const err = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      delete window[cb];
      reject(new Error('Command timed out'));
    }, timeoutMs);
    window[cb] = {
      stdout: { emit: (ev, d) => { if (ev === 'data') out.push(String(d)); } },
      stderr: { emit: (ev, d) => { if (ev === 'data') err.push(String(d)); } },
      emit: (ev, d) => {
        if (ev !== 'exit' || done) return;
        done = true;
        clearTimeout(timer);
        delete window[cb];
        resolve({ code: Number(d), out, err });
      }
    };
    try {
      ksu.spawn(command, '[]', '{}', cb);
    } catch (error) {
      done = true;
      clearTimeout(timer);
      delete window[cb];
      reject(error);
    }
  });
}

let spawnMode = null;   // null = not probed yet, 'nl' / 'raw' = async spawn works, false = use ksu.exec
let probePromise = null;
function probeSpawn() {
  if (!probePromise) {
    probePromise = (async () => {
      let mode = false;
      try {
        if (typeof ksu !== 'undefined' && typeof ksu.spawn === 'function') {
          const r = await spawnRaw("printf 'a\\nb\\nc\\n'", 2500);
          if (r.code === 0 && r.out.join('\n') === 'a\nb\nc') mode = 'nl';
          else if (r.code === 0 && r.out.join('').replace(/\n+$/, '') === 'a\nb\nc') mode = 'raw';
        }
      } catch (_) { mode = false; }
      spawnMode = mode;
    })();
  }
  return probePromise;
}

async function exec(command) {
  if (spawnMode === null) await probeSpawn();
  if (!spawnMode) return execSync(command);
  const r = await spawnRaw(command, 180000);
  const join = (a) => (spawnMode === 'raw' ? a.join('') : a.join('\n'));
  return { errno: r.code, stdout: join(r.out), stderr: join(r.err) };
}

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
const setW = (id, p) => { const el = $(id); if (el) el.style.width = p + '%'; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defer = (fn) => requestAnimationFrame(() => setTimeout(fn, 40));
function setStatus(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function tick(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {} }
function safe(fn) { try { fn(); } catch (error) { console.error(error); } }

async function read(command) {
  const r = await exec(command);
  if (!r || r.errno !== 0) throw new Error((r && r.stderr) || 'Command failed');
  return String(r.stdout || '').trim();
}

// ---------- constants ----------
const MOD_DIR = '/data/adb/modules/heilog99_control';
const CPU_LOCK_STATE = MOD_DIR + '/.cpu-frequency-lock-state';
const CONF = '/data/adb/heilog99_control.conf';
const LS_KEY = 'heilog99.settings.v2';
const SNAP_KEY = 'heilog99.snapshot.v2';
const GPU_PROC = '/proc/gpufreqv2';
const GPU_SAFE_IDX = 20;            // stock working row, never touched by gpu_oc
const LITTLE_WARN = 2400;           // above this: warning + confirm tap (MHz)
const BIG_WARN = 2500;
const MAX_STEP_KHZ = 800000;        // must match MAX_STEP_KHZ in cpu_oc.c
const GPU_OPP_MHZ = [1100, 1086, 1072, 1058, 1045, 1031, 1017, 1003, 990, 976, 962, 948, 935, 921, 907, 893, 880, 868, 857, 846, 835, 823, 812, 801, 790, 778, 767, 756, 745, 733, 722, 711, 700, 674, 648, 622, 596, 570, 545, 519, 493, 467, 441, 415, 390];

const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const ghz = (khz) => (khz / 1e6).toFixed(2);
const gb1 = (kb) => (kb / 1048576).toFixed(1);
const mbText = (kb) => Math.round(kb / 1024).toLocaleString('en-US') + ' MB';

// ---------- saved settings (WebView storage + a file; the newer copy wins) ----------
const defaults = { little: 2300, big: 2500, lock: false, gpuPos: 44, gpuHeld: null, zram: '', savedAt: 0 };
let settings = { ...defaults };

function loadLocal() {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
async function loadFile() {
  try { const raw = await read('cat ' + CONF + ' 2>/dev/null'); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
function saveSettings() {
  settings.savedAt = Date.now();
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (_) {}
  read("printf '%s' '" + JSON.stringify(settings) + "' > " + CONF).catch(() => {});
}
window.addEventListener('pagehide', saveSettings);

// ---------- live state ----------
const live = { cpuActive: false, gpuHeld: false, zram: '' };
let lastMem = {};
let busy = false;
let polling = false;
let page = 'home';
let lastTouch = 0;
['pointerdown', 'pointermove', 'touchstart', 'input', 'scroll'].forEach((ev) =>
  window.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));

function gpuStateText() {
  if (!live.gpuHeld) return 'Automatic';
  return settings.gpuHeld !== null ? 'Holding ' + GPU_OPP_MHZ[settings.gpuHeld] + ' MHz' : 'Holding a manual value';
}

// ---------- polling: one small command per page ----------
const SEC = {
  cpu: 'echo @cpu; grep -H . /sys/devices/system/cpu/cpu[0-7]/cpufreq/cpuinfo_cur_freq /sys/devices/system/cpu/cpu[0-7]/cpufreq/scaling_cur_freq 2>/dev/null',
  gpu: 'echo @gpu; echo "G $(grep -m1 GPU-OPP ' + GPU_PROC + '/gpufreq_status 2>/dev/null)"; echo "D $(cat /sys/class/devfreq/13000000.mali/cur_freq 2>/dev/null)"',
  mem: "echo @mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  temp: 'echo @temp; grep -H . /sys/class/thermal/thermal_zone*/temp /sys/class/thermal/thermal_zone*/type 2>/dev/null; echo "B $(cat /sys/class/power_supply/battery/temp 2>/dev/null)"',
  state: 'echo @state; ' +
    "if grep -q '^cpu_oc ' /proc/modules || [ -f " + CPU_LOCK_STATE + " ]; then echo 'S cpu 1'; else echo 'S cpu 0'; fi; " +
    'echo "S gpu $(cat ' + GPU_PROC + '/fix_target_opp_index 2>/dev/null)"; ' +
    'echo "S zram $(cat /sys/block/zram0/comp_algorithm 2>/dev/null)"'
};
const PAGE_SECS = {
  home: ['cpu', 'gpu', 'mem', 'temp', 'state'],
  cpu: ['cpu'],
  gpu: ['gpu', 'state'],
  mem: ['mem', 'state'],
  temp: ['temp']
};
const pollCmd = (p) => PAGE_SECS[p].map((s) => SEC[s]).join('\n') + '\ntrue';

function parse(raw) {
  const d = { has: {}, cores: new Array(8).fill(0), gpuKhz: 0, gpuHz: 0, mem: {}, temps: [], state: {} };
  const info = [];
  const scal = [];
  const zone = {};
  let sec = '';
  raw.split('\n').forEach((line) => {
    if (line[0] === '@') { sec = line.slice(1).trim(); d.has[sec] = true; return; }
    let m;
    if (sec === 'cpu') {
      m = line.match(/cpu(\d+)\/cpufreq\/(cpuinfo_cur_freq|scaling_cur_freq):(\d+)/);
      if (m) (m[2] === 'cpuinfo_cur_freq' ? info : scal)[Number(m[1])] = Number(m[3]);
    } else if (sec === 'gpu') {
      m = line.match(/^G\b.*Freq:\s*(\d+)/);
      if (m) d.gpuKhz = Number(m[1]);
      m = line.match(/^D\s+(\d+)/);
      if (m) d.gpuHz = Number(m[1]);
    } else if (sec === 'mem') {
      m = line.match(/^(\w+):\s+(\d+)/);
      if (m) d.mem[m[1]] = Number(m[2]);
    } else if (sec === 'temp') {
      m = line.match(/thermal_zone(\d+)\/(temp|type):(.*)$/);
      if (m) { zone[m[1]] = zone[m[1]] || {}; zone[m[1]][m[2]] = m[3].trim(); }
      m = line.match(/^B\s+(-?\d+)/);
      if (m) {
        const c = Number(m[1]) / 10;   // battery temp is in tenths of a degree
        if (c > -20 && c < 90) d.temps.push({ name: 'battery', c });
      }
    } else if (sec === 'state') {
      m = line.match(/^S\s+(\w+)\s*(.*)$/);
      if (m) d.state[m[1]] = m[2].trim();
    }
  });
  for (let i = 0; i < 8; i++) d.cores[i] = info[i] || scal[i] || 0;
  Object.values(zone).forEach((z) => {
    const t = Number(z.temp);
    if (t > 1000 && t < 150000) d.temps.push({ name: z.type || 'sensor', c: t / 1000 });
  });
  return d;
}

function renderChips() {
  setText('c-cpu', live.cpuActive ? 'Modified' : 'Stock');
  setText('c-gpu', live.gpuHeld ? 'Held' : 'Auto');
  setText('c-zram', live.zram ? live.zram.toUpperCase() : '--');
  const a = $('chip-cpu');
  const b = $('chip-gpu');
  if (a) a.classList.toggle('on', live.cpuActive);
  if (b) b.classList.toggle('on', live.gpuHeld);
  setText('t-gpu-sub', gpuStateText());
  setText('gpu-state', gpuStateText());
}

function render(d) {
  const has = d.has || {};
  if (has.cpu) safe(() => {
    const little = Math.max(...d.cores.slice(0, 6));
    const big = Math.max(d.cores[6], d.cores[7]);
    const top = Math.max(little, big);
    setText('t-cpu', top ? ghz(top) + ' GHz' : '--');
    setText('t-cpu-sub', 'Little ' + (little ? ghz(little) : 'off') + ' · Big ' + (big ? ghz(big) : 'off'));
    d.cores.forEach((k, i) => setText('core-' + i, k ? String(Math.round(k / 1000)) : 'off'));
    document.querySelectorAll('#eq i').forEach((bar, i) => { bar.style.height = Math.max(6, pct(d.cores[i], 2600000)) + '%'; });
  });
  if (has.gpu) safe(() => {
    const mhz = d.gpuKhz ? Math.round(d.gpuKhz / 1000) : (d.gpuHz ? Math.round(d.gpuHz / 1e6) : 0);
    setText('t-gpu', mhz ? mhz + ' MHz' : '--');
    setText('gpu-live', mhz ? String(mhz) : '--');
    setW('bar-gpu', pct(mhz, 1100));
  });
  if (has.mem && d.mem.MemTotal) safe(() => {
    lastMem = d.mem;
    const total = d.mem.MemTotal;
    const avail = d.mem.MemAvailable || 0;
    const used = Math.max(0, total - avail);
    setText('t-mem', gb1(used) + ' GB');
    setText('t-mem-sub', 'of ' + gb1(total) + ' GB · ' + Math.round(pct(used, total)) + '% used');
    setW('bar-mem', pct(used, total));
    setText('m-used', gb1(used));
    setText('m-of', 'of ' + gb1(total) + ' GB');
    const ring = $('ring-ram');
    if (ring) ring.style.setProperty('--p', pct(used, total).toFixed(1));
    setText('m-avail', gb1(avail) + ' GB');
    setText('m-total', gb1(total) + ' GB');
    const swapTotal = d.mem.SwapTotal || 0;
    const swapUsed = Math.max(0, swapTotal - (d.mem.SwapFree || 0));
    setText('z-used', swapTotal ? gb1(swapUsed) + ' GB' : 'none');
    setText('z-of', swapTotal ? 'of ' + gb1(swapTotal) + ' GB' : '');
    setW('bar-zram', pct(swapUsed, swapTotal));
    updateZramUi();
  });
  if (has.temp) safe(() => {
    const best = {};
    d.temps.forEach((t) => { if (!(t.name in best) || t.c > best[t.name]) best[t.name] = t.c; });
    const list = Object.entries(best).sort((a, b) => b[1] - a[1]);
    if (!list.length) return;
    setText('t-temp', list[0][1].toFixed(1) + ' °C');
    setText('temp-hot', list[0][1].toFixed(1));
    setW('bar-temp', pct(list[0][1], 90));
    const box = $('temp-list');
    if (!box) return;
    box.textContent = '';
    list.slice(0, 8).forEach(([name, c]) => {
      const row = document.createElement('div');
      row.className = 'row';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = name;
      const v = document.createElement('span');
      v.textContent = c.toFixed(1) + ' °C';
      row.append(k, v);
      box.append(row);
    });
  });
  if (has.state) safe(() => {
    live.cpuActive = d.state.cpu === '1';
    const g = d.state.gpu || '';
    live.gpuHeld = g !== '' && !/disabled/i.test(g);
    if (!live.gpuHeld && settings.gpuHeld !== null) { settings.gpuHeld = null; saveSettings(); }
    const z = (d.state.zram || '').match(/\[([^\]]+)\]/);
    if (z) live.zram = z[1];
    renderChips();
  });
}

async function poll(force) {
  if (polling || busy || document.hidden) return;
  if (!force && Date.now() - lastTouch < 900) return;   // never compete with a finger on the screen
  polling = true;
  try {
    const d = parse(await read(pollCmd(page)));
    render(d);
    $('dot').className = 'dot ok';
    $('err').hidden = true;
    if (page === 'home' && Date.now() - (poll.lastSnap || 0) > 4000) {
      poll.lastSnap = Date.now();
      try { localStorage.setItem(SNAP_KEY, JSON.stringify(d)); } catch (_) {}
    }
  } catch (error) {
    $('dot').className = 'dot bad';
    $('err').hidden = false;
    $('err').textContent = 'KernelSU unavailable: ' + (error && error.message ? error.message : 'unknown error');
  } finally {
    polling = false;
  }
}

let loopOn = false;
let loopTimer = null;
async function loopTick() {
  if (!loopOn) return;
  await poll(false);
  if (loopOn) loopTimer = setTimeout(loopTick, page === 'home' ? 3000 : 1500);
}
function startLoop() { if (loopOn) return; loopOn = true; loopTick(); }
function stopLoop() { loopOn = false; clearTimeout(loopTimer); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); saveSettings(); } else { startLoop(); }
});

// ---------- navigation ----------
function go(name) {
  page = name;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  window.scrollTo(0, 0);
  tick(8);
  defer(() => {
    if (!busy) {
      if (name === 'cpu') syncCpu();
      if (name === 'gpu') syncGpu();
      if (name === 'mem') syncZram();
    }
    poll(true);
  });
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ---------- generic action runner ----------
function flash(el, ok) {
  const cls = ok ? 'flash-ok' : 'flash-bad';
  el.classList.remove('flash-ok', 'flash-bad');
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 800);
}
async function runAction(o) {
  if (busy) return;
  busy = true;
  tick(10);
  o.buttons.forEach((id) => { $(id).disabled = true; });
  const pressed = $(o.press);
  pressed.classList.add('loading');
  setStatus(o.status, o.working, '');
  let ok = false;
  try {
    await o.fn();
    setStatus(o.status, o.done, 'ok');
    ok = true;
  } catch (error) {
    setStatus(o.status, 'Failed: ' + (error && error.message ? error.message : 'unknown error'), 'bad');
  } finally {
    try { if (o.after) await o.after(); } catch (_) {}
    pressed.classList.remove('loading');
    o.buttons.forEach((id) => { $(id).disabled = false; });
    flash(pressed, ok);
    tick(ok ? 20 : [40, 50, 40]);
    busy = false;
    poll(true);
  }
}

async function moduleLoaded(name) {
  return (await read("grep -q '^" + name + " ' /proc/modules && echo yes || echo no")) === 'yes';
}
async function ensureLoaderExecutable() {
  const path = MOD_DIR + '/loader';
  const r = await exec('chmod 0755 ' + path + ' && test -x ' + path);
  if (!r || r.errno !== 0) throw new Error((r && r.stderr) || 'Could not make the loader executable');
}

// Sliders: only the label changes while dragging; saving happens on release.
function bindSlider(id, onInput, onChange) {
  const el = $(id);
  let raf = 0;
  el.addEventListener('input', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; onInput(); });
  });
  el.addEventListener('change', () => { onInput(); onChange(); });
}

// ---------- CPU ----------
const P0 = '/sys/devices/system/cpu/cpufreq/policy0';
const P6 = '/sys/devices/system/cpu/cpufreq/policy6';
let cpuArmed = false;
let cpuArmTimer = null;

function disarmCpu() {
  cpuArmed = false;
  clearTimeout(cpuArmTimer);
  const b = $('cpu-apply');
  b.textContent = 'Apply';
  b.classList.remove('armed');
}
function updateCpuLabels() {
  const l = Number($('little-slider').value);
  const b = Number($('big-slider').value);
  setText('little-val', l + ' MHz');
  setText('big-val', b + ' MHz');
  const lw = $('little-warn');
  const bw = $('big-warn');
  lw.hidden = l <= LITTLE_WARN;
  bw.hidden = b <= BIG_WARN;
  lw.textContent = 'Above ' + LITTLE_WARN + ' MHz: not verified safe. The phone may freeze or reboot.';
  bw.textContent = 'Above ' + BIG_WARN + ' MHz: not verified safe. The phone may freeze or reboot.';
}
function fillCpuUi() {
  $('little-slider').value = settings.little;
  $('big-slider').value = settings.big;
  $('cpu-lock').checked = !!settings.lock;
  updateCpuLabels();
}
bindSlider('little-slider',
  () => { settings.little = Number($('little-slider').value); updateCpuLabels(); disarmCpu(); },
  saveSettings);
bindSlider('big-slider',
  () => { settings.big = Number($('big-slider').value); updateCpuLabels(); disarmCpu(); },
  saveSettings);
$('cpu-lock').addEventListener('change', () => { settings.lock = $('cpu-lock').checked; saveSettings(); });

async function cpuActive() {
  return (await read("if grep -q '^cpu_oc ' /proc/modules || [ -f " + CPU_LOCK_STATE + " ]; then echo yes; else echo no; fi")) === 'yes';
}

// When CPU control is active, show what is really applied; otherwise show the saved choice.
async function syncCpu() {
  try {
    live.cpuActive = await cpuActive();
    if (live.cpuActive) {
      const raw = await read('for p in ' + P0 + ' ' + P6 + '; do echo "$(cat $p/scaling_min_freq) $(cat $p/scaling_max_freq)"; done');
      const rows = raw.split('\n').map((l) => l.trim().split(' ').map(Number));
      if (rows.length === 2 && rows.every((r) => r.length === 2 && r.every(Number.isFinite))) {
        settings.little = Math.round(rows[0][1] / 1000);
        settings.big = Math.round(rows[1][1] / 1000);
        settings.lock = rows[0][0] === rows[0][1] && rows[1][0] === rows[1][1];
        saveSettings();
      }
    }
  } catch (_) {}
  fillCpuUi();
  renderChips();
}

async function getStockCpuLimits() {
  const raw = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s:%s:%s\\n' \"$n\" \"$(cat $p/cpuinfo_min_freq)\" \"$(cat $p/cpuinfo_max_freq)\"; done");
  const v = {};
  raw.split(/\r?\n/).filter(Boolean).forEach((line) => {
    const [name, min, max] = line.split(':');
    v[name] = { min: Number(min), max: Number(max) };
  });
  if (!v.policy0 || !v.policy6 || ![v.policy0.min, v.policy0.max, v.policy6.min, v.policy6.max].every(Number.isFinite)) {
    throw new Error('Could not read the CPU frequency limits');
  }
  return v;
}

async function saveCpuFrequencyState() {
  const state = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s\\n' \"$(cat $p/scaling_min_freq)\" \"$(cat $p/scaling_max_freq)\"; done");
  const values = state.split(/\r?\n/).map(Number);
  if (values.length !== 4 || values.some((x) => !Number.isInteger(x) || x <= 0)) {
    throw new Error('Could not save the original CPU limits');
  }
  await read("printf '%s\\n' " + values.join(' ') + ' > ' + CPU_LOCK_STATE);
}

async function applyCpuFrequencies(littleKhz, bigKhz, locking) {
  await read('echo ' + littleKhz + ' > ' + P0 + '/scaling_max_freq && echo ' + bigKhz + ' > ' + P6 + '/scaling_max_freq');
  if (locking) {
    await read('echo ' + littleKhz + ' > ' + P0 + '/scaling_min_freq && echo ' + bigKhz + ' > ' + P6 + '/scaling_min_freq');
  }
  const check = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s\\n' \"$(cat $p/scaling_min_freq)\" \"$(cat $p/scaling_max_freq)\"; done");
  const v = check.split(/\r?\n/).map(Number);
  if (v.length !== 4 || v[1] !== littleKhz || v[3] !== bigKhz || (locking && (v[0] !== littleKhz || v[2] !== bigKhz))) {
    throw new Error('The kernel did not accept the selected frequencies');
  }
}

// Order matters: drop the minimum lock, unload the module (the stock table comes back),
// then restore the real stock maximums.
async function unloadCpuModule() {
  const before = await getStockCpuLimits();
  await read('echo ' + before.policy0.min + ' > ' + P0 + '/scaling_min_freq && echo ' + before.policy6.min + ' > ' + P6 + '/scaling_min_freq');
  if (await moduleLoaded('cpu_oc')) {
    await ensureLoaderExecutable();
    const r = await exec(MOD_DIR + '/loader -r cpu_oc');
    if (!r || r.errno !== 0) throw new Error((r && r.stderr) || 'Could not unload cpu_oc');
  }
  const stock = await getStockCpuLimits();
  await read('echo ' + stock.policy0.max + ' > ' + P0 + '/scaling_max_freq && echo ' + stock.policy6.max + ' > ' + P6 + '/scaling_max_freq && rm -f ' + CPU_LOCK_STATE);
}

async function loadCpuModule() {
  const littleKhz = Number($('little-slider').value) * 1000;
  const bigKhz = Number($('big-slider').value) * 1000;
  const locking = $('cpu-lock').checked;
  if (!Number.isInteger(littleKhz) || !Number.isInteger(bigKhz)) throw new Error('Select valid frequencies');

  const stock = await getStockCpuLimits();
  const littleMax = stock.policy0.max + MAX_STEP_KHZ;
  const bigMax = stock.policy6.max + MAX_STEP_KHZ;
  if (littleKhz < stock.policy0.min || littleKhz > littleMax) {
    throw new Error('Little must be ' + stock.policy0.min / 1000 + '-' + littleMax / 1000 + ' MHz');
  }
  if (bigKhz < stock.policy6.min || bigKhz > bigMax) {
    throw new Error('Big must be ' + stock.policy6.min / 1000 + '-' + bigMax / 1000 + ' MHz');
  }
  const needsOverclock = littleKhz > stock.policy0.max || bigKhz > stock.policy6.max;
  await saveCpuFrequencyState();
  try {
    if (needsOverclock) {
      await ensureLoaderExecutable();
      const r = await exec(MOD_DIR + '/loader ' + MOD_DIR + '/cpu_oc.ko apply=1 little_khz=' + littleKhz + ' big_khz=' + bigKhz);
      if (!r || r.errno !== 0) throw new Error((r && r.stderr) || 'Kernel module load failed');
      const verify = await read("for n in policy0 policy6; do f=/sys/devices/system/cpu/cpufreq/$n/cpuinfo_max_freq; [ -r \"$f\" ] && printf '%s:%s\\n' \"$n\" \"$(cat \"$f\")\"; done");
      const actual = Object.fromEntries(verify.split(/\r?\n/).filter(Boolean).map((line) => {
        const i = line.indexOf(':');
        return [line.slice(0, i), Number(line.slice(i + 1))];
      }));
      if (!(actual.policy0 >= littleKhz && actual.policy6 >= bigKhz)) {
        throw new Error('Requested maximums were not confirmed (is cpu_oc.ko the latest build?)');
      }
    }
    await applyCpuFrequencies(littleKhz, bigKhz, locking);
  } catch (error) {
    await unloadCpuModule().catch(() => {});
    throw error;
  }
}

$('cpu-apply').addEventListener('click', () => {
  if (busy) return;
  const risky = Number($('little-slider').value) > LITTLE_WARN || Number($('big-slider').value) > BIG_WARN;
  if (risky && !cpuArmed) {
    cpuArmed = true;
    $('cpu-apply').textContent = 'Tap again to confirm';
    $('cpu-apply').classList.add('armed');
    setStatus('cpu-status', 'Above the tested range. The phone may freeze or reboot.', '');
    tick(15);
    cpuArmTimer = setTimeout(disarmCpu, 5000);
    return;
  }
  disarmCpu();
  runAction({
    status: 'cpu-status', buttons: ['cpu-apply', 'cpu-restore'], press: 'cpu-apply', working: 'Applying…',
    fn: async () => { await unloadCpuModule(); await loadCpuModule(); }, done: 'Applied', after: syncCpu
  });
});
$('cpu-restore').addEventListener('click', () => {
  disarmCpu();
  runAction({
    status: 'cpu-status', buttons: ['cpu-apply', 'cpu-restore'], press: 'cpu-restore', working: 'Restoring…',
    fn: unloadCpuModule, done: 'Stock limits restored', after: syncCpu
  });
});

// ---------- GPU ----------
function updateGpuLabels() {
  const s = 44 - Number($('gpu-slider').value);   // left = 390 MHz (OPP 44), right = 1100 MHz (OPP 0)
  setText('gpu-val', GPU_OPP_MHZ[s] + ' MHz');
  setText('gpu-hint', s <= 6 ? 'Loads gpu_oc first (voltage comes from the factory table).' : 'Stock frequency.');
  renderChips();
}
bindSlider('gpu-slider',
  () => { settings.gpuPos = Number($('gpu-slider').value); updateGpuLabels(); },
  saveSettings);

async function gpuPin(idx) {
  await read('echo ' + idx + ' > ' + GPU_PROC + '/fix_target_opp_index');
  await sleep(600);
  const st = await read('grep GPU-OPP ' + GPU_PROC + '/gpufreq_status');
  const m = st.match(/Index:\s*(\d+)/);
  if (!m || Number(m[1]) !== idx) throw new Error('GPU did not move to OPP ' + idx);
}
async function gpuUnpin() {
  await read('echo -1 > ' + GPU_PROC + '/fix_target_opp_index');
  const s = await read('cat ' + GPU_PROC + '/fix_target_opp_index');
  if (!/disabled/i.test(s)) throw new Error('Fixed OPP could not be disabled');
}
async function unloadGpu() {
  if (!(await moduleLoaded('gpu_oc'))) { await gpuUnpin().catch(() => {}); return; }
  await gpuPin(GPU_SAFE_IDX);   // row 0 must not be in use while it is restored
  const r = await exec(MOD_DIR + '/loader -r gpu_oc');
  if (!r || r.errno !== 0) throw new Error((r && r.stderr) || 'Could not unload gpu_oc');
  await gpuUnpin();
}
async function applyGpu() {
  const s = 44 - Number($('gpu-slider').value);   // signed OPP index 0..44
  if (s <= 6) {
    const has = await read('test -f ' + MOD_DIR + '/gpu_oc.ko && echo ok || echo missing');
    if (has !== 'ok') throw new Error('gpu_oc.ko is missing from ' + MOD_DIR);
  }
  await unloadGpu();
  if (s <= 6) {
    await ensureLoaderExecutable();
    await gpuPin(GPU_SAFE_IDX);
    try {
      const r = await exec(MOD_DIR + '/loader ' + MOD_DIR + '/gpu_oc.ko apply=1 sidx=' + s);
      if (!r || r.errno !== 0) throw new Error((r && r.stderr) || 'gpu_oc load failed');
      const top = await read('head -1 ' + GPU_PROC + '/gpu_working_opp_table');
      const f = top.match(/freq:\s*(\d+)/);
      if (!f || Number(f[1]) !== GPU_OPP_MHZ[s] * 1000) throw new Error('gpu_oc did not apply (got ' + (f ? f[1] : 'unknown') + ')');
    } catch (error) {
      await exec(MOD_DIR + '/loader -r gpu_oc').catch(() => {});
      await gpuUnpin().catch(() => {});
      throw error;
    }
    try {
      await gpuPin(0);
    } catch (error) {
      await unloadGpu().catch(() => {});
      throw error;
    }
  } else {
    await gpuPin(s - 7);
  }
  settings.gpuHeld = s;
  saveSettings();
}
async function restoreGpu() {
  await unloadGpu();
  settings.gpuHeld = null;
  saveSettings();
}

async function syncGpu() {
  let fixed = '';
  try { fixed = await read('cat ' + GPU_PROC + '/fix_target_opp_index 2>/dev/null || true'); } catch (_) {}
  live.gpuHeld = fixed !== '' && !/disabled/i.test(fixed);
  if (!live.gpuHeld && settings.gpuHeld !== null) { settings.gpuHeld = null; saveSettings(); }
  if (live.gpuHeld && settings.gpuHeld !== null) settings.gpuPos = 44 - settings.gpuHeld;
  $('gpu-slider').value = settings.gpuPos;
  updateGpuLabels();
}

$('gpu-apply').addEventListener('click', () => runAction({
  status: 'gpu-status', buttons: ['gpu-apply', 'gpu-restore'], press: 'gpu-apply', working: 'Applying…',
  fn: applyGpu, done: 'Applied', after: syncGpu
}));
$('gpu-restore').addEventListener('click', () => runAction({
  status: 'gpu-status', buttons: ['gpu-apply', 'gpu-restore'], press: 'gpu-restore', working: 'Restoring…',
  fn: restoreGpu, done: 'Back to automatic', after: syncGpu
}));

// ---------- ZRAM algorithm (runtime only, resets on reboot) ----------
const ZRAM_SH = '/data/adb/heilog99-zram.sh';
const ZRAM_RES = '/data/adb/heilog99-zram.result';

// Runs detached from the page so closing the WebUI cannot interrupt swapoff/reset halfway.
const ZRAM_SCRIPT = String.raw`#!/system/bin/sh
Z=/sys/block/zram0
DEV=/dev/block/zram0
LOG=/data/adb/lz4-zram-manual.log
RES=/data/adb/heilog99-zram.result
TARGET="$1"
say() { echo "[$(date +%T)] $1" >> "$LOG"; }
finish() { say "$1"; echo "$1" > "$RES"; exit "$2"; }
: > "$LOG"
rm -f "$RES"
[ "$(id -u)" = "0" ] || finish "fail Not running as root" 1
case "$TARGET" in
  lz4|lz4-rle|zstd) ;;
  *) finish "fail Unsupported choice" 1 ;;
esac
SIZE=$(cat "$Z/disksize")
ALGS=$(cat "$Z/comp_algorithm")
USED_KB=$(grep zram0 /proc/swaps | awk '{print $4}')
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
[ -n "$USED_KB" ] || USED_KB=0
[ -n "$AVAIL_KB" ] || AVAIL_KB=0
OLD=$(echo "$ALGS" | tr ' ' '\n' | grep '\[' | tr -d '[]')
case "$SIZE" in
  ''|0|*[!0-9]*) finish "fail Invalid ZRAM disk size" 1 ;;
esac
case "$USED_KB:$AVAIL_KB" in
  *[!0-9:]*|:*) finish "fail Cannot read memory information" 1 ;;
esac
NEED_KB=$(( USED_KB * 13 / 10 + 600000 ))
say "Current: $OLD, target: $TARGET, used: $((USED_KB / 1024)) MB, available: $((AVAIL_KB / 1024)) MB, required: $((NEED_KB / 1024)) MB"
if [ "$AVAIL_KB" -lt "$NEED_KB" ]; then
  finish "fail Not enough free RAM (needs $((NEED_KB / 1024)) MB, has $((AVAIL_KB / 1024)) MB)" 1
fi
echo "$ALGS" | grep -qw "$TARGET" || finish "fail $TARGET is not supported by this kernel" 1
[ "$OLD" = "$TARGET" ] && finish "ok Already using $TARGET" 0
restore() {
  say "ROLLBACK to $OLD"
  swapoff "$DEV" 2>/dev/null
  echo 1 > "$Z/reset"
  echo "$OLD" > "$Z/comp_algorithm" 2>/dev/null
  echo "$SIZE" > "$Z/disksize"
  mkswap "$DEV" >/dev/null 2>&1 && swapon "$DEV"
  finish "fail Something went wrong, rolled back to $OLD" 1
}
say "Disabling ZRAM swap..."
swapoff "$DEV" 2>>"$LOG"
if grep -q zram0 /proc/swaps; then
  swapon "$DEV" 2>/dev/null
  finish "fail swapoff failed, nothing changed" 1
fi
echo 1 > "$Z/reset" 2>>"$LOG" || restore
[ "$(cat "$Z/initstate")" = "0" ] || restore
echo "$TARGET" > "$Z/comp_algorithm" 2>>"$LOG" || restore
grep -q "\[$TARGET\]" "$Z/comp_algorithm" || restore
echo "$SIZE" > "$Z/disksize" 2>>"$LOG" || restore
mkswap "$DEV" >>"$LOG" 2>&1 || restore
swapon "$DEV" 2>>"$LOG" || restore
finish "ok Now using $TARGET" 0
`;

const zram = { ready: false, supported: [], current: '', selected: '' };
let zramArmed = false;
let zramArmTimer = null;

function zramNumbers() {
  const usedKb = Math.max(0, (lastMem.SwapTotal || 0) - (lastMem.SwapFree || 0));
  return { avail: lastMem.MemAvailable || 0, need: Math.round(usedKb * 1.3 + 600000) };
}
function disarmZram() {
  zramArmed = false;
  clearTimeout(zramArmTimer);
  $('z-apply').textContent = 'Change algorithm';
  $('z-apply').classList.remove('armed');
}
function updateZramUi() {
  setText('z-alg', zram.current ? zram.current.toUpperCase() : (live.zram ? live.zram.toUpperCase() : '--'));
  document.querySelectorAll('#z-seg button').forEach((b) => {
    b.disabled = !zram.supported.includes(b.dataset.alg);
    b.classList.toggle('on', b.dataset.alg === zram.selected);
  });
  if (!busy) $('z-apply').disabled = !zram.ready;
  const n = zramNumbers();
  setText('z-need', lastMem.MemTotal ? mbText(n.need) : '--');
  setText('z-now', lastMem.MemTotal ? mbText(n.avail) : '--');
  const box = $('pb-now');
  box.classList.toggle('good', !!lastMem.MemTotal && n.avail >= n.need);
  box.classList.toggle('bad', !!lastMem.MemTotal && n.avail < n.need);
  setText('z-hint', zram.ready
    ? (n.avail >= n.need ? 'Enough free RAM. Resets on reboot.' : 'Not enough free RAM yet. Close some apps first.')
    : 'ZRAM is not available on this device.');
}
async function syncZram() {
  try {
    const tokens = (await read('cat /sys/block/zram0/comp_algorithm')).split(/\s+/).filter(Boolean);
    const clean = (t) => t.replace(/[\[\]]/g, '');
    zram.supported = tokens.map(clean);
    const cur = tokens.find((t) => t.startsWith('['));
    zram.current = cur ? clean(cur) : '';
    zram.ready = zram.current !== '';
    if (zram.current) live.zram = zram.current;
  } catch (_) {
    zram.ready = false; zram.supported = []; zram.current = '';
  }
  if (!zram.selected || !zram.supported.includes(zram.selected)) {
    zram.selected = zram.supported.includes(settings.zram) ? settings.zram : zram.current;
  }
  updateZramUi();
  renderChips();
}
document.querySelectorAll('#z-seg button').forEach((b) => b.addEventListener('click', () => {
  zram.selected = b.dataset.alg;
  settings.zram = zram.selected;
  saveSettings();
  disarmZram();
  updateZramUi();
  tick(8);
}));

async function switchZram(target) {
  await read("echo '" + btoa(ZRAM_SCRIPT) + "' | base64 -d > " + ZRAM_SH + ' && chmod 0755 ' + ZRAM_SH + ' && rm -f ' + ZRAM_RES);
  await read('(nohup sh ' + ZRAM_SH + ' ' + target + ' >/dev/null 2>&1 </dev/null &)');
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const res = await read('cat ' + ZRAM_RES + ' 2>/dev/null || true');
    if (res) {
      if (res.startsWith('ok')) return;
      throw new Error(res.replace(/^fail\s*/, ''));
    }
  }
  throw new Error('Timed out. See /data/adb/lz4-zram-manual.log');
}

$('z-apply').addEventListener('click', () => {
  if (busy) return;
  if (!zram.ready) { setStatus('z-status', 'ZRAM is not available', 'bad'); return; }
  if (zram.selected === zram.current) { setStatus('z-status', 'Already using ' + zram.current, ''); return; }
  const n = zramNumbers();
  if (n.avail < n.need) { setStatus('z-status', 'Not enough free RAM. Close some apps and try again.', 'bad'); tick([40, 50, 40]); return; }
  if (!zramArmed) {
    zramArmed = true;
    $('z-apply').textContent = 'Tap again to confirm';
    $('z-apply').classList.add('armed');
    setStatus('z-status', 'The phone may lag for a few seconds while ZRAM is rebuilt.', '');
    tick(15);
    zramArmTimer = setTimeout(disarmZram, 5000);
    return;
  }
  const target = zram.selected;
  disarmZram();
  runAction({
    status: 'z-status', buttons: ['z-apply'], press: 'z-apply', working: 'Switching to ' + target + '… keep this page open',
    fn: () => switchZram(target), done: 'Now using ' + target, after: syncZram
  });
});

// ---------- start ----------
function applySettingsUi() {
  fillCpuUi();
  $('gpu-slider').value = settings.gpuPos;
  updateGpuLabels();
}
async function init() {
  setText('subt', 'Galaxy A07 · app ' + APP_VERSION);
  settings = { ...defaults, ...(loadLocal() || {}) };
  applySettingsUi();
  try {
    const snap = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    if (snap && snap.has) render(snap);   // instant first paint with the last known values
  } catch (_) {}
  probeSpawn();
  startLoop();
  const file = await loadFile();
  if (file && (file.savedAt || 0) > (settings.savedAt || 0)) {
    settings = { ...defaults, ...file };
    applySettingsUi();
  }
}
init();
