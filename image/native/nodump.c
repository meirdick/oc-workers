// nodump.so: LD_PRELOAD shim that makes a process non-dumpable before main() (scope §1.1 row
// "Image" [Z2.5, Z1.15]; M0 T2 item 7: dumpable 0 hides /proc/<pid>/environ and mem from uid 1000
// and blocks ptrace without CAP_SYS_PTRACE). execve resets the flag, so the preload must be in the
// env of the exec'd program; unpreload.mjs removes it for the gateway's children.
//
// M4b (M4 security review S1, S2): exec scrub below the gateway. unpreload.mjs hooks child_process in each
// node process, but native code (node-pty forkpty + execvp for exec {pty:true}) and spawn paths the JS hook
// does not see (S2: a post-wake sqlite worker) exec with the gateway env. In a process whose start env has
// OCHOST_EXEC_SCRUB (ocsup sets it only in the gateway env, and it is kept in every child), each exec*() and
// posix_spawn*() here gets an env without: OC_*, OPENCLAW_GATEWAY_TOKEN|PASSWORD, names in OCHOST_SCRUB,
// MALLOC_CONF, and any value that holds a secret value seen at start; names in OCHOST_REFS come back as the
// placeholder "ochost-scrubbed"; LD_PRELOAD keeps this file and drops jemalloc. No malloc in the hooks (a
// vfork or fork child of a threaded process may call them): the new env lives on the stack.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

extern char **environ;

#define NODUMP_PATH "/opt/ocrt/nodump.so"
#define PLACEHOLDER "ochost-scrubbed"
#define MAX_LIST 64
#define MIN_SECRET 8

static int active;
static const char *secrets[MAX_LIST];
static int nsecrets;
static const char *names[MAX_LIST]; /* OCHOST_SCRUB */
static int nnames;
static const char *refs[MAX_LIST]; /* "NAME=ochost-scrubbed" */
static size_t reflen[MAX_LIST];    /* length of NAME */
static int nrefs;

typedef int (*execve_t)(const char *, char *const[], char *const[]);
typedef int (*execvpe_t)(const char *, char *const[], char *const[]);
typedef int (*fexecve_t)(int, char *const[], char *const[]);
typedef int (*execveat_t)(int, const char *, char *const[], char *const[], int);
typedef int (*pspawn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *,
                        char *const[], char *const[]);
static execve_t r_execve;
static execvpe_t r_execvpe;
static fexecve_t r_fexecve;
static execveat_t r_execveat;
static pspawn_t r_spawn, r_spawnp;

static int name_is(const char *e, const char *n) {
  size_t l = strlen(n);
  return strncmp(e, n, l) == 0 && e[l] == '=';
}

static int listed(const char *e, size_t nl) {
  for (int i = 0; i < nnames; i++)
    if (strlen(names[i]) == nl && strncmp(e, names[i], nl) == 0) return 1;
  return 0;
}

static int secret_name(const char *e, size_t nl) {
  if (nl > 3 && strncmp(e, "OC_", 3) == 0) return 1;
  if (name_is(e, "OPENCLAW_GATEWAY_TOKEN") || name_is(e, "OPENCLAW_GATEWAY_PASSWORD")) return 1;
  return listed(e, nl);
}

/* Comma list → strdup'ed items (constructor only). */
static int split(const char *v, const char **out, int max) {
  int n = 0;
  if (!v) return 0;
  char *c = strdup(v);
  if (!c) return 0;
  for (char *s = strtok(c, ","); s && n < max; s = strtok(NULL, ","))
    if (*s) out[n++] = s;
  return n;
}

__attribute__((constructor)) static void ocrt_nodump(void) {
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  r_execve = (execve_t)dlsym(RTLD_NEXT, "execve");
  r_execvpe = (execvpe_t)dlsym(RTLD_NEXT, "execvpe");
  r_fexecve = (fexecve_t)dlsym(RTLD_NEXT, "fexecve");
  r_execveat = (execveat_t)dlsym(RTLD_NEXT, "execveat");
  r_spawn = (pspawn_t)dlsym(RTLD_NEXT, "posix_spawn");
  r_spawnp = (pspawn_t)dlsym(RTLD_NEXT, "posix_spawnp");
  if (!getenv("OCHOST_EXEC_SCRUB")) return;
  nnames = split(getenv("OCHOST_SCRUB"), names, MAX_LIST);
  const char *rl[MAX_LIST];
  int nr = split(getenv("OCHOST_REFS"), rl, MAX_LIST);
  for (int i = 0; i < nr; i++) {
    size_t l = strlen(rl[i]);
    char *s = malloc(l + sizeof(PLACEHOLDER) + 1);
    if (!s) continue;
    memcpy(s, rl[i], l);
    s[l] = '=';
    memcpy(s + l + 1, PLACEHOLDER, sizeof(PLACEHOLDER));
    refs[nrefs] = s;
    reflen[nrefs++] = l;
  }
  for (char **e = environ; e && *e && nsecrets < MAX_LIST; e++) {
    const char *eq = strchr(*e, '=');
    if (!eq || !secret_name(*e, (size_t)(eq - *e))) continue;
    if (strlen(eq + 1) >= MIN_SECRET && strcmp(eq + 1, PLACEHOLDER) != 0) secrets[nsecrets++] = strdup(eq + 1);
  }
  active = 1;
}

