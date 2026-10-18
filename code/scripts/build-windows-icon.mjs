import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngToIco from "png-to-ico";

const root = resolve(import.meta.dirname, "..");
await writeFile(resolve(root, "assets/figo-agent.ico"), await pngToIco(resolve(root, "assets/figo-agent-logo.png")));
process.stdout.write("Windows 多尺寸品牌图标已生成。\n");
