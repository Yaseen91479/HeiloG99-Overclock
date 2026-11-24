
/* loader: strict module loading with kernel symbol addresses.
 * ./loader cpu_oc.ko apply=0 big_khz=2300000 little_khz=2100000
 * ./loader -r cpu_oc
 * Run as root.
 */
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
        if (sscanf(line, "%lx %c %199s", &a, &t, n) == 3 &&
            !strcmp(n, name)) {
            r = a;
            break;
        }

    fclose(f);
    return r;
}

int main(int argc, char **argv)
{
    char params[1024] = "";
    int fd, i;
    unsigned long g, p, q;

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

    g = sym("cpufreq_cpu_get");
    p = sym("cpufreq_cpu_put");
    q = sym("freq_qos_update_request");

    if (!g || !p || !q) {
        fprintf(stderr, "symbols not found (need root)\n");
        return 1;
    }

    for (i = 2; i < argc; i++) {
        strncat(params, argv[i], sizeof(params) - strlen(params) - 2);
        strcat(params, " ");
    }

    snprintf(params + strlen(params),
             sizeof(params) - strlen(params),
             "a_get=%lu a_put=%lu a_qos=%lu", g, p, q);

    fd = open(argv[1], O_RDONLY);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    /* Strict compatibility checks: no ignored modversions or vermagic */
    if (syscall(SYS_finit_module, fd, params, 0)) {
        perror("finit_module");
        close(fd);
        return 1;
    }

    close(fd);
    puts("loaded, check: dmesg | grep cpu_oc");
    return 0;
}
