import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../../..');
const skillRoot = process.env.FIREWORKS_SKILL_ROOT ?? join(homedir(), '.codex/skills/fireworks-tech-graph');
const { chromium } = createRequire(join(root, 'code/package.json'))('playwright-core');
const definitions = JSON.parse(await readFile(join(directory, 'diagrams.json'), 'utf8'));
const results = [];
const executablePath = process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const [name, definition] of Object.entries(definitions)) {
    const data = {
      style: 1,
      quality_profile: 'showcase',
      width: 680,
      height: 760,
      style_overrides: { title_size: 32, subtitle_size: 22, node_radius: 8, node_shadow: '' },
      ...definition,
      nodes: definition.nodes.map(node => ({ title_size: 28, ...node }))
    };
    const svgPath = join(directory, `${name}.svg`);
    run('python3', [join(skillRoot, 'scripts/generate-from-template.py'), definition.type, svgPath,
      JSON.stringify(data), '--layout-report', join(directory, `${name}.layout.json`)]);
    const gates = {};
    for (const check of ['xml', 'markers', 'collisions', 'geometry', 'composition']) {
      gates[check] = run('python3', [join(skillRoot, 'scripts/validate_svg.py'), svgPath, '--check', check]);
    }
    const page = await browser.newPage({ viewport: { width: 680, height: 760 }, deviceScaleFactor: 2 });
    try {
      await page.setContent(await readFile(svgPath, 'utf8'));
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.locator('svg').evaluate(svg => {
        const canvas = svg.viewBox.baseVal;
        return [...svg.querySelectorAll('text')].filter(text => {
          const box = text.getBBox();
          return box.x < 0 || box.y < 0 || box.x + box.width > canvas.width || box.y + box.height > canvas.height;
        }).map(text => text.textContent);
      });
      assert.deepEqual(overflow, [], `${name}: 文字超出画布`);
      await page.locator('svg').screenshot({ path: join(directory, `${name}.png`) });
      results.push({ name, gates, textOverflow: overflow, png: `${name}.png`, width: 1360, height: 1520 });
      console.log(`${name}: SVG 校验通过，PNG 已导出`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(join(directory, 'verification.json'), JSON.stringify({
  date: '2026-10-18', renderer: 'Fireworks Tech Graph + Chromium',
  note: '简图解释逻辑与操作顺序，不是性能图；PNG 需人工视觉复核。', results
}, null, 2) + '\n');
