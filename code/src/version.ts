import { createRequire } from "node:module";

const manifest = createRequire(import.meta.url)("../package.json") as { version: string };

export const appVersion = manifest.version;
