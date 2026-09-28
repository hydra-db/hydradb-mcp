import { createRequire } from "node:module";

// `../package.json` resolves to the package root from both `src/` (tsx) and `dist/` (published build).
const require = createRequire(import.meta.url);

export const SERVER_VERSION: string = (require("../package.json") as { version: string }).version;
