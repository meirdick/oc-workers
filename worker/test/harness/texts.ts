// Platform texts recorded in M0 (spike/results/M0-STATUS.md T1 item 1, T7c, T7e) and spec §8.4/§9.1
// regexes. A text marked guess has no recording yet; T1 settles it.
export const TEXT = {
  /** SIGKILL of ocsup, reject 0.43 s after the kill (M0 T1 item 1, T7e row 6). */
  exit137: "Container exited with unexpected exit code: 137",
  exitCode: (n: number) => `Container exited with unexpected exit code: ${n}`,
  /** destroy(): monitor() resolves, empty text (T7c(4)). Use resolve, not a text. */
  destroyResolve: "",
  /** guess: §9.1 regex only. */
  signalled: "The runtime signalled the container to exit",
  /** guess: §8.4 regex `/no container instance|capacity/i`. */
  capacity: "There is no container instance available to start this container (capacity)",
  snapshotMissing: (id: string) => `Snapshot "${id}" was not found.`,
  alreadyRunning: "Container is already running",
  notStarted: "The container has not been started",
} as const;
