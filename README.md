HeiloG99 Control

A personal KernelSU module with a small WebUI for the MediaTek Helio G99 (MT6789), made for my own phone, a Samsung Galaxy A07 (SM-A075F).

«This is a personal hobby project. I built it for myself and published it as is. Read the disclaimer before using anything here.»

What it does

- Live readings: per-core CPU frequency, GPU frequency, RAM / ZRAM usage and temperature sensors.
- CPU control ("cpu_oc"): raises the maximum frequency of the little and big clusters, up to 400 MHz above stock. It changes the frequency only. It does not change the voltage.
- GPU control ("gpu_oc"): unlocks the top GPU rows (1017-1100 MHz) that the driver hides on this chip and holds the GPU at the frequency you choose. These rows and their voltages come from the factory table. Nothing is invented.
- ZRAM algorithm switch: change between LZ4, LZ4-RLE and ZSTD with a free-RAM check and automatic rollback.
- Everything is runtime only. A reboot restores stock behavior. The WebUI also has Restore stock buttons.

Kernel base

The modules are built against Samsung's open-source kernel release for the SM-A075F (Android 16 package, kernel 6.12), downloaded by the GitHub Actions workflow.

My phone runs a newer firmware build than that source ("6.12.69-android16-6-abA075FXXU7DZJ5-4k"). It is not an exact match, but it still loads and works on my device. This works because "device.symvers" holds symbol CRCs extracted from the modules on my own phone.

Because the source is not an exact match, do not assume this works on any other build or device.

Tested only on

| 
Device| Samsung Galaxy A07 (SM-A075F)
SoC| MediaTek Helio G99 (MT6789)
Kernel| 6.12.69-android16-6-abA075FXXU7DZJ5-4k
Root| KernelSU

Anything else is untested. Please do not use it on other phones.

Disclaimer

- Use at your own risk. Overclocking goes beyond the manufacturer's specifications. It can cause freezes, reboots, bootloops, data loss, overheating, faster battery wear, hardware damage and a voided warranty.
- I am not responsible for any problem that happens to your device or data as a result of using this project, its code, its builds or its instructions.
- The CPU values I use (little 2400 MHz, big 2500 MHz) are personal test values. Your phone may freeze, become unstable or reboot when running at high frequencies. These values are not verified safe and may not be stable on your chip.
- This code writes to kernel memory and hardware tables. Back up your boot images before trying anything.

Support

This is a personal project, so there is no guarantee of support. If you find a problem in the project, I might fix it, but I can't promise that I will or when.

Install

1. Run the build-cpu-oc workflow in the Actions tab (it also runs on every push to "main").
2. Download the artifact "HelioG99-Control-WebUI-KSU".
3. Install the zip from KernelSU Manager and reboot.
4. Open the module's WebUI.

Recovery

- Press Restore stock on the CPU and GPU pages, or just reboot.
- If the phone freezes due to unstable frequencies, it will usually restart automatically. If it does not restart, try to restart it manually. Nothing is written to the system partitions.
- To remove it completely, delete "/data/adb/modules/heilog99_control" and reboot. The module also creates "/data/adb/heilog99_control.conf" (saved WebUI settings) and "/data/adb/heilog99-zram.*" (ZRAM switch files), which you can delete.

Files

File| Purpose
"cpu_oc.c"| Kernel module: CPU max-frequency raise
"gpu_oc.c"| Kernel module: GPU frequency rows
"loader.c"| Loads the modules and passes kernel symbol addresses
"device.symvers"| Symbol CRCs extracted from the phone's own modules
"a07_config"| Kernel config used for building
"webroot/"| The WebUI
"service.sh"| Boot script: removes leftover state
".github/workflows/build.yml"| Build and packaging

License

The kernel modules are GPL-2.0 (see the SPDX headers in the source files). Everything is provided as is, without any warranty.
