// Imported first by backup/lib.mjs: raw files of the backup drills go to results/raw/M4-backup/.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.RAW ??= join(dirname(fileURLToPath(import.meta.url)), "../../results/raw/M4-backup");