static int has_secret(const char *v) {
  for (int i = 0; i < nsecrets; i++)
    if (secrets[i] && strstr(v, secrets[i])) return 1;
  return 0;
}

/* Fill out (cap entries) with the scrubbed env; pre = buffer for the LD_PRELOAD entry. */
static void scrub(char *const *envp, char **out, size_t cap, char *pre, size_t precap) {
  size_t n = 0;
  const char *ld = NULL;
  for (char *const *e = envp; e && *e && n + 1 < cap; e++) {
    const char *eq = strchr(*e, '=');
    if (!eq) continue;
    size_t nl = (size_t)(eq - *e);
    if (secret_name(*e, nl) || name_is(*e, "MALLOC_CONF")) continue;
    if (name_is(*e, "LD_PRELOAD")) {
      ld = eq + 1;
      continue;
    }
    if (has_secret(eq + 1)) continue;
    out[n++] = *e;
  }
  for (int i = 0; i < nrefs && n + 1 < cap; i++) {
    if (!secret_name(refs[i], reflen[i])) continue;
    int seen = 0;
    for (size_t j = 0; j < n; j++)
      if (strncmp(out[j], refs[i], reflen[i] + 1) == 0) seen = 1;
    if (!seen) out[n++] = (char *)refs[i];
  }
  /* LD_PRELOAD=nodump[:others without jemalloc and without nodump] */
  size_t p = 0;
  const char *head = "LD_PRELOAD=" NODUMP_PATH;
  size_t hl = strlen(head);
  if (hl < precap) {
    memcpy(pre, head, hl);
    p = hl;
    for (const char *s = ld; s && *s;) {
      size_t l = strcspn(s, ": ");
      int skip = l == 0 || (l == strlen(NODUMP_PATH) && strncmp(s, NODUMP_PATH, l) == 0) ||
                 memmem(s, l, "libjemalloc", 11) != NULL;
      if (!skip && p + 1 + l < precap) {
        pre[p++] = ':';
        memcpy(pre + p, s, l);
        p += l;
      }
      s += l;
      while (*s == ':' || *s == ' ') s++;
    }
    pre[p] = 0;
    if (n + 1 < cap) out[n++] = pre;
  }
  out[n] = NULL;
}

static size_t count(char *const *envp) {
  size_t n = 0;
  while (envp && envp[n]) n++;
  return n;
}

#define SCRUBBED(envp, var)                    \
  size_t cap_ = count(envp) + nrefs + 2;      \
  char *var##_buf[cap_];                       \
  char pre_[2048];                             \
  char **var = (char **)(envp);                \
  if (active) {                                \
    scrub(envp, var##_buf, cap_, pre_, sizeof pre_); \
    var = var##_buf;                           \
  }

int execve(const char *path, char *const argv[], char *const envp[]) {
  SCRUBBED(envp, ne);
  return r_execve(path, argv, ne);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
  SCRUBBED(envp, ne);
  return r_execvpe(file, argv, ne);
}

int execv(const char *path, char *const argv[]) { return execve(path, argv, environ); }

int execvp(const char *file, char *const argv[]) { return execvpe(file, argv, environ); }

int fexecve(int fd, char *const argv[], char *const envp[]) {
  SCRUBBED(envp, ne);
  return r_fexecve(fd, argv, ne);
}

int execveat(int dirfd, const char *path, char *const argv[], char *const envp[], int flags) {
  SCRUBBED(envp, ne);
  return r_execveat(dirfd, path, argv, ne, flags);
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *at,
                char *const argv[], char *const envp[]) {
  SCRUBBED(envp, ne);
  return r_spawn(pid, path, fa, at, argv, ne);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *at, char *const argv[], char *const envp[]) {
  SCRUBBED(envp, ne);
  return r_spawnp(pid, file, fa, at, argv, ne);
}
