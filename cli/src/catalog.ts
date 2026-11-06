// Workers AI chat catalogue: every Text Generation model with function calling and no planned deprecation.
// Shipped snapshot: models-catalog.json. `ochost model list --refresh` writes the live one to
// .oc-host/models-catalog.json; the render uses the install's file when it exists, else the shipped one.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import shipped from "./models-catalog.json";

export interface CatalogModel {
  id: string;
  contextWindow: number;
  supportsReasoning: boolean;
  /** reasoning_effort enum; empty when the model has no effort control */
  efforts: string[];
  vision: boolean;
  /** USD per M tokens; null when the catalogue has no price */
  priceInPerM: number | null;
  priceOutPerM: number | null;
}

export interface Catalog {
  /** YYYY-MM-DD the snapshot was taken */
  date: string;
  source: string;
  models: CatalogModel[];
}

export const SHIPPED_CATALOG = shipped as Catalog;
export const CATALOG_FILE = "models-catalog.json";
const STATE = ".oc-host";

const valid = (c: unknown): c is Catalog =>
  !!c && typeof (c as Catalog).date === "string" && Array.isArray((c as Catalog).models);

/** The install's snapshot (.oc-host/models-catalog.json) when it reads and parses, else the shipped one. */
export function loadCatalog(dir?: string): Catalog {
  if (dir) {
    const p = join(dir, STATE, CATALOG_FILE);
    if (existsSync(p))
      try {
        const c = JSON.parse(readFileSync(p, "utf8"));
        if (valid(c)) return c;
      } catch {}
  }
  return SHIPPED_CATALOG;
}

export async function saveCatalog(dir: string, c: Catalog): Promise<string> {
  const p = join(dir, STATE, CATALOG_FILE);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(c, null, 1)}\n`);
  return p;
}
