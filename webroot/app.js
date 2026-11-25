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
    show('cpu-module',cpuLoaded?'Loaded':'Not loaded');
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
    const [raw, ocRaw] = await Promise.all([
      read("for p in /sys/devices/system/cpu/cpufreq/policy*; do [ -d \"$p\" ] || continue; printf '%s|%s|%s|%s|%s\\n' \"$(basename \"$p\")\" \"$(cat \"$p/related_cpus\" 2>/dev/null)\" \"$(cat \"$p/scaling_cur_freq\" 2>/dev/null)\" \"$(cat \"$p/scaling_min_freq\" 2>/dev/null)\" \"$(cat \"$p/scaling_max_freq\" 2>/dev/null)\"; done"),
      read("if grep -q '^cpu_oc ' /proc/modules; then printf 'loaded\\n'; else printf 'not_loaded\\n'; fi; for n in apply little_khz big_khz resets; do f=/sys/module/cpu_oc/parameters/$n; if [ -r \"$f\" ]; then printf '%s=%s\\n' \"$n\" \"$(cat \"$f\")\"; else printf '%s=unavailable\\n' \"$n\"; fi; done")
    ]);
    const ocLines = ocRaw.split(/\r?\n/).filter(Boolean);
    const ocLoaded = ocLines[0] === 'loaded';
    show('cpu-oc-status',ocLoaded?'cpu_oc.ko is loaded':'cpu_oc.ko is not loaded');
    const ocValues = Object.fromEntries(ocLines.slice(1).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
    const mode = ocValues.apply === '1' ? 'Apply flag: enabled' : ocValues.apply === '0' ? 'Apply flag: dry-run' : 'Apply flag: unavailable';
    const khz = v => v && v !== 'unavailable' && /^\d+$/.test(v) ? (Number(v)/1000).toFixed(0)+' MHz' : 'Unavailable';
    show('cpu-oc-settings',ocLoaded ? mode+'\nLittle configured: '+khz(ocValues.little_khz)+'\nBig configured: '+khz(ocValues.big_khz)+'\nReset counter: '+(ocValues.resets ?? 'Unavailable') : 'Module parameters are available only while cpu_oc.ko is loaded.');
    const lines = raw.split(/\r?\n/).filter(Boolean).map(line => {
      const [policy, cpus, cur, min, max] = line.split('|');
      const mhz = value => Number.isFinite(Number(value)) ? (Number(value)/1000).toFixed(0)+' MHz' : '--';
      return policy+' · CPUs '+(cpus || 'unknown')+'\nCurrent: '+mhz(cur)+'   Min: '+mhz(min)+'   Max: '+mhz(max);
    });
    show('cpu-page-readings',lines.length ? lines.join('\n\n') : 'No CPU frequency policies found');
    const byPolicy = Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map(line => { const [policy, cpus, cur, min, max] = line.split('|'); return [policy,{cpus,cur,min,max}]; }));
    const clusterText = value => value && /^\d+$/.test(value) ? (Number(value)/1000).toFixed(0)+' MHz' : 'Unavailable';
    const little = byPolicy.policy0, big = byPolicy.policy6;
    show('little-current',little ? clusterText(little.cur) : '-- MHz');
    show('little-meta',little ? 'CPUs '+(little.cpus||'—')+'\nMin: '+clusterText(little.min)+' · Max: '+clusterText(little.max) : 'Policy 0 unavailable');
    show('big-current',big ? clusterText(big.cur) : '-- MHz');
    show('big-meta',big ? 'CPUs '+(big.cpus||'—')+'\nMin: '+clusterText(big.min)+' · Max: '+clusterText(big.max) : 'Policy 6 unavailable');
    show('cpu-page-updated','Live · refreshed '+new Date().toLocaleTimeString()+' · pauses when this page is closed or hidden');
  } catch (error) {
    show('cpu-page-readings','Read failed: '+(error?.message || 'unknown error'));
    show('cpu-page-updated','CPU readings unavailable');
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
refresh();
