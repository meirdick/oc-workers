// M4 S9 (add §6): platform SIGTERM at each sleep phase. Same driver as S1 with ACTION=sigterm, KEY=s9.
// usage: node run.mjs [phase ...]
process.env.ACTION ??= "sigterm";
process.env.KEY ??= "s9";
await import("../s1/run.mjs");
