// SPDX-License-Identifier: GPL-2.0
/*
 * cpu_oc - experimental CPU max-frequency raise for MT6789 (Helio G99), Galaxy A07.
 * UNTESTED. Default is dry-run (apply=0): it only prints what it finds to dmesg.
 *
 * Params:
 *   apply=1          really change things (default 0 = dump only)
 *   little_khz=N     new max for policy0 (CPU0..5)   e.g. 2100000
 *   big_khz=N        new max for policy6 (CPU6..7)   e.g. 2300000
 *   a_get/a_put/a_qos  kernel symbol addresses, filled in by the loader
 */
#define pr_fmt(fmt) "cpu_oc: " fmt

#include <linux/module.h>
#include <linux/cpufreq.h>
#include <linux/pm_qos.h>
#include <linux/plist.h>
#include <linux/io.h>

#define LUT_ROWS	32
#define LUT_SIZE	0x120
#define LUT_FREQ_MASK	0xfffU		/* MHz in bits 11:0 */
#define MAX_REQ		16
#define MAX_STEP_KHZ	400000		/* safety: refuse bigger jumps */

static bool apply;
static ulong little_khz, big_khz, a_get, a_put, a_qos;
module_param(apply, bool, 0444);
module_param(little_khz, ulong, 0444);
module_param(big_khz, ulong, 0444);
module_param(a_get, ulong, 0444);
module_param(a_put, ulong, 0444);
module_param(a_qos, ulong, 0444);

static struct cpufreq_policy *(*p_get)(unsigned int cpu);
static void (*p_put)(struct cpufreq_policy *policy);
static int (*p_qos)(struct freq_qos_request *req, s32 value);

struct dom {
	int cpu;
	phys_addr_t lut_pa;
	ulong *new_khz;
	struct cpufreq_policy *pol;
	struct cpufreq_frequency_table *ent;
	void __iomem *lut;
	unsigned int old_khz;
	int lut_row;
	u32 lut_orig;
	bool applied;
};

static struct dom doms[2] = {
	{ .cpu = 0, .lut_pa = 0x11bc10, .new_khz = &little_khz, .lut_row = -1 },
	{ .cpu = 6, .lut_pa = 0x11bd30, .new_khz = &big_khz,    .lut_row = -1 },
};

/* NOTE: walks the QoS list without the (private) pm_qos lock. Racy but short. */
static int collect(struct cpufreq_policy *p, s32 prio,
		   struct freq_qos_request **out, bool dump)
{
	struct freq_qos_request *r;
	int n = 0;

	plist_for_each_entry(r, &p->constraints.max_freq.list, pnode) {
		if (dump)
			pr_info("  qos max req %px prio=%d\n", r, r->pnode.prio);
		if (r->pnode.prio == prio && n < MAX_REQ)
			out[n++] = r;
	}
	return n;
}

static void retarget(struct cpufreq_policy *p, s32 from, s32 to)
{
	struct freq_qos_request *reqs[MAX_REQ];
	int i, n = collect(p, from, reqs, false);

	for (i = 0; i < n; i++) {
		int ret = p_qos(reqs[i], to);

		pr_info("  qos %px %d -> %d (ret=%d)\n", reqs[i], from, to, ret);
	}
}

static int dom_setup(struct dom *d)
{
	struct cpufreq_policy *p = p_get(d->cpu);
	struct cpufreq_frequency_table *pos;
	struct freq_qos_request *tmp[MAX_REQ];
	ulong newk = *d->new_khz;
	int i;

	if (!p) {
		pr_err("cpu%d: no policy\n", d->cpu);
		return -ENODEV;
	}
	d->pol = p;
	d->old_khz = p->cpuinfo.max_freq;
	pr_info("cpu%d: cpuinfo max=%u cur max=%u\n", d->cpu, d->old_khz, p->max);

	for (pos = p->freq_table; pos->frequency != CPUFREQ_TABLE_END; pos++) {
		pr_info("  table %u\n", pos->frequency);
		if (!d->ent && pos->frequency == d->old_khz)
			d->ent = pos;
	}

	d->lut = ioremap(d->lut_pa, LUT_SIZE);
	if (d->lut) {
		for (i = 0; i < LUT_ROWS; i++)
			pr_info("  lut[%d]=%08x f=%uMHz\n", i,
				readl(d->lut + i * 4),
				readl(d->lut + i * 4) & LUT_FREQ_MASK);
	}
	collect(p, d->old_khz, tmp, true);

	if (!apply || !newk)
		return 0;
	if (newk <= d->old_khz || newk > d->old_khz + MAX_STEP_KHZ || !d->ent) {
		pr_err("cpu%d: refusing new=%lu old=%u ent=%px\n",
		       d->cpu, newk, d->old_khz, d->ent);
		return 0;
	}

	if (d->lut) {
		for (i = 0; i < LUT_ROWS; i++) {
			u32 v = readl(d->lut + i * 4);

			if ((v & LUT_FREQ_MASK) == d->old_khz / 1000) {
				d->lut_row = i;
				d->lut_orig = v;
				writel((v & ~LUT_FREQ_MASK) | (newk / 1000),
				       d->lut + i * 4);
				break;
			}
		}
	}
	d->ent->frequency = newk;
	p->cpuinfo.max_freq = newk;
	retarget(p, d->old_khz, newk);
	d->applied = true;
	pr_info("cpu%d: applied %u -> %lu kHz (lut row %d)\n",
		d->cpu, d->old_khz, newk, d->lut_row);
	return 0;
}

static void dom_restore(struct dom *d)
{
	if (!d->pol)
		return;
	if (d->applied) {
		retarget(d->pol, *d->new_khz, d->old_khz);
		d->ent->frequency = d->old_khz;
		d->pol->cpuinfo.max_freq = d->old_khz;
		if (d->lut && d->lut_row >= 0)
			writel(d->lut_orig, d->lut + d->lut_row * 4);
	}
	if (d->lut)
		iounmap(d->lut);
	p_put(d->pol);
}

static int __init oc_init(void)
{
	int i;

	if (!a_get || !a_put || !a_qos) {
		pr_err("symbol addresses missing, use the loader\n");
		return -EINVAL;
	}
	p_get = (void *)a_get;
	p_put = (void *)a_put;
	p_qos = (void *)a_qos;

	pr_info("apply=%d little=%lu big=%lu\n", apply, little_khz, big_khz);
	for (i = 0; i < 2; i++)
		dom_setup(&doms[i]);
	return 0;
}

static void __exit oc_exit(void)
{
	int i;

	for (i = 1; i >= 0; i--)
		dom_restore(&doms[i]);
	pr_info("restored\n");
}

module_init(oc_init);
module_exit(oc_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("experimental MT6789 cpu max freq raise (dry-run by default)");
