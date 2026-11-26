// KernelSU WebUI bridge (no bundler needed): wraps the global `ksu.exec`.
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
const show = (id, value) => { const el = $(id); if (el) el.textContent = value; };
function updatePreviewSlider(sliderId, valueId, warningId, threshold) {
  const slider = $(sliderId);
  const value = Number(slider.value);
  show(valueId, value + ' MHz');
  $(warningId).hidden = value <= threshold;
}
$('little-slider').addEventListener('input', () => updatePreviewSlider('little-slider','little-selected','little-warning',2300));
$('big-slider').addEventListener('input', () => updatePreviewSlider('big-slider','big-selected','big-warning',2500));
const GPU_OPP_MHZ = [1100, 1086, 1072, 1058, 1045, 1031, 1017, 1003, 990, 976, 962, 948, 935, 921, 907, 893, 880, 868, 857, 846, 835, 823, 812, 801, 790, 778, 767, 756, 745, 733, 722, 711, 700, 674, 648, 622, 596, 570, 545, 519, 493, 467, 441, 415, 390];
function updateGpuPreview() {
  const index = Number($('gpu-slider').value);
  show('gpu-selected', GPU_OPP_MHZ[index] + ' MHz · OPP ' + index);
  show('gpu-lock-preview-status', index <= 6
    ? 'Needs gpu_oc (raises the GPU ceiling to this row)'
    : 'Stock row · tick Fixed target to pin it');
}
$('gpu-slider').addEventListener('input', updateGpuPreview);
$('gpu-lock-preview').addEventListener('change', updateGpuPreview);
updateGpuPreview();
updatePreviewSlider('little-slider','little-selected','little-warning',2300);
updatePreviewSlider('big-slider','big-selected','big-warning',2500);
async function read(command) {
  const result = await exec(command);
  if (!result || result.errno !== 0) throw new Error(result?.stderr || 'Command failed');
  return String(result.stdout || '').trim();
}
function parsePolicies(raw) {
  return raw.split('\n').filter(Boolean).map(line => {
    const [name, khz] = line.split(':');
    const n = Number(khz);
    return {name, ghz: Number.isFinite(n) ? (n/1000000).toFixed(2) : null};
  });
}
async function refresh() {
  show('connection','Reading device information…');
  try {
    const [cpuRaw, memRaw, moduleRaw, tempRaw] = await Promise.all([
      read("for p in /sys/devices/system/cpu/cpufreq/policy*; do [ -r \"$p/scaling_cur_freq\" ] && printf '%s:%s\\n' \"$(basename \"$p\")\" \"$(cat \"$p/scaling_cur_freq\")\"; done"),
      read("awk '/MemTotal:/ {t=$2} /MemAvailable:/ {a=$2} END {if(t>0) printf \"%.2f/%.2f GB\", (t-a)/1048576, t/1048576; else print \"Unavailable\"}' /proc/meminfo"),
      read("cat /proc/modules"),
      read("for f in /sys/class/thermal/thermal_zone*/temp; do [ -r \"$f\" ] && { v=$(cat \"$f\"); case \"$v\" in ''|*[!0-9]*) ;; *) [ \"$v\" -gt 0 ] && [ \"$v\" -lt 1000000 ] && printf '%s\\n' \"$v\";; esac; }; done")
    ]);
    const policies = parsePolicies(cpuRaw);
    if (policies.length) {
      show('cpu-main', policies[0].ghz ? policies[0].ghz+' GHz' : '-- GHz');
      show('cpu-hint', policies.map(p=>p.name+': '+(p.ghz?p.ghz+' GHz':'unknown')).join(' · '));
      show('policies', String(policies.length)+' detected');
    } else {
      show('cpu-main','-- GHz'); show('cpu-hint','CPU frequency interface unavailable'); show('policies','Unavailable');
    }
    const temps = tempRaw.split('\n').map(Number).filter(v=>Number.isFinite(v)&&v>0&&v<1000000);
    show('temp', temps.length ? (Math.max(...temps)/1000).toFixed(1)+' °C*' : 'Unavailable');
    show('ram', memRaw || 'Unavailable');
    const gpuLoaded = moduleRaw.split('\n').some(line=>line.startsWith('gpu_oc '));
    show('gpu-page-status',gpuLoaded?'gpu_oc.ko is loaded.':'gpu_oc.ko is not loaded (stock GPU limits).');
    show('connection','Connected');
    $('connection-dot').classList.add('ok');
    show('updated','Updated '+new Date().toLocaleTimeString());
  } catch (error) {
    show('connection','KernelSU API unavailable: '+(error?.message || 'unknown error'));
    $('connection-dot').classList.remove('ok');
    show('cpu-hint','Open this page inside a compatible KernelSU Manager WebUI');
  }
}
let gpuTimer = null;
async function refreshGpu() {
  if (!$('gpu-page').classList.contains('active') || document.hidden) return;
  try {
    const raw = await read("P=/sys/class/devfreq/13000000.mali; for f in cur_freq min_freq max_freq governor; do [ -r \"$P/$f\" ] && printf '%s:%s\\n' \"$f\" \"$(cat \"$P/$f\")\"; done");
    const values = Object.fromEntries(raw.split('\n').filter(Boolean).map(line => {
      const i = line.indexOf(':'); return [line.slice(0,i),line.slice(i+1)];
    }));
    const mhz = value => Number.isFinite(Number(value)) ? (Number(value)/1000000).toFixed(0)+' MHz' : '--';
    show('gpu-page-freq', values.cur_freq ? mhz(values.cur_freq) : 'Unavailable');
    show('gpu-page-range', values.min_freq && values.max_freq ? mhz(values.min_freq)+' – '+mhz(values.max_freq) : 'Unavailable');
    show('gpu-page-governor', values.governor || 'Unavailable');
    show('gpu-page-updated','Live · refreshed '+new Date().toLocaleTimeString()+' · pauses when this page is closed or hidden');
  } catch (error) {
    show('gpu-page-freq','Read failed: '+(error?.message || 'unknown error'));
    show('gpu-page-updated','GPU readings unavailable');
  }
}
function startGpuMonitor() {
  if (gpuTimer !== null || document.hidden) return;
  refreshGpu();
  gpuTimer = setInterval(refreshGpu,1000);
}
function stopGpuMonitor() {
  if (gpuTimer !== null) clearInterval(gpuTimer);
  gpuTimer = null;
}
$('open-gpu').addEventListener('click',()=>{$('home').classList.remove('active');$('gpu-page').classList.add('active');window.scrollTo(0,0);startGpuMonitor();});
$('back-home').addEventListener('click',()=>{$('gpu-page').classList.remove('active');$('home').classList.add('active');stopGpuMonitor();window.scrollTo(0,0);});
$('refresh').addEventListener('click',refresh);
let cpuTimer = null;
async function refreshCpuPage() {
  if (!$('cpu-page').classList.contains('active') || document.hidden) return;
  try {
    const loaded = await cpuModuleLoaded();
    setCpuControlState(loaded);
    show('cpu-control-status', loaded ? 'CPU OC active' : 'Ready');
  } catch (error) {
    show('cpu-control-status', 'Status unavailable');
  }
}
function startCpuMonitor() {
  if (cpuTimer !== null || document.hidden) return;
  refreshCpuPage();
  cpuTimer = setInterval(refreshCpuPage,1000);
}
function stopCpuMonitor() {
  if (cpuTimer !== null) clearInterval(cpuTimer);
  cpuTimer = null;
}
$('cpu-tile').addEventListener('click',()=>{$('home').classList.remove('active');$('cpu-page').classList.add('active');window.scrollTo(0,0);startCpuMonitor();});
$('back-cpu').addEventListener('click',()=>{$('cpu-page').classList.remove('active');$('home').classList.add('active');stopCpuMonitor();window.scrollTo(0,0);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopGpuMonitor();stopCpuMonitor();}else{if($('gpu-page').classList.contains('active'))startGpuMonitor();if($('cpu-page').classList.contains('active'))startCpuMonitor();}});

