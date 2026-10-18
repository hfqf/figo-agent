import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从仓库根目录执行，或显式传入根目录；不依赖文档附件的放置层级。
const root = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(join(root, 'code/package.json'));
const ts = require('typescript');
const out = dirname(fileURLToPath(import.meta.url));
const slash = value => value.replaceAll('\\', '/');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(slash(relative(root, path)));
  }
  return result.sort();
}
const paths = [...await files(join(root, 'code/src')), ...await files(join(root, 'code/web/src'))]
  .filter(path => /\.tsx?$/.test(path));
const known = new Set(paths);
const all = new Map(paths.map(path => [path, new Set()]));
const runtime = new Map(paths.map(path => [path, new Set()]));
const modules = new Map();
const sizes = [];
const fingerprint = createHash('sha256');
let ignoredDynamic = 0;
let unresolvedRelative = 0;
for (const path of paths) {
  const text = await readFile(join(root, path), 'utf8');
  fingerprint.update(path).update('\0').update(text).update('\0');
  const lines = text.split('\n').length - Number(text.endsWith('\n'));
  sizes.push({ path, lines });
  const module = path.startsWith('code/web/') ? 'web' : path.split('/')[2];
  const group = modules.get(module) ?? { files: 0, lines: 0 };
  group.files++; group.lines += lines; modules.set(module, group);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.') || /\.(css|json|png|svg)$/.test(specifier)) continue;
    const base = posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, '');
    const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(value => known.has(value));
    if (!target) { unresolvedRelative++; continue; }
    all.get(path).add(target);
    const clause = statement.importClause;
    const typeOnly = ts.isImportDeclaration(statement)
      ? clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly))
      : statement.isTypeOnly || (statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.length > 0 && statement.exportClause.elements.every(element => element.isTypeOnly));
    if (!typeOnly) runtime.get(path).add(target);
  }
  const visit = node => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) ignoredDynamic++;
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// Tarjan 仅针对上述已解析的静态源码边，不声称覆盖运行时反射或全部包依赖。
function cycles(graph) {
  let count = 0;
  const ids = new Map(), low = new Map(), stack = [], active = new Set(), result = [];
  function visit(node) {
    ids.set(node, count); low.set(node, count++); stack.push(node); active.add(node);
    for (const target of graph.get(node)) {
      if (!ids.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (active.has(target)) low.set(node, Math.min(low.get(node), ids.get(target)));
    }
    if (low.get(node) !== ids.get(node)) return;
    const group = [];
    let current;
    do { current = stack.pop(); active.delete(current); group.push(current); } while (current !== node);
    if (group.length > 1) result.push(group.sort());
  }
  for (const node of graph.keys()) if (!ids.has(node)) visit(node);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tests = (await files(join(root, 'code/tests'))).filter(path => /\.test\.tsx?$/.test(path));
const result = {
  date: '2026-10-18', revision: git('rev-parse', 'HEAD'),
  sourceFingerprint: fingerprint.digest('hex'),
  scope: ['code/src/**/*.ts', 'code/web/src/**/*.ts', 'code/web/src/**/*.tsx'],
  modules: Object.fromEntries([...modules].sort(([a], [b]) => a.localeCompare(b))),
  totals: { backendFiles: paths.filter(path => path.startsWith('code/src/')).length,
    frontendFiles: paths.filter(path => path.startsWith('code/web/src/')).length,
    sourceLines: sizes.reduce((sum, file) => sum + file.lines, 0), testFiles: tests.length },
  largestFiles: sizes.sort((a, b) => b.lines - a.lines).slice(0, 10),
  staticRuntimeCycles: cycles(runtime), staticCyclesIncludingTypes: cycles(all),
  ignoredDynamicCalls: ignoredDynamic, unresolvedRelativeImports: unresolvedRelative,
  limitations: ['只统计自有 TypeScript/TSX，包含注释和空行，不计末尾换行产生的虚拟空行。',
    '通过 TypeScript AST 解析静态 import / export，包括类型导入的独立统计；不覆盖动态加载、反射及完整运行时控制。',
    '未读取运行配置、提示词数据、SQLite、JSONL、node_modules 或子模块源码；TypeScript 库本身从现有工具链加载。']
};
await writeFile(join(out, 'metrics.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
