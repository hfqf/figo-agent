import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? process.cwd());
const directory = dirname(fileURLToPath(import.meta.url));
const read = path => readFileSync(path, 'utf8');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, cwd: root });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const baseline = JSON.parse(read(join(directory, 'architecture.candidate.json'))).meta.repository.revision;
const sourceCache = new Set();
const diagrams = [];
for (const name of ['architecture', 'workflow', 'context', 'product']) {
  const receipt = JSON.parse(read(join(directory, `${name}.finalize-summary.json`)));
  const candidate = JSON.parse(read(join(directory, `${name}.candidate.json`)));
  assert.equal(receipt.ok, true);
  assert.deepEqual(Object.values(receipt.gates), ['pass', 'pass', 'pass', 'pass']);
  assert.equal(hash(join(directory, `${name}.html`)), receipt.artifact.sha256);
  assert.equal(hash(join(directory, `${name}.candidate.json`)), receipt.specification.sha256);
  assert.equal(candidate.meta.repository.revision, baseline);
  let references = 0;
  for (const node of candidate.nodes ?? candidate.components) {
    assert.ok(node.sources?.length, `${name}: 节点缺少源码依据`);
    for (const source of node.sources) {
      const current = read(join(root, source.path));
      const lines = current.split('\n').length;
      assert.ok(source.line > 0 && source.line <= lines);
      assert.ok((source.end_line ?? source.line) <= lines);
      if (!sourceCache.has(source.path)) {
        const committed = command('git', ['show', `${baseline}:${source.path}`]);
        assert.equal(current.replaceAll('\r\n', '\n'), committed.replaceAll('\r\n', '\n'), `引用源码已变化：${source.path}`);
        sourceCache.add(source.path);
      }
      references++;
    }
  }
  diagrams.push({ name, gates: receipt.gates, references, artifactSha256: receipt.artifact.sha256 });
}

const recordName = readdirSync(join(root, 'docs/agent')).find(name => name.startsWith('2026-10-18-README') && name.endsWith('.md'));
assert.ok(recordName);
const markdownFiles = [join(root, 'readme.md'), join(root, 'docs/agent', recordName)];
let links = 0;
for (const path of markdownFiles) {
  const markdown = read(path);
  assert.equal(markdown.split('\n').some(line => /[\t ]+$/.test(line)), false, '文档存在行尾空白');
  assert.equal(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(markdown), false, '文档出现疑似密钥');
  for (const match of markdown.matchAll(/\]\(([^)\r\n]+)\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    const file = decodeURIComponent(match[1].split('#')[0]);
    const target = resolve(dirname(path), file);
    // 本次生成的验证回执先完成其余检查，发布后再检查这个自引用。
    if (target !== join(directory, 'verification.json')) assert.ok(existsSync(target), `链接缺失：${match[1]}`);
    links++;
  }
}
const readme = read(markdownFiles[0]).replaceAll('\r\n', '\n');
assert.equal(readme.includes('module-flows/'), false);
const requireFromCode = createRequire(join(root, 'code/package.json'));
const { fromMarkdown } = await import(pathToFileURL(requireFromCode.resolve('mdast-util-from-markdown')).href);
const headingText = node => typeof node.value === 'string' ? node.value : (node.children ?? []).map(headingText).join('');
const headings = fromMarkdown(readme).children.filter(node => node.type === 'heading')
  .map(node => ({ title: headingText(node), depth: node.depth, offset: node.position.start.offset }));
const coverage = JSON.parse(read(join(directory, 'readme-content-coverage.json')));
assert.equal(coverage.documents.length, 36);
for (const item of coverage.documents) {
  assert.ok(existsSync(join(root, item.source)), `覆盖来源缺失：${item.source}`);
  assert.ok(headings.some(node => node.title === item.section && node.depth >= 3), `缺少独立阅读专题：${item.section}`);
  for (const term of item.terms) assert.ok(readme.includes(term), `专题必要说明遗漏：${item.source} / ${term}`);
}
const requiredSections = coverage.articleStructure.sections;
assert.deepEqual(headings.filter(node => node.depth === 2).map(node => node.title), requiredSections, '阅读顺序必须是概述、架构、模块、使用、验证与演进');
const mainSections = headings.filter(node => node.depth === 2);
const overview = readme.slice(mainSections[0].offset, mainSections[1].offset);
const preface = readme.slice(0, mainSections[0].offset);
let previousLabelOffset = -1;
for (const title of coverage.articleStructure.prefaceLabels) {
  const offset = preface.indexOf(`**${title}**`);
  assert.ok(offset > previousLabelOffset, `概述上方缺少前置内容或次序错误：${title}`);
  previousLabelOffset = offset;
}
for (const title of coverage.articleStructure.overviewSections) {
  assert.ok(headings.some(node => node.title === title && node.depth === 3 && node.offset > mainSections[0].offset && node.offset < mainSections[1].offset), `概述缺少读者视角：${title}`);
}
assert.equal(/\/api\/v\d|```(?:json|ts|typescript)\b/.test(overview), false, '概述不应提前进入接口与实现代码');
assert.ok([...overview.matchAll(/!\[/g)].length >= 3, '概述应直观展示工作台、上下文与用量');
const moduleHeadings = headings.filter(node => node.depth === 3 && node.offset > mainSections[2].offset && node.offset < mainSections[3].offset);
assert.equal(moduleHeadings.length, 18);
assert.deepEqual(moduleHeadings.map(node => node.title), coverage.articleStructure.modules, '模块讲解顺序或覆盖不完整');
const readmeImagePaths = [
  ...[...readme.matchAll(/!\[[^\]]*\]\(([^)\r\n]+)\)/g)].map(match => match[1]),
  ...[...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1])
];
const readmePlainLinks = [...readme.matchAll(/(?<!!)\[[^\]\n]+\]\([^\n)]+\)/g)];
assert.equal(readmePlainLinks.length, 0, '公众号正文不得依赖文档或锚点跳转');
const editorialPhrases = ['所有图示和机制说明', '均在本页展示', '本次编辑', '本轮拍摄',
  '下面把', '下面继续', '下文完整列出', '在下文说明', '如下文所述', '不依赖文档链接',
  '不能因修改文档', '不是本次实现承诺'];
for (const phrase of editorialPhrases) assert.equal(readme.includes(phrase), false, `正式文章残留编辑沟通语句：${phrase}`);
assert.equal(/<\/?(?:details|summary)\b|<a\b|```mermaid/i.test(readme), false, '内容必须展开，图示不能依赖交互或 Mermaid 渲染');
assert.ok(readmeImagePaths.includes('docs/agent/assets/2026-10-18-readme/context.png'), 'GIF 必须同时提供内嵌静态数据流图');
const pkg = JSON.parse(read(join(root, 'code/package.json')));
const scripts = [...readme.matchAll(/npm --prefix code run ([\w:-]+)/g)].map(match => match[1]);
for (const name of scripts) assert.ok(pkg.scripts[name], `脚本不存在：${name}`);