const CPU_MODULE_DIR = '/data/adb/modules/heilog99_control';
let cpuActionBusy = false;

async function ensureLoaderExecutable() {
  const path = CPU_MODULE_DIR + '/loader';
  const result = await exec('chmod 0755 ' + path + ' && test -x ' + path);
  if (!result || result.errno !== 0) {
    throw new Error(result?.stderr || 'Could not set loader executable permission');
  }
}

function setCpuControlState(loaded) {
  const toggle = $('cpu-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-pressed', String(loaded));
  toggle.textContent = loaded ? 'Disable CPU control' : 'CPU control inactive';
  toggle.disabled = !loaded;
  toggle.classList.toggle('active', loaded);
}

async function cpuModuleLoaded() {
  return (await read("if grep -q '^cpu_oc ' /proc/modules || [ -f " + CPU_LOCK_STATE + " ]; then echo yes; else echo no; fi")) === 'yes';
}

const CPU_LOCK_STATE = CPU_MODULE_DIR + '/.cpu-frequency-lock-state';

async function restoreCpuFrequencyLock() {
  const stock = await getStockCpuLimits();
  const p0 = '/sys/devices/system/cpu/cpufreq/policy0';
  const p6 = '/sys/devices/system/cpu/cpufreq/policy6';
  await read('echo ' + stock.policy0.min + ' > ' + p0 + '/scaling_min_freq && ' +
    'echo ' + stock.policy0.max + ' > ' + p0 + '/scaling_max_freq && ' +
    'echo ' + stock.policy6.min + ' > ' + p6 + '/scaling_min_freq && ' +
    'echo ' + stock.policy6.max + ' > ' + p6 + '/scaling_max_freq && rm -f ' + CPU_LOCK_STATE);
}

