import { execFileSync } from "node:child_process";
import { accessSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("图标资源生成使用 macOS 的 sips 与 iconutil；其他平台直接使用已生成资源。");
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "../figox/branding/figo-agent-icon-v7-agent-first.png");
accessSync(source);
const output = join(root, "assets");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "figo-brand-icons-"));
const iconset = join(temporary, "figo-agent.iconset");
mkdirSync(iconset);

function resize(size, path) {
  execFileSync("sips", ["-z", String(size), String(size), source, "--out", path], { stdio: "ignore" });
}

try {
  resize(512, join(output, "figo-agent-logo.png"));
  resize(64, join(output, "figo-agent-favicon.png"));
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`));
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(output, "figo-agent.icns")], { stdio: "inherit" });
  process.stdout.write("品牌 PNG、favicon 与 macOS ICNS 已生成至 code/assets。\n");
} finally { rmSync(temporary, { recursive: true, force: true }); }
