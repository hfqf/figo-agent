import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? process.cwd());
const directory = dirname(fileURLToPath(import.meta.url));
const scratch = join(root, '.archify/workflow-readme-20261018-160140/exports');
const { chromium } = createRequire(join(root, 'code/package.json'))('playwright-core');
const executablePath = process.env.CHROME_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' :
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const ffmpeg = process.env.FFMPEG_EXECUTABLE ?? 'ffmpeg';
await mkdir(scratch, { recursive: true });

const selected = process.argv.slice(3);
const names = selected.length ? selected : ['architecture', 'workflow', 'context', 'product'];
assert.ok(names.every(name => ['architecture', 'workflow', 'context', 'product'].includes(name)));
let previous;
try { previous = JSON.parse(await readFile(join(directory, 'exports.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const exports = previous?.exports.filter(entry => !names.includes(entry.name)) ?? [];
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const name of names) {
    const input = join(directory, `${name}.html`);
    const receipt = JSON.parse(await readFile(join(directory, `${name}.finalize-summary.json`), 'utf8'));
    const bytes = await readFile(input);
    assert.equal(receipt.ok, true, `${name}: finalize 未通过`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.artifact.sha256, `${name}: HTML 哈希不匹配`);
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1100 }, colorScheme: 'light', reducedMotion: 'no-preference', acceptDownloads: true
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(pathToFileURL(input).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      const formats = name === 'context' ? ['png', 'svg-light', 'webm'] : ['png', 'svg-light'];
      for (const format of formats) {
        await page.locator('#btn-export').click();
        const pending = page.waitForEvent('download', { timeout: 90000 });
        await page.locator(`.export-menu button[data-format="${format}"]`).click();
        const download = await pending;
        const extension = format === 'svg-light' ? 'svg' : format;
        const output = join(format === 'webm' ? scratch : directory, `${name}.${extension}`);
        await download.saveAs(output);
        assert.equal(await download.failure(), null, `${name}: ${format} 下载失败`);
        const result = await readFile(output);
        assert.ok(result.length > 1000, `${name}: ${format} 为空或不完整`);
        exports.push({ name, format, bytes: result.length, sha256: createHash('sha256').update(result).digest('hex') });
        console.log(`${name}: ${format} 已导出 (${result.length} bytes)`);
      }
      assert.deepEqual(errors, [], `${name}: 浏览器异常`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }

// 从 Archify 原生导出转换，保持原始节点、连线和动效，不手绘替代图。
if (names.includes('context')) {
const conversion = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'warning', '-y', '-i', join(scratch, 'context.webm'),
  '-filter_complex', 'fps=12,scale=1440:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  '-loop', '0', join(directory, 'context.gif')
], { encoding: 'utf8', windowsHide: true });
if (conversion.error) throw conversion.error;
assert.equal(conversion.status, 0, conversion.stderr);
const gif = await readFile(join(directory, 'context.gif'));
assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
exports.push({ name: 'context', format: 'gif', bytes: gif.length, sha256: createHash('sha256').update(gif).digest('hex') });
console.log(`context: GIF 已生成 (${gif.length} bytes)`);
}
await writeFile(join(directory, 'exports.json'), JSON.stringify({
  date: '2026-10-18', exports, width: 1440, fps: 12,
  note: 'Archify 原生规范导出；GIF 为 WebM 转码，动效仅表示逻辑流向，不是实际运行时序。'
}, null, 2) + '\n');
