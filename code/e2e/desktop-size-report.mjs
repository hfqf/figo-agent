import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const { version } = require("../package.json");
const size = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0) : stat.size;
};
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const report = { version, platforms: {} };
for (const [platform, app, archive, locales, installer] of [
  ["mac", "out/Figo Agent-darwin-arm64/Figo Agent.app", "Contents/Resources/app.asar",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources", `out/make/zip/darwin/arm64/Figo Agent-darwin-arm64-${version}.zip`],
  ["windows", "out/Figo Agent-win32-x64", "resources/app.asar", "locales", `out/make/nsis/win32/x64/Figo-Agent-Setup-${version}-x64.exe`]
]) {
  const archivePath = join(app, archive);
  const localeRoot = join(app, locales);
  const localeNames = readdirSync(localeRoot).filter((name) => platform === "mac" ? name.endsWith(".lproj") : name.endsWith(".pak")).sort();
  const entries = asar.listPackage(archivePath).filter((name) => /\.(?:js|css|png|json)$/.test(name) &&
    /^\/(?:dist\/|web\/dist\/|locales\/)/.test(name)).sort();
  const features = createHash("sha256");
  for (const name of entries) { features.update(name); features.update(asar.extractFile(archivePath, name.slice(1))); }
  report.platforms[platform] = { installer, installerBytes: statSync(installer).size, installerSha256: hash(readFileSync(installer)),
    installedBytes: size(app), asarBytes: statSync(archivePath).size, localeCount: localeNames.length,
    localeBytes: localeNames.reduce((sum, name) => sum + size(join(localeRoot, name)), 0),
    localeNames, runtimeAndUiContentHash: features.digest("hex") };
}
if (process.argv[2]) {
  mkdirSync(dirname(process.argv[2]), { recursive: true });
  writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
