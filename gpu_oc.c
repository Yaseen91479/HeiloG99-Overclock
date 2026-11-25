// SPDX-License-Identifier: GPL-2.0
/*
 * gpu_oc step 2: identify working/signed OPP tables of g_gpu and (optionally)
 * replace working[0] (1003MHz) with a signed row 0..6 (1100..1017MHz).
 * Default is dry-run. Everything is in memory only; unload restores it.
 *
 *   ./loader gpu_oc.ko a1=0xG_GPU_ADDR               (dry-run)
 *   ./loader gpu_oc.ko a1=0xG_GPU_ADDR apply=1 sidx=6
 *   ./loader -r gpu_oc
 */
#define pr_fmt(fmt) "gpu_oc: " fmt
#include <linux/module.h>
#include <linux/printk.h>

struct row {
	u32 freq, volt, vsram, posdiv, margin, power;
};

static ulong a1;
static bool apply;
static uint sidx = 6;
/* the loader always passes these; unused */
static ulong a_get, a_put, a_qos, a_addn, a_remn;
module_param(a1, ulong, 0444);
module_param(apply, bool, 0444);
module_param(sidx, uint, 0444);
module_param(a_get, ulong, 0444);
module_param(a_put, ulong, 0444);
module_param(a_qos, ulong, 0444);
module_param(a_addn, ulong, 0444);
module_param(a_remn, ulong, 0444);

static struct row *wt, *st;
static struct row orig;
static bool applied;

static bool okp(ulong p)
{
	return p >= 0xffffff0000000000UL && !(p & 3);
}

static int __init g_init(void)
{
	u32 snum, wnum;
	int i;

	if (!a1) {
		pr_err("need a1 (g_gpu address)\n");
		return -EINVAL;
	}
	snum = *(volatile u32 *)(a1 + 0x2c);
	wnum = *(volatile u32 *)(a1 + 0x38);
	pr_info("signed_num=%u working_num=%u\n", snum, wnum);

	for (i = 0; i < 3; i++) {
		ulong p = *(volatile ulong *)(a1 + i * 8);
		struct row *c;

		if (!okp(p)) {
			pr_info("ptr%d %lx skipped\n", i, p);
			continue;
		}
		c = (struct row *)p;
		pr_info("ptr%d %lx: %u/%u %u/%u %u/%u\n", i, p,
			c[0].freq, c[0].volt, c[1].freq, c[1].volt,
			c[2].freq, c[2].volt);
		if (!wt && c[0].freq == 1003000 && c[0].volt == 77500)
			wt = c;
		else if (!st && c[0].freq == 1100000 && c[0].volt == 81250)
			st = c;
	}
	pr_info("working=%px signed=%px\n", wt, st);

	if (!apply) {
		pr_info("dry-run, nothing changed\n");
		return 0;
	}
	if (!wt || !st || snum != 45 || wnum != 38 || sidx > 6) {
		pr_err("refusing: tables not identified or bad sidx\n");
		return 0;
	}
	if (st[sidx].freq < 1017000 || st[sidx].freq > 1100000 ||
	    st[sidx].volt < 77500 || st[sidx].volt > 81250) {
		pr_err("refusing: signed row %u looks wrong\n", sidx);
		return 0;
	}
	orig = wt[0];
	/* voltage first, frequency last */
	WRITE_ONCE(wt[0].volt, st[sidx].volt);
	WRITE_ONCE(wt[0].vsram, st[sidx].vsram);
	WRITE_ONCE(wt[0].posdiv, st[sidx].posdiv);
	WRITE_ONCE(wt[0].freq, st[sidx].freq);
	applied = true;
	pr_info("working[0]: %u/%u -> %u/%u\n", orig.freq, orig.volt,
		st[sidx].freq, st[sidx].volt);
	return 0;
}

static void __exit g_exit(void)
{
	if (applied) {
		/* frequency first, voltage last */
		WRITE_ONCE(wt[0].freq, orig.freq);
		WRITE_ONCE(wt[0].posdiv, orig.posdiv);
		WRITE_ONCE(wt[0].vsram, orig.vsram);
		WRITE_ONCE(wt[0].volt, orig.volt);
		pr_info("restored working[0]\n");
	}
}

module_init(g_init);
module_exit(g_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("MT6789 gpu OPP experiment (dry-run by default)");
