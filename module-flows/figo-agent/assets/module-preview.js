mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'base',
  flowchart: {
    htmlLabels: true,
    useMaxWidth: false,
    curve: 'basis',
  },
});

const nav = document.getElementById('diagramNav');
const diagram = document.getElementById('diagram');
const activeTitle = document.getElementById('activeTitle');
const activeMeta = document.getElementById('activeMeta');
const canvas = document.getElementById('canvas');
const canvasWrap = document.getElementById('canvasWrap');
const sourcePanel = document.getElementById('sourcePanel');
const sourceTitle = document.getElementById('sourceTitle');
const sourceCode = document.getElementById('sourceCode');

const htmlDecoder = document.createElement('textarea');

function decodeHtml(value) {
  htmlDecoder.innerHTML = value;
  return htmlDecoder.value;
}

const embeddedDiagrams = Array.from(
  document.querySelectorAll('script[type="application/vnd.mermaid"]'),
).map((node) => ({
  id: node.dataset.id,
  title: node.dataset.title,
  path: node.dataset.path,
  source: decodeHtml(node.textContent.trim()),
}));

function diagramFunctionName(id) {
  return `openDiagram_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

let activeId = embeddedDiagrams[0]?.id;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let dragging = false;
let dragStart = { x: 0, y: 0, offsetX: 0, offsetY: 0 };

function activeDiagram() {
  return embeddedDiagrams.find((item) => item.id === activeId) || embeddedDiagrams[0];
}

function applyTransform() {
  canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

function resetTransform() {
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  applyTransform();
}

async function openDiagramById(id) {
  activeId = id;
  sourcePanel.classList.remove('open');
  renderNav();
  await renderDiagram();
}

window.openDiagramById = openDiagramById;
window.openSubFlow = openDiagramById;

embeddedDiagrams.forEach((item) => {
  window[diagramFunctionName(item.id)] = () => openDiagramById(item.id);
});

function renderNav() {
  nav.innerHTML = '';
  embeddedDiagrams.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `nav-item${item.id === activeId ? ' active' : ''}`;
    button.textContent = item.title;
    button.addEventListener('click', () => openDiagramById(item.id));
    nav.appendChild(button);
  });
}

async function renderDiagram() {
  const item = activeDiagram();
  activeTitle.textContent = item.title;
  activeMeta.textContent = `${item.path} · 当前版本：${document.body.dataset.version}`;
  diagram.removeAttribute('data-processed');
  diagram.textContent = item.source;
  await mermaid.run({ nodes: [diagram] });
  resetTransform();
}

document.getElementById('zoomIn').addEventListener('click', () => {
  scale = Math.min(2.4, scale + 0.12);
  applyTransform();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  scale = Math.max(0.35, scale - 0.12);
  applyTransform();
});

document.getElementById('resetView').addEventListener('click', resetTransform);

document.getElementById('toggleSource').addEventListener('click', () => {
  const item = activeDiagram();
  sourceTitle.textContent = `${item.title} Mermaid 源图`;
  sourceCode.textContent = item.source;
  sourcePanel.classList.add('open');
});

document.getElementById('closeSource').addEventListener('click', () => {
  sourcePanel.classList.remove('open');
});

canvasWrap.addEventListener('pointerdown', (event) => {
  if (event.target.closest('g.node.clickable')) return;
  dragging = true;
  canvasWrap.classList.add('dragging');
  dragStart = { x: event.clientX, y: event.clientY, offsetX, offsetY };
  canvasWrap.setPointerCapture(event.pointerId);
});

canvasWrap.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  offsetX = dragStart.offsetX + event.clientX - dragStart.x;
  offsetY = dragStart.offsetY + event.clientY - dragStart.y;
  applyTransform();
});

canvasWrap.addEventListener('pointerup', (event) => {
  dragging = false;
  canvasWrap.classList.remove('dragging');
  canvasWrap.releasePointerCapture(event.pointerId);
});

canvasWrap.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.08 : 0.08;
    scale = Math.min(2.4, Math.max(0.35, scale + delta));
    applyTransform();
  },
  { passive: false },
);

renderNav();
renderDiagram();
