// Helio G99 Control - KernelSU WebUI

// ---------- KernelSU bridge (no bundler needed) ----------
function exec(command, options = {}) {
  return new Promise((resolve, reject) => {
    const cb = 'exec_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    window[cb] = (errno, stdout, stderr) => {
      resolve({ errno, stdout, stderr });
      delete window[cb];
    };
    try {
      ksu.exec(command, JSON.stringify(options), cb);
    } catch (error) {
      reject(error);
      delete window[cb];
    }
  });
}

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const GPU_PROC = '/proc/gpufreqv2';
const GPU_SAFE_IDX = 20;          // stock working row, never touched by gpu_oc
const LITTLE_WARN = 2400;         // warn above this (MHz)
const BIG_WARN = 2500;
const POLL_MS = 1500;
const GPU_OPP_MHZ = [1100, 1086, 1072, 1058, 1045, 1031, 1017, 1003, 990, 976, 962, 948, 935, 921, 907, 893, 880, 868, 857, 846, 835, 823, 812, 801, 790, 778, 767, 756, 745, 733, 722, 711, 700, 674, 648, 622, 596, 570, 545, 519, 493, 467, 441, 415, 390];

// ---------- saved settings (WebView storage + a file, so they survive) ----------
const defaults = { little: 2300, big: 2500, lock: false, gpuPos: 44, gpuHeld: null };
let settings = { ...defaults };

function loadLocal() {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
async function loadFile() {
  try { const raw = await read('cat ' + CONF + ' 2>/dev/null'); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
let saveTimer = null;
function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (_) {}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    read("printf '%s' '" + JSON.stringify(settings) + "' > " + CONF).catch(() => {});
  }, 300);
}

// ---------- navigation ----------
function go(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  window.scrollTo(0, 0);
  if (!busy) {
    if (name === 'cpu') syncCpu();
    if (name === 'gpu') syncGpu();
    if (name === 'mem') syncZram();
  }
  poll();
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ---------- live readings ----------
const POLL_CMD = [
  'for c in 0 1 2 3 4 5 6 7; do',
  ' d=/sys/devices/system/cpu/cpu$c/cpufreq;',
  ' v=$(cat $d/cpuinfo_cur_freq 2>/dev/null);',
  ' [ -n "$v" ] || v=$(cat $d/scaling_cur_freq 2>/dev/null);',
  ' echo "C $c ${v:-0}";',
  'done;',
  'echo "G $(cat /sys/class/devfreq/13000000.mali/cur_freq 2>/dev/null)";',
  "awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {print \"M \" $1 \" \" $2}' /proc/meminfo;",
  'for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/temp 2>/dev/null); [ -n "$t" ] && echo "T $(cat $z/type 2>/dev/null | tr \' \' _) $t"; done;',
  'true'
].join('\n');

function parse(raw) {
  const d = { cores: new Array(8).fill(0), gpu: 0, mem: {}, temps: [] };
  raw.split('\n').forEach((line) => {
    const p = line.trim().split(' ');
    if (p[0] === 'C') d.cores[Number(p[1])] = Number(p[2]) || 0;
    else if (p[0] === 'G') d.gpu = Number(p[1]) || 0;
    else if (p[0] === 'M') d.mem[p[1].replace(':', '')] = Number(p[2]) || 0;
    else if (p[0] === 'T') {
      const t = Number(p[p.length - 1]);
      if (t > 1000 && t < 150000) d.temps.push({ name: p.slice(1, -1).join(' ') || 'sensor', c: t / 1000 });
    }
  });
  return d;
}

const ghz = (khz) => (khz / 1e6).toFixed(2);
const gb = (kb) => (kb / 1048576).toFixed(2);
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

function render(d) {
  // CPU
  const little = Math.max(...d.cores.slice(0, 6));
  const big = Math.max(d.cores[6], d.cores[7]);
  const top = Math.max(little, big);
  setText('t-cpu', top ? ghz(top) + ' GHz' : '--');
  setText('t-cpu-sub', 'Little ' + (little ? ghz(little) : 'off') + ' · Big ' + (big ? ghz(big) : 'off'));
  d.cores.forEach((k, i) => setText('core-' + i, k ? String(Math.round(k / 1000)) : 'off'));

  // GPU
  const gpuMhz = d.gpu ? Math.round(d.gpu / 1e6) : 0;
  setText('t-gpu', gpuMhz ? gpuMhz + ' MHz' : '--');
  setText('gpu-live', gpuMhz ? String(gpuMhz) : '--');

  // Memory
  const total = d.mem.MemTotal || 0;
  const avail = d.mem.MemAvailable || 0;
  const used = Math.max(0, total - avail);
  setText('t-mem', total ? gb(used) + ' GB' : '--');
  setText('t-mem-sub', total ? 'of ' + gb(total) + ' GB' : '--');
  setText('m-used', total ? gb(used) : '--');
  setText('m-avail', total ? gb(avail) + ' GB' : '--');
  setText('m-total', total ? gb(total) + ' GB' : '--');
  $('bar-ram').style.width = pct(used, total) + '%';
  const swapTotal = d.mem.SwapTotal || 0;
  const swapUsed = Math.max(0, swapTotal - (d.mem.SwapFree || 0));
  setText('z-used', swapTotal ? gb(swapUsed) + ' GB' : 'none');
  setText('z-total', swapTotal ? gb(swapTotal) + ' GB' : 'none');
  $('bar-zram').style.width = pct(swapUsed, swapTotal) + '%';
  lastMem = d.mem;
  updateZramUi();

  // Temperature
  const best = {};
  d.temps.forEach((t) => { if (!(t.name in best) || t.c > best[t.name]) best[t.name] = t.c; });
  const list = Object.entries(best).sort((a, b) => b[1] - a[1]);
  if (list.length) {
    setText('t-temp', list[0][1].toFixed(1) + ' °C');
    setText('temp-hot', list[0][1].toFixed(1));
    const box = $('temp-list');
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
  } else {
    setText('t-temp', '--');
    setText('temp-hot', '--');
  }
}

let busy = false;
let polling = false;
let timer = null;

async function poll() {
  if (polling || busy || document.hidden) return;
  polling = true;
  try {
    render(parse(await read(POLL_CMD)));
    $('dot').className = 'dot ok';
    $('err').hidden = true;
  } catch (error) {
    $('dot').className = 'dot bad';
    $('err').hidden = false;
    $('err').textContent = 'KernelSU unavailable: ' + (error && error.message ? error.message : 'unknown error');
  } finally {
    polling = false;
  }
}
function startTimer() { if (timer === null) timer = setInterval(poll, POLL_MS); }
function stopTimer() { if (timer !== null) clearInterval(timer); timer = null; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTimer(); else { startTimer(); poll(); }
});

