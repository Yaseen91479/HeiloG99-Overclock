// SPDX-License-Identifier: GPL-2.0
/*
 * gpu_oc - step 1: dump only. Changes nothing.
 * Prints raw bytes of the mtk_gpufreq_mt6789 g_gpu structs to dmesg so we can
 * locate working_table / signed_table pointers and the opp counts (38 / 45).
 *
 *   ./loader gpu_oc.ko a1=0xADDR1 a2=0xADDR2
 *   dmesg | grep gpu_oc
 *   ./loader -r gpu_oc
 */
#define pr_fmt(fmt) "gpu_oc: " fmt
#include <linux/module.h>
#include <linux/printk.h>

static ulong a1, l1 = 0xd0, a2, l2 = 0x1c;
/* the loader always passes these; unused here but must be accepted */
static ulong a_get, a_put, a_qos, a_addn, a_remn;
module_param(a1, ulong, 0444);
module_param(l1, ulong, 0444);
module_param(a2, ulong, 0444);
module_param(l2, ulong, 0444);
module_param(a_get, ulong, 0444);
module_param(a_put, ulong, 0444);
module_param(a_qos, ulong, 0444);
module_param(a_addn, ulong, 0444);
module_param(a_remn, ulong, 0444);

static void dump(ulong a, ulong l)
{
	if (!a || !l || l > 0x200)
		return;
	pr_info("dump @%lx len %lx\n", a, l);
	print_hex_dump(KERN_INFO, "gpu_oc: ", DUMP_PREFIX_OFFSET, 16, 4,
		       (void *)a, l, false);
}

static int __init g_init(void)
{
	dump(a1, l1);
	dump(a2, l2);
	return 0;
}

static void __exit g_exit(void)
{
}

module_init(g_init);
module_exit(g_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("MT6789 gpufreq dump (read-only)");
