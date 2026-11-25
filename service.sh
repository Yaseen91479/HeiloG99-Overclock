#!/system/bin/sh
# Re-apply executable permissions after every boot.
MODDIR="${0%/*}"
chmod 0755 "$MODDIR/loader" 2>/dev/null

# Never leave this module active after boot. Its exit routine restores
# the saved CPU policy limits and LUT entries.
if grep -q '^cpu_oc ' /proc/modules 2>/dev/null; then
  "$MODDIR/loader" -r cpu_oc >/dev/null 2>&1
fi