// ---------- generic action runner ----------
async function runAction(statusId, buttonIds, working, fn, done, after) {
  if (busy) return;
  busy = true;
  buttonIds.forEach((id) => { $(id).disabled = true; });
  setText(statusId, working);
  try {
    await fn();
    setText(statusId, done);
  } catch (error) {
    setText(statusId, 'Failed: ' + (error && error.message ? error.message : 'unknown error'));
  } finally {
    try { if (after) await after(); } catch (_) {}
    buttonIds.forEach((id) => { $(id).disabled = false; });
    busy = false;
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

// ---------- CPU ----------
const P0 = '/sys/devices/system/cpu/cpufreq/policy0';
const P6 = '/sys/devices/system/cpu/cpufreq/policy6';

function updateCpuLabels() {
  const l = Number($('little-slider').value);
  const b = Number($('big-slider').value);
  setText('little-val', l + ' MHz');
  setText('big-val', b + ' MHz');
  $('little-warn').hidden = l <= LITTLE_WARN;
  $('big-warn').hidden = b <= BIG_WARN;
}
function fillCpuUi() {
  $('little-slider').value = settings.little;
  $('big-slider').value = settings.big;
  $('cpu-lock').checked = !!settings.lock;
  updateCpuLabels();
}
$('little-slider').addEventListener('input', () => { settings.little = Number($('little-slider').value); updateCpuLabels(); saveSettings(); });
$('big-slider').addEventListener('input', () => { settings.big = Number($('big-slider').value); updateCpuLabels(); saveSettings(); });
$('cpu-lock').addEventListener('change', () => { settings.lock = $('cpu-lock').checked; saveSettings(); });

async function cpuActive() {
  return (await read("if grep -q '^cpu_oc ' /proc/modules || [ -f " + CPU_LOCK_STATE + " ]; then echo yes; else echo no; fi")) === 'yes';
}

// When CPU control is active, show what is really applied; otherwise show the saved choice.
async function syncCpu() {
  try {
    if (await cpuActive()) {
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
  // cpu_oc.c refuses jumps bigger than +400 MHz over stock
  if (littleKhz < stock.policy0.min || littleKhz > stock.policy0.max + 400000 ||
      bigKhz < stock.policy6.min || bigKhz > stock.policy6.max + 400000) {
    throw new Error('Selected frequency is outside the supported range');
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
      if (!(actual.policy0 >= littleKhz && actual.policy6 >= bigKhz)) throw new Error('Requested maximums were not confirmed');
    }
    await applyCpuFrequencies(littleKhz, bigKhz, locking);
  } catch (error) {
    await unloadCpuModule().catch(() => {});
    throw error;
  }
}

$('cpu-apply').addEventListener('click', () => runAction('cpu-status', ['cpu-apply', 'cpu-restore'], 'Applying…',
  async () => { await unloadCpuModule(); await loadCpuModule(); }, 'Applied', syncCpu));
$('cpu-restore').addEventListener('click', () => runAction('cpu-status', ['cpu-apply', 'cpu-restore'], 'Restoring…',
  unloadCpuModule, 'Stock limits restored', syncCpu));

// ---------- GPU ----------
let gpuState = 'Automatic';

function updateGpuLabels() {
  const s = 44 - Number($('gpu-slider').value);   // slider: left = 390 MHz (OPP 44), right = 1100 MHz (OPP 0)
  setText('gpu-val', GPU_OPP_MHZ[s] + ' MHz');
  setText('gpu-hint', s <= 6 ? 'Loads gpu_oc first (voltage comes from the factory table).' : 'Stock frequency.');
  setText('gpu-state', gpuState);
  setText('t-gpu-sub', gpuState);
}
$('gpu-slider').addEventListener('input', () => { settings.gpuPos = Number($('gpu-slider').value); updateGpuLabels(); saveSettings(); });

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
  const held = fixed !== '' && !/disabled/i.test(fixed);
  if (!held && settings.gpuHeld !== null) { settings.gpuHeld = null; saveSettings(); }
  if (held && settings.gpuHeld !== null) {
    settings.gpuPos = 44 - settings.gpuHeld;
    gpuState = 'Holding ' + GPU_OPP_MHZ[settings.gpuHeld] + ' MHz';
  } else if (held) {
    gpuState = 'Holding a manual value';
  } else {
    gpuState = 'Automatic';
  }
  $('gpu-slider').value = settings.gpuPos;
  updateGpuLabels();
}

$('gpu-apply').addEventListener('click', () => runAction('gpu-status', ['gpu-apply', 'gpu-restore'], 'Applying…', applyGpu, 'Applied', syncGpu));
$('gpu-restore').addEventListener('click', () => runAction('gpu-status', ['gpu-apply', 'gpu-restore'], 'Restoring…', restoreGpu, 'Back to automatic', syncGpu));

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
let lastMem = {};
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
}
function updateZramUi() {
  setText('z-alg', zram.current || '--');
  document.querySelectorAll('#z-seg button').forEach((b) => {
    b.disabled = !zram.supported.includes(b.dataset.alg);
    b.classList.toggle('on', b.dataset.alg === zram.selected);
  });
  if (!busy) $('z-apply').disabled = !zram.ready;
  const mb = (k) => Math.round(k / 1024);
  const n = zramNumbers();
  setText('z-hint', zram.ready
    ? 'Needs ' + mb(n.need) + ' MB free RAM · now ' + mb(n.avail) + ' MB. Resets on reboot.'
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
  } catch (_) {
    zram.ready = false; zram.supported = []; zram.current = '';
  }
  if (!zram.selected || !zram.supported.includes(zram.selected)) zram.selected = zram.current;
  updateZramUi();
}
document.querySelectorAll('#z-seg button').forEach((b) => b.addEventListener('click', () => {
  zram.selected = b.dataset.alg;
  disarmZram();
  updateZramUi();
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
  if (!zram.ready) { setText('z-status', 'ZRAM is not available'); return; }
  if (zram.selected === zram.current) { setText('z-status', 'Already using ' + zram.current); return; }
  const n = zramNumbers();
  if (n.avail < n.need) { setText('z-status', 'Not enough free RAM. Close some apps and try again.'); return; }
  if (!zramArmed) {
    zramArmed = true;
    $('z-apply').textContent = 'Tap again to confirm';
    setText('z-status', 'The phone may lag for a few seconds while ZRAM is rebuilt.');
    zramArmTimer = setTimeout(disarmZram, 5000);
    return;
  }
  const target = zram.selected;
  disarmZram();
  runAction('z-status', ['z-apply'], 'Switching to ' + target + '… keep this page open',
    () => switchZram(target), 'Now using ' + target, syncZram);
});

// ---------- start ----------
async function init() {
  settings = { ...defaults, ...(loadLocal() || {}) };
  fillCpuUi();
  $('gpu-slider').value = settings.gpuPos;
  updateGpuLabels();
  startTimer();
  poll();
  const file = await loadFile();
  if (file) {
    settings = { ...defaults, ...file };
    fillCpuUi();
    $('gpu-slider').value = settings.gpuPos;
    updateGpuLabels();
  }
  await syncCpu();
  await syncGpu();
  await syncZram();
}
init();