async function saveCpuFrequencyState() {
  const state = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s\\n' \"$(cat $p/scaling_min_freq)\" \"$(cat $p/scaling_max_freq)\"; done");
  const values = state.split(/\r?\n/).map(Number);
  if (values.length !== 4 || values.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error('Could not save the original CPU frequency limits');
  }
  await read("printf '%s\\n' " + values.join(' ') + " > " + CPU_LOCK_STATE);
}

async function applyCpuFrequencies(littleKhz, bigKhz, locking) {
  const command = 'echo ' + littleKhz + ' > /sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq && ' +
    'echo ' + bigKhz + ' > /sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq';
  await read(command);
  if (locking) {
    await read('echo ' + littleKhz + ' > /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq && ' +
      'echo ' + bigKhz + ' > /sys/devices/system/cpu/cpufreq/policy6/scaling_min_freq');
  }
  const check = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s\\n' \"$(cat $p/scaling_min_freq)\" \"$(cat $p/scaling_max_freq)\"; done");
  const values = check.split(/\r?\n/).map(Number);
  if (values.length !== 4 || values[1] !== littleKhz || values[3] !== bigKhz ||
      (locking && (values[0] !== littleKhz || values[2] !== bigKhz))) {
    throw new Error('The kernel did not accept the selected CPU frequencies');
  }
}

async function unloadCpuModule() {
  await restoreCpuFrequencyLock();
  if (!(await cpuModuleLoaded())) return;
  await ensureLoaderExecutable();
  const result = await exec(CPU_MODULE_DIR + '/loader -r cpu_oc');
  if (!result || result.errno !== 0) throw new Error(result?.stderr || 'Could not unload cpu_oc');
  if (await cpuModuleLoaded()) throw new Error('cpu_oc is still loaded after unload');
}

async function getStockCpuLimits() {
  const raw = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s:%s:%s\\n' \"$n\" \"$(cat $p/cpuinfo_min_freq)\" \"$(cat $p/cpuinfo_max_freq)\"; done");
  const values = {};
  raw.split(/\r?\n/).filter(Boolean).forEach(line => {
    const [name, min, max] = line.split(':');
    values[name] = {min: Number(min), max: Number(max)};
  });
  if (!values.policy0 || !values.policy6 ||
      ![values.policy0.min, values.policy0.max, values.policy6.min, values.policy6.max].every(Number.isFinite)) {
    throw new Error('Could not read the Little/Big CPU frequency limits');
  }
  return values;
}

async function loadCpuModule() {
  const littleMhz = Number($('little-slider').value);
  const bigMhz = Number($('big-slider').value);
  if (!Number.isInteger(littleMhz) || !Number.isInteger(bigMhz)) {
    throw new Error('Select valid whole-number CPU frequencies');
  }

  const stock = await getStockCpuLimits();
  const littleKhz = littleMhz * 1000;
  const bigKhz = bigMhz * 1000;
  const locking = $('cpu-lock-frequency').checked;
  const littleValid = littleKhz >= stock.policy0.min &&
    littleKhz <= stock.policy0.max + 400000;
  const bigValid = bigKhz >= stock.policy6.min &&
    bigKhz <= stock.policy6.max + 400000;
  if (!littleValid || !bigValid) {
    throw new Error('Selected CPU frequency is outside the supported range');
  }

  const needsOverclock = littleKhz > stock.policy0.max || bigKhz > stock.policy6.max;
  await saveCpuFrequencyState();
  try {
    if (needsOverclock) {
      await ensureLoaderExecutable();
      const command = CPU_MODULE_DIR + '/loader ' + CPU_MODULE_DIR +
        '/cpu_oc.ko apply=1 little_khz=' + littleKhz + ' big_khz=' + bigKhz;
      const result = await exec(command);
      if (!result || result.errno !== 0) throw new Error(result?.stderr || 'Kernel module load failed');

      const verify = await read("for n in policy0 policy6; do f=/sys/devices/system/cpu/cpufreq/$n/cpuinfo_max_freq; [ -r \"$f\" ] && printf '%s:%s\\n' \"$n\" \"$(cat \"$f\")\"; done");
      const actual = Object.fromEntries(verify.split(/\r?\n/).filter(Boolean).map(line => {
        const i = line.indexOf(':'); return [line.slice(0, i), Number(line.slice(i + 1))];
      }));
      if (!(actual.policy0 >= littleKhz && actual.policy6 >= bigKhz)) {
        throw new Error('Requested CPU maximums were not confirmed');
      }
    }
    await applyCpuFrequencies(littleKhz, bigKhz, locking);
  } catch (error) {
    await restoreCpuFrequencyLock().catch(() => {});
    if (needsOverclock) {
      await ensureLoaderExecutable().catch(() => {});
      await exec(CPU_MODULE_DIR + '/loader -r cpu_oc').catch(() => {});
    }
    throw error;
  }
}

