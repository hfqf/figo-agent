import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(root, "../../code/package.json"));
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
const ids = ["desktop", "models", "tasks", "workspace", "context", "observability"];
const failures = [];

try {
  for (const id of ids) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(root, id, "index.html")).href);
    const diagrams = await page.locator('script[type="application/vnd.mermaid"]').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.dataset.id,
      path: node.dataset.path,
      source: (() => { const textarea = document.createElement("textarea"); textarea.innerHTML = node.textContent.trim(); return textarea.value; })()
    })));
    const md = await readFile(join(root, id, `${id}.md`), "utf8");
    const changelog = await readFile(join(root, id, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /v1\.0\.0/);
    assert.match(md, /当前版本：v1\.0\.0/);
    for (const item of diagrams) {
      const source = (await readFile(join(root, id, item.path), "utf8")).trim();
      assert.equal(item.source, source, `${id}/${item.path} HTML 与图源不一致`);
      assert.ok(md.includes(`\`\`\`mermaid\n${source}\n\`\`\``), `${id}/${item.path} MD 与图源不一致`);
      assert.equal(source.charCodeAt(0), 37, `${id}/${item.path} 存在 BOM`);
      const cited = source.match(/^%% source: (.+)$/m)?.[1].split(";").map((path) => path.trim()) ?? [];
      assert.ok(cited.length > 0, `${id}/${item.path} 缺代码依据`);
      for (const path of cited) assert.ok((await stat(join(root, "../..", path))).isFile(), `${id}/${item.path} 来源不存在：${path}`);
      const index = diagrams.indexOf(item);
      await page.locator("#diagramNav button").nth(index).click();
      await page.locator("#diagram svg").waitFor({ timeout: 15000 });
      assert.equal(await page.locator("#diagram .error-icon").count(), 0, `${id}/${item.path} Mermaid 错误`);
      const text = await page.locator("#diagram").innerText();
      assert.ok(!text.includes("Syntax error in text"), `${id}/${item.path} 解析错误`);
    }
    await page.locator("#diagramNav button").first().click();
    const refCount = await page.locator("#diagram g.node.clickable").count();
    assert.ok(refCount >= diagrams.length - 1, `${id} 总览图缺少可点子流程引用`);
    await page.locator("#diagram g.node.clickable").first().hover();
    await page.locator(".mermaidTooltip").waitFor({ state: "visible", timeout: 3000 });
    for (let index = 0; index < diagrams.length - 1; index++) {
      await page.locator("#diagramNav button").first().click();
      const expected = await page.locator("#diagramNav button").nth(index + 1).innerText();
      await page.locator("#diagram g.node.clickable").nth(index).click();
      await page.waitForFunction((title) => document.getElementById("activeTitle")?.textContent === title, expected);
      const activeTitle = await page.locator("#activeTitle").innerText();
      assert.equal(activeTitle, expected, `${id} 子流程点击失败`);
    }
    await page.getByRole("button", { name: "打开源图" }).click();
    assert.equal(await page.locator("#sourcePanel.open").count(), 1, `${id} 源图面板未打开`);
    if (id === "tasks") {
      await page.getByRole("button", { name: "关闭" }).click();
      await page.locator("#diagramNav button").first().click();
      await page.screenshot({ path: join(root, "tasks-overview.png"), fullPage: true });
    }
    if (errors.length) failures.push(`${id}: ${errors.join(" | ")}`);
    await page.close();
    process.stdout.write(`${id}: ${diagrams.length} 张图已渲染，${refCount} 个引用节点可点击\n`);
  }

  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(root, "index.html")).href);
    await page.locator("#moduleMap svg").waitFor({ timeout: 15000 });
    assert.equal(await page.locator(".module-card").count(), ids.length);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `${label} 首页横向溢出`);
    const clipped = await page.locator(".module-card").evaluateAll((cards) => cards.some((card) => card.scrollWidth > card.clientWidth + 1));
    assert.equal(clipped, false, `${label} 模块卡片文字裁切`);
    const mapNode = page.locator("#moduleMap g.node.clickable").first();
    await mapNode.click();
    await page.waitForURL(/\/desktop\/index\.html$/);
    assert.equal(await page.locator("#activeTitle").innerText(), "启动主流程");
    if (errors.length) failures.push(`portal-${label}: ${errors.join(" | ")}`);
    await page.goto(pathToFileURL(join(root, "index.html")).href);
    await page.locator("#moduleMap svg").waitFor({ timeout: 15000 });
    await page.screenshot({ path: join(root, `portal-${label}.png`), fullPage: true });
    await page.close();
    process.stdout.write(`总入口 ${label}: 模块跳转、布局与截图通过\n`);
  }
  const mobileModule = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobileModule.goto(pathToFileURL(join(root, "tasks/index.html")).href);
  await mobileModule.locator("#diagram svg").waitFor({ timeout: 15000 });
  assert.equal(await mobileModule.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "移动端模块页面横向溢出");
  await mobileModule.screenshot({ path: join(root, "tasks-mobile.png"), fullPage: true });
  await mobileModule.close();
  process.stdout.write("模块详情 mobile: 渲染与布局截图通过\n");
  assert.deepEqual(failures, [], `浏览器报错：${failures.join("; ")}`);
} finally {
  await browser.close();
}