const manifest = JSON.parse(read(join(directory, 'exports.json')));
for (const entry of manifest.exports) {
  const path = join(entry.format === 'webm' ? join(root, '.archify/workflow-readme-20261018-160140/exports') : directory,
    `${entry.name}.${entry.format === 'svg-light' ? 'svg' : entry.format}`);
  // WebM 是可重建的忽略目录产物，其他机器可只验证已提交附件。
  if (entry.format === 'webm' && !existsSync(path)) continue;
  assert.equal(hash(path), entry.sha256, `导出哈希不一致：${path}`);
}
const gifPath = join(directory, 'context.gif');
const probe = JSON.parse(command(process.env.FFPROBE_EXECUTABLE ?? 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,duration', '-of', 'json', gifPath])).streams[0];
const frameHashes = command(process.env.FFMPEG_EXECUTABLE ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', gifPath, '-f', 'framemd5', '-'])
  .split('\n').filter(line => line.startsWith('0,')).map(line => line.split(',').at(-1).trim());
assert.equal(probe.width, 1440);
assert.ok(Number(probe.duration) >= 5);
assert.ok(frameHashes.length >= 60);
assert.ok(new Set(frameHashes).size >= 30, 'GIF 缺少实际帧变化');

const { chromium } = createRequire(join(root, 'code/package.json'))('playwright-core');
const executablePath = process.env.CHROME_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' :
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const browser = await chromium.launch({ executablePath, headless: true });
const images = [];
try {
  const page = await browser.newPage();
  // 使用相同 HTML 的 file origin 解码 README 附件，不访问工作台服务。
  await page.goto(pathToFileURL(join(directory, 'context.html')).href);
  for (const name of ['architecture.png', 'workflow.png', 'context.png', 'context.gif', 'product.png',
    'screenshots/workbench.png', 'screenshots/tasks.png', 'screenshots/trace-request.png', 'screenshots/context-flow.png', 'screenshots/compaction.png']) {
    const dimensions = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, pathToFileURL(join(directory, name)).href);
    assert.ok(dimensions.width > 500 && dimensions.height > 300);
    images.push({ name, ...dimensions });
  }
  for (const name of [...new Set(readmeImagePaths)]) {
    if (images.some(entry => resolve(directory, entry.name) === resolve(root, name))) continue;
    const dimensions = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, pathToFileURL(resolve(root, name)).href);
    assert.ok(dimensions.width > 0 && dimensions.height > 0, `README 图片不可用：${name}`);
    images.push({ name, ...dimensions });
  }
} finally { await browser.close(); }
const capture = JSON.parse(read(join(directory, 'screenshots/capture.json')));
assert.equal(capture.status, 'pass');
assert.deepEqual(capture.errors, []);
assert.deepEqual(capture.before, capture.after);
assert.equal(capture.remoteRequests, 0);
assert.equal(capture.after.runs, 0);
assert.ok([...readme.matchAll(/!\[/g)].length >= 8, 'README 应以截图和图示为主');
const result = { date: '2026-10-18', status: 'pass', baseline, diagrams,
  markdown: { localLinks: links, npmScripts: [...new Set(scripts)], whitespace: 'pass', keyPatternScan: 'clear' },
  gif: { ...probe, uniqueFrames: new Set(frameHashes).size, sha256: hash(gifPath) }, images,
  visualReadme: { characters: readme.length, embeddedImages: readmeImagePaths.length,
    associatedDocumentTopics: coverage.documents.length, plainLinks: readmePlainLinks.length,
    foldingControls: 0, editorialMetaLanguage: 'clear', expandedSections: requiredSections,
    overviewImages: [...overview.matchAll(/!\[/g)].length, moduleSections: moduleHeadings.length,
    screenshots: capture.screenshots.length, remoteRequests: capture.remoteRequests },
  scope: '仅文档、Archify 产物及导出验证，不是 Agent 业务或真实模型验收。' };
writeFileSync(join(directory, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
assert.ok(existsSync(join(directory, 'verification.json')));
console.log(JSON.stringify(result, null, 2));