async function runCpuAction(action) {
  if (cpuActionBusy) return;
  cpuActionBusy = true;
  const toggle = $('cpu-toggle');
  const apply = $('cpu-apply');
  toggle.disabled = true;
  apply.disabled = true;
  show('cpu-control-status', action === 'off' ? 'Disabling…' : 'Applying…');
  try {
    if (action === 'off') {
      await unloadCpuModule();
      show('cpu-control-status', 'CPU OC disabled');
    } else {
      await unloadCpuModule();
      await loadCpuModule();
      show('cpu-control-status', 'CPU OC active');
    }
  } catch (error) {
    show('cpu-control-status', 'Action failed: ' + (error?.message || 'unknown error'));
  } finally {
    try {
      const loaded = await cpuModuleLoaded();
      setCpuControlState(loaded);
      await refreshCpuPage();
    } catch (_) {}
    apply.disabled = false;
    cpuActionBusy = false;
  }
}

$('cpu-toggle').addEventListener('click', () => runCpuAction('off'));
$('cpu-apply').addEventListener('click', () => runCpuAction('on'));

// ---------------- GPU control ----------------
const GPU_PROC = '/proc/gpufreqv2';
const GPU_SAFE_IDX = 20; // stock working row, never touched by gpu_oc
const sleep = ms => new Promise(r => setTimeout(r, ms));
let gpuBusy = false;

async function gpuModuleLoaded() {
  return (await read("grep -q '^gpu_oc ' /proc/modules && echo yes || echo no")) === 'yes';
}
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
  if (!(await gpuModuleLoaded())) { await gpuUnpin().catch(() => {}); return; }
  await gpuPin(GPU_SAFE_IDX); // row 0 must not be in use while it is restored
  const r = await exec(CPU_MODULE_DIR + '/loader -r gpu_oc');
  if (!r || r.errno !== 0) throw new Error(r?.stderr || 'Could not unload gpu_oc');
  await gpuUnpin();
}
async function applyGpu() {
  const s = Number($('gpu-slider').value); // signed index 0..44
  const lock = $('gpu-lock-preview').checked;
  await unloadGpu();
  if (s <= 6) {
    await ensureLoaderExecutable();
    await gpuPin(GPU_SAFE_IDX);
    try {
      const r = await exec(CPU_MODULE_DIR + '/loader ' + CPU_MODULE_DIR + '/gpu_oc.ko apply=1 sidx=' + s);
      if (!r || r.errno !== 0) throw new Error(r?.stderr || 'gpu_oc load failed');
      const top = await read('head -1 ' + GPU_PROC + '/gpu_working_opp_table');
      const f = top.match(/freq:\s*(\d+)/);
      if (!f || Number(f[1]) !== GPU_OPP_MHZ[s] * 1000)
        throw new Error('gpu_oc did not apply (got ' + (f ? f[1] : 'unknown') + ')');
    } catch (e) {
      await exec(CPU_MODULE_DIR + '/loader -r gpu_oc').catch(() => {});
      await gpuUnpin().catch(() => {});
      throw e;
    }
    if (lock) await gpuPin(0); else await gpuUnpin();
  } else {
    if (!lock) throw new Error('At or below 1003 MHz is stock. Tick Fixed target to pin it.');
    await gpuPin(s - 7);
  }
}
async function runGpuAction(action) {
  if (gpuBusy) return;
  gpuBusy = true;
  const a = $('gpu-apply'), d = $('gpu-disable');
  a.disabled = true; d.disabled = true;
  show('gpu-control-status', action === 'off' ? 'Restoring…' : 'Applying…');
  try {
    if (action === 'off') { await unloadGpu(); show('gpu-control-status', 'GPU stock limits restored'); }
    else { await applyGpu(); show('gpu-control-status', 'Applied'); }
  } catch (e) {
    show('gpu-control-status', 'Action failed: ' + (e?.message || 'unknown error'));
  } finally {
    a.disabled = false; d.disabled = false; gpuBusy = false;
  }
}
$('gpu-apply').addEventListener('click', () => runGpuAction('on'));
$('gpu-disable').addEventListener('click', () => runGpuAction('off'));

refresh();
