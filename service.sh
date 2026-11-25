#!/system/bin/sh
MODDIR="${0%/*}"
STATE="$MODDIR/.cpu-frequency-lock-state"

chmod 0755 "$MODDIR/loader" 2>/dev/null

if grep -q '^cpu_oc ' /proc/modules 2>/dev/null; then
  "$MODDIR/loader" -r cpu_oc >/dev/null 2>&1
fi

if [ -f "$STATE" ]; then
  set -- $(cat "$STATE")
  if [ "$#" -eq 4 ]; then
    case "$1$2$3$4" in
      *[!0-9]*) ;;
      *)
        echo "$2" > /sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq 2>/dev/null
        echo "$1" > /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq 2>/dev/null
        echo "$4" > /sys/devices/system/cpu/cpufreq/policy6/scaling_max_freq 2>/dev/null
        echo "$3" > /sys/devices/system/cpu/cpufreq/policy6/scaling_min_freq 2>/dev/null
        ;;
    esac
  fi
  rm -f "$STATE"
fi
