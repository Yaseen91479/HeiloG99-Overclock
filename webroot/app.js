import { exec } from 'kernelsu';

const $ = (id) => document.getElementById(id);
const show = (id, value) => { $(id).textContent = value; };
function updatePreviewSlider(sliderId, valueId, warningId, threshold) {
  const slider = $(sliderId);
  const value = Number(slider.value);
  show(valueId, value + ' MHz');
  $(warningId).hidden = value <= threshold;
}
$('little-slider').addEventListener('input', () => updatePreviewSlider('little-slider','little-selected','little-warning',2300));
$('big-slider').addEventListener('input', () => updatePreviewSlider('big-slider','big-selected','big-warning',2500));
$('gpu-slider').addEventListener('input', () => show('gpu-selected', Number($('gpu-slider').value) + ' MHz'));
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
    const cpuLoaded = moduleRaw.split('\n').some(line=>line.startsWith('cpu_oc '));
    const gpuLoaded = moduleRaw.split('\n').some(line=>line.startsWith('gpu_oc '));
      show('gpu-module',gpuLoaded?'Loaded':'Not loaded');
    show('gpu-page-status',gpuLoaded?'gpu_oc.ko is listed in /proc/modules.':'gpu_oc.ko is not listed in /proc/modules.');
    show('connection','Connected · read-only data');
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
  toggle.textContent = loaded ? 'Disable CPU OC' : 'Enable CPU OC';
  toggle.classList.toggle('active', loaded);
}

async function cpuModuleLoaded() {
  return (await read("if grep -q '^cpu_oc ' /proc/modules; then echo yes; else echo no; fi")) === 'yes';
}

const CPU_LOCK_STATE = CPU_MODULE_DIR + '/.cpu-frequency-lock-state';

async function restoreCpuFrequencyLock() {
  const state = await read('if [ -f ' + CPU_LOCK_STATE + ' ]; then cat ' + CPU_LOCK_STATE + '; fi');
  if (!state) return;
  const values = state.split(/\r?\n/).map(Number);
  if (values.length !== 4 || values.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error('Saved CPU frequency state is invalid');
  }
  const [min0, max0, min6, max6] = values;
  await read('echo ' + max0 + ' > /sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq && ' +
    'echo ' + min0 + ' > /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq && ' +
    'echo ' + max6 + ' > /sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq && ' +
    'echo ' + min6 + ' > /sys/devices/system/cpu/cpufreq/policy6/scaling_min_freq && rm -f ' + CPU_LOCK_STATE);
}

async function lockCpuFrequencies(littleKhz, bigKhz) {
  const raw = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s\\n' \"$(cat $p/scaling_min_freq)\" \"$(cat $p/scaling_max_freq)\"; done");
  const values = raw.split(/\r?\n/).map(Number);
  if (values.length !== 4 || values.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error('Could not read current CPU frequency limits');
  }
  await read('printf \\'%s\\n\\' ' + values.join(' ') + ' > ' + CPU_LOCK_STATE);
  try {
    await read('echo ' + littleKhz + ' > /sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq && ' +
      'echo ' + littleKhz + ' > /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq && ' +
      'echo ' + bigKhz + ' > /sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq && ' +
      'echo ' + bigKhz + ' > /sys/devices/system/cpu/cpufreq/policy6/scaling_min_freq');
    const check = await read("for n in policy0 policy6; do p=/sys/devices/system/cpu/cpufreq/$n; printf '%s\\n' \"$(cat $p/scaling_min_freq)\" \"$(cat $p/scaling_max_freq)\"; done");
    if (check !== [littleKhz, littleKhz, bigKhz, bigKhz].join('\n')) {
      throw new Error('The kernel did not accept the exact locked frequencies');
    }
  } catch (error) {
    await restoreCpuFrequencyLock().catch(() => {});
    throw error;
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

async function getStockCpuMaxima() {
  const raw = await read("for n in policy0 policy6; do f=/sys/devices/system/cpu/cpufreq/$n/cpuinfo_max_freq; [ -r \"$f\" ] && printf '%s:%s\\n' \"$n\" \"$(cat \"$f\")\"; done");
  const values = Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map(line => {
    const i = line.indexOf(':'); return [line.slice(0, i), Number(line.slice(i + 1))];
  }));
  if (!Number.isFinite(values.policy0) || !Number.isFinite(values.policy6)) {
    throw new Error('Could not read the Little/Big CPU policy maximums');
  }
  return values;
}

async function loadCpuModule() {
  const littleMhz = Number($('little-slider').value);
  const bigMhz = Number($('big-slider').value);
  if (!Number.isInteger(littleMhz) || !Number.isInteger(bigMhz)) {
    throw new Error('Select valid whole-number CPU frequencies');
  }

  const stock = await getStockCpuMaxima();
  const littleKhz = littleMhz * 1000;
  const bigKhz = bigMhz * 1000;
  if (littleKhz <= stock.policy0 || littleKhz > stock.policy0 + 400000) {
    throw new Error('Little must be above its current maximum and no more than +400 MHz (' +
      (stock.policy0 / 1000).toFixed(0) + '–' + ((stock.policy0 + 400000) / 1000).toFixed(0) + ' MHz)');
  }
  if (bigKhz <= stock.policy6 || bigKhz > stock.policy6 + 400000) {
    throw new Error('Big must be above its current maximum and no more than +400 MHz (' +
      (stock.policy6 / 1000).toFixed(0) + '–' + ((stock.policy6 + 400000) / 1000).toFixed(0) + ' MHz)');
  }

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
    await unloadCpuModule();
    throw new Error('Module loaded, but both requested CPU maximums were not confirmed; module was unloaded');
  }
  if ($('cpu-lock-frequency').checked) {
    await lockCpuFrequencies(littleKhz, bigKhz);
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
    toggle.disabled = false;
    apply.disabled = false;
    cpuActionBusy = false;
  }
}

$('cpu-toggle').addEventListener('click', async () => {
  const loaded = await cpuModuleLoaded().catch(() => false);
  await runCpuAction(loaded ? 'off' : 'on');
});
$('cpu-apply').addEventListener('click', () => runCpuAction('on'));

refresh();