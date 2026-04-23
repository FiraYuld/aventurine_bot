import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const toolsRoot = resolve(here, "..", "..");
const repoRoot = resolve(toolsRoot, "..", "..");

export const PATHS = {
  repoRoot,
  toolsRoot,
  /** По умолчанию ищем result.json в корне репо, но можно переопределить через env. */
  get rawExport(): string {
    return process.env.RESULT_JSON_PATH
      ? resolve(process.env.RESULT_JSON_PATH)
      : resolve(repoRoot, "result.json");
  },
  outDir: resolve(toolsRoot, "out"),
  statsDir: resolve(toolsRoot, "out", "stats"),
  samplesDir: resolve(toolsRoot, "out", "samples"),
  aliasMap: resolve(toolsRoot, "out", "alias-map.json"),
  dossierJson: resolve(toolsRoot, "out", "dossier.json"),
  dossierMd: resolve(toolsRoot, "out", "dossier.md"),
  loreTs: resolve(repoRoot, "src", "chat", "chat-lore.ts"),
} as const;
