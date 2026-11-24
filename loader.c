/* loader: strict module loading (flags=0) + passes kernel symbol addresses.
 *   ./loader cpu_oc.ko apply=1 big_khz=2300000
 *   ./loader -r cpu_oc
 * Run as root. Needs kptr_restrict=0 (it tries to set it itself). */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>

static unsigned long sym(const char *name)
{
	FILE *f = fopen("/proc/kallsyms", "r");
	char line[256], n[200], t;
	unsigned long a, r = 0;

	if (!f)
		return 0;
	while (fgets(line, sizeof(line), f))
		if (sscanf(line, "%lx %c %199s", &a, &t, n) == 3 && !strcmp(n, name)) {
			r = a;
			break;
		}
	fclose(f);
	return r;
}

int main(int argc, char **argv)
{
	char params[1024] = "";
	int fd, i, k;
	unsigned long g, p, q, an, rn;

	if (argc >= 3 && !strcmp(argv[1], "-r")) {
		if (syscall(SYS_delete_module, argv[2], 0)) {
			perror("delete_module");
			return 1;
		}
		puts("unloaded");
		return 0;
	}
	if (argc < 2) {
		fprintf(stderr, "usage: %s mod.ko [param=val ...] | -r name\n", argv[0]);
		return 1;
	}
	k = open("/proc/sys/kernel/kptr_restrict", O_WRONLY);
	if (k >= 0) {
		if (write(k, "0", 1) < 0)
			perror("kptr_restrict");
		close(k);
	}
	g = sym("cpufreq_cpu_get");
	p = sym("cpufreq_cpu_put");
	q = sym("freq_qos_update_request");
	an = sym("freq_qos_add_notifier");
	rn = sym("freq_qos_remove_notifier");
	if (!g || !p || !q) {
		fprintf(stderr, "symbols not found (need root)\n");
		return 1;
	}
	if (!an || !rn)
		fprintf(stderr, "note: notifier symbols not found, module will not react to resets\n");
	for (i = 2; i < argc; i++) {
		strncat(params, argv[i], sizeof(params) - strlen(params) - 2);
		strcat(params, " ");
	}
	snprintf(params + strlen(params), sizeof(params) - strlen(params),
		 "a_get=%lu a_put=%lu a_qos=%lu a_addn=%lu a_remn=%lu", g, p, q, an, rn);
	fd = open(argv[1], O_RDONLY);
	if (fd < 0) {
		perror("open");
		return 1;
	}
	if (syscall(SYS_finit_module, fd, params, 0)) {
		perror("finit_module");
		close(fd);
		return 1;
	}
	close(fd);
	puts("loaded, check: dmesg | grep cpu_oc");
	return 0;
}
