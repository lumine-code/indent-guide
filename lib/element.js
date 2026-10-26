// Cache for DOM references per editor
const editorCache = new WeakMap();
const geometryCache = new WeakMap();

function getEditorCache(editorElement) {
  let cache = editorCache.get(editorElement);
  if (!cache) {
    cache = { container: null, guideElements: [] };
    editorCache.set(editorElement, cache);
  }
  // The highlights layer may not exist yet on the first update, and the
  // container is removed from the DOM on deactivation, so (re)create it
  // whenever it is missing or detached instead of caching a dead reference.
  if (!cache.container || !cache.container.isConnected) {
    cache.container = null;
    cache.guideElements = [];
    const viewport = editorElement.querySelector(".scroll-view");
    if (viewport) {
      const container = document.createElement("div");
      container.className = "indent-guide-layer";
      container.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
      viewport.appendChild(container);
      cache.container = container;
    }
  }
  return cache;
}

function styleGuide(element, { top, left, height, depth, stack, active }) {
  const previous = geometryCache.get(element);
  // Batch classList operations
  if (previous?.stack !== stack) element.classList.toggle("indent-guide-stack", stack);
  if (previous?.active !== active) element.classList.toggle("indent-guide-active", active);

  // Batch style assignments for single reflow
  if (!previous || previous.left !== left || previous.top !== top || previous.height !== height)
    element.style.cssText = `left:${left}px;top:${top}px;height:${height}px;display:block`;
  if (previous?.depth !== depth) element.setAttribute("depth", depth);
  geometryCache.set(element, { top, left, height, depth, stack, active });
}

function segmentsForGuides(guides, editor, editorElement) {
  const height = editorElement.getHeight();
  const width = editorElement.getWidth();
  const scrollTop = editorElement.getScrollTop();
  const scrollLeft = editorElement.getScrollLeft();
  const cellWidth = editor.getTabLength() * editor.getDefaultCharWidth();
  const lineHeight = editor.getLineHeightInPixels();
  const first = editorElement.getFirstVisibleScreenRow();
  const last = editorElement.getLastVisibleScreenRow();
  const rows = new Map();
  const segments = [];
  for (const guide of guides) {
    const left = guide.point.column * cellWidth - scrollLeft;
    if (left < 0 || left > width) continue;
    let previous = null;
    for (
      let row = Math.max(first, guide.point.row);
      row <= Math.min(last, guide.point.row + guide.length - 1);
      row++
    ) {
      let bounds = rows.get(row);
      if (!bounds) {
        const textTop = editorElement.pixelPositionForScreenPosition([row, 0]).top - scrollTop;
        const next = editorElement.pixelPositionBeforeBlocksForScreenRow(row + 1, {
          viewport: true,
        });
        bounds = {
          top: Math.max(0, textTop),
          bottom: Math.min(height, textTop + lineHeight, next),
        };
        rows.set(row, bounds);
      }
      if (bounds.bottom <= bounds.top) continue;
      if (previous && Math.abs(previous.top + previous.height - bounds.top) < 0.01)
        previous.height = bounds.bottom - previous.top;
      else {
        previous = {
          top: bounds.top,
          left,
          height: bounds.bottom - bounds.top,
          depth: guide.point.column,
          active: guide.active,
          stack: guide.stack,
        };
        segments.push(previous);
      }
    }
  }
  return segments;
}

function createElementsForGuides(editorElement, fns) {
  const cache = getEditorCache(editorElement);
  if (!cache.container) {
    return;
  }

  const elements = cache.guideElements;
  const existNum = elements.length;
  const neededNum = fns.length;
  let count = 0;

  // Recycle existing elements
  const recycleNum = Math.min(neededNum, existNum);
  for (let i = 0; i < recycleNum; i++) {
    fns[count++](elements[i]);
  }

  // Remove excess elements
  for (let i = existNum - 1; i >= recycleNum; i--) {
    elements[i].remove();
    elements.pop();
  }

  // Create new elements if needed
  for (let i = existNum; i < neededNum; i++) {
    const newNode = document.createElement("div");
    newNode.classList.add("overlayer", "indent-guide");
    fns[count++](newNode);
    cache.container.appendChild(newNode);
    elements.push(newNode);
  }
}

module.exports = { styleGuide, createElementsForGuides, segmentsForGuides };
