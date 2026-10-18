const { readdir, access, rm } = require("node:fs/promises");
const { join } = require("node:path");

function ignoreDevelopmentContent(path) {
  const name = path.replaceAll("\\", "/").replace(/^\//, "");
  if (/(^|\/)(?:node_modules|\.figo-agent|\.env[^/]*|figo-agent\.config\.json|\.DS_Store)(?:\/|$)/.test(name)) return true;
  if (!name || name === "package.json" || name === "setup-preload.cjs" || /^LICENSE(?:\..*)?$/.test(name)) return false;
  if (["dist", "web", "web/dist", "assets", "locales", "third-party"].includes(name)) return false;
  if (name.startsWith("dist/")) return /\.[^/]+$/.test(name) && !name.endsWith(".js");
  if (name.startsWith("web/dist/")) return name.endsWith(".map");
  if (name === "assets/figo-agent-logo.png") return false;
  if (name.startsWith("locales/")) return !name.endsWith(".json");
  if (name.startsWith("third-party/")) return false;
  return true;
}

async function trimElectronLocales({ buildPath, platform }) {
  let root;
  let required;
  let isLocale;
  let keep;
  if (platform === "win32") {
    root = join(buildPath, "locales");
    required = ["en-US.pak", "zh-CN.pak"];
    isLocale = (name) => name.endsWith(".pak");
    keep = (name) => required.includes(name);
  } else if (platform === "darwin" || platform === "mas") {
    root = join(buildPath, "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources");
    required = ["en.lproj", "zh_CN.lproj"];
    isLocale = (name) => name.endsWith(".lproj");
    keep = (name) => /^(?:en|en_US|zh_CN)(?:_(?:FEMININE|MASCULINE|NEUTER))?\.lproj$/.test(name);
  } else return;
  // 验证回退资源后再删除，且只处理本次解压目录中的语言文件。
  for (const name of required) await access(join(root, name));
  for (const name of await readdir(root)) {
    if (isLocale(name) && !keep(name)) await rm(join(root, name), { recursive: true });
  }
}

module.exports = { ignoreDevelopmentContent, trimElectronLocales };
