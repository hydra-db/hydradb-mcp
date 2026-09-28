import { createRequire } from "node:module";

// `../package.json` resolves to the package root from both `src/` (tsx) and `dist/` (published build).
const require = createRequire(import.meta.url);

// SAFETY: package.json always carries a string "version"; npm refuses to publish without one.
export const SERVER_VERSION: string = (require("../package.json") as { version: string }).version;
