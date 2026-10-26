const { Point } = require("lumine");

function fillInNulls(indents) {
  const result = new Array(indents.length);
  let next = 0;
  for (let i = indents.length - 1; i >= 0; i--) {
    if (indents[i] !== null) next = Math.floor(indents[i]);
    result[i] = next;
  }
  return result;
}

// Iterate visible depths instead of recursing through every indentation level.
// A billion-column indent needs only the columns intersecting the viewport.
function toGuides(indents, cursorPositions, { minColumn = 0, maxColumn = Infinity } = {}) {
  const values = fillInNulls(indents);
  const cursorMap = new Map();
  for (const { row, level } of cursorPositions) {
    if (row < 0 || row >= values.length) continue;
    let levels = cursorMap.get(row);
    if (!levels) cursorMap.set(row, (levels = []));
    levels.push(Math.min(level + 1, values[row]));
  }
  const maximum = values.reduce((value, indent) => Math.max(value, indent), 0);
  const guides = [];
  for (let depth = Math.max(1, minColumn + 1); depth <= Math.min(maximum, maxColumn + 1); depth++) {
    let start = null,
      stack = false,
      active = false;
    for (let row = 0; row <= values.length; row++) {
      if (row < values.length && values[row] >= depth) {
        if (start == null) start = row;
        const levels = cursorMap.get(row);
        if (levels) {
          stack = true;
          active ||= levels.includes(depth);
        }
      } else if (start != null) {
        guides.push({ length: row - start, point: new Point(start, depth - 1), active, stack });
        start = null;
        stack = active = false;
      }
    }
  }
  return guides.sort((a, b) => a.point.compare(b.point));
}

function uniq(values) {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

function* virtualIndent(row, lastRow) {
  for (let current = row; current <= lastRow; current++) {
    const indent = yield current;
    if (indent !== null) return indent;
  }
  return 0;
}

function* invisibleStates(cursorPositions, start, lastRow, isAbove, options) {
  if (isAbove ? start < 0 : start > lastRow) return { stack: [], active: [] };
  const cursorMap = new Map();
  for (const { row, level } of cursorPositions) {
    if (isAbove ? row > start : row < start) continue;
    let levels = cursorMap.get(row);
    if (!levels) cursorMap.set(row, (levels = []));
    levels.push(level);
  }
  const rows = [...cursorMap.keys()].sort((a, b) => (isAbove ? b - a : a - b));
  const active = new Set();
  let stack = [],
    minimum = Infinity,
    nextCursor = 0;
  const step = isAbove ? -1 : 1;
  for (let row = start; row >= 0 && row <= lastRow && nextCursor < rows.length; row += step) {
    const indent = yield row;
    if (indent !== null) minimum = Math.min(minimum, Math.floor(indent));
    if (minimum === 0) break;
    if (rows[nextCursor] !== row) continue;
    nextCursor++;
    const effective = Math.floor(yield* virtualIndent(row, lastRow));
    minimum = Math.min(minimum, effective);
    for (const level of cursorMap.get(row)) {
      const depth = Math.min(level + 1, effective);
      if (
        depth >= 1 &&
        depth <= minimum &&
        depth - 1 >= options.minColumn &&
        depth - 1 <= options.maxColumn
      )
        active.add(depth - 1);
    }
    if (!stack.length)
      for (
        let column = options.minColumn;
        column < Math.min(minimum, options.maxColumn + 1);
        column++
      )
        stack.push(column);
  }
  return { stack, active: [...active].sort((a, b) => a - b) };
}

function* guidePlan(visibleFrom, visibleTo, lastRow, cursorPositions, options) {
  const cursors = [];
  for (const cursor of cursorPositions)
    cursors.push({
      row: cursor.row,
      level:
        cursor.level == null
          ? Math.floor(yield { row: cursor.bufferRow ?? cursor.row, column: cursor.column })
          : cursor.level,
    });
  const visibleLast = Math.min(visibleTo, lastRow);
  const indents = [];
  for (let row = visibleFrom; row <= visibleLast; row++) indents.push(yield row);
  // One virtual support row is sufficient; an offscreen blank run must never
  // become an array or a multi-million-pixel DOM guide.
  if (indents.at(-1) === null) indents.push(yield* virtualIndent(visibleLast + 1, lastRow));
  const guides = toGuides(
    indents,
    cursors.map((cursor) => ({ ...cursor, row: cursor.row - visibleFrom })),
    options,
  );
  const above = yield* invisibleStates(cursors, visibleFrom - 1, lastRow, true, options);
  const below = yield* invisibleStates(cursors, visibleLast + 1, lastRow, false, options);
  const height = visibleLast - visibleFrom;
  for (const guide of guides) {
    if (guide.point.row === 0) {
      guide.active ||= above.active.includes(guide.point.column);
      guide.stack ||= above.stack.includes(guide.point.column);
    }
    if (height < guide.point.row + guide.length) {
      guide.active ||= below.active.includes(guide.point.column);
      guide.stack ||= below.stack.includes(guide.point.column);
    }
  }
  return guides;
}

function execute(plan, getIndent, { signal, budgetMs = Infinity, cursorLevel } = {}) {
  let step = plan.next(),
    deadline = performance.now() + budgetMs;
  const advance = () => {
    while (!step.done) {
      signal?.throwIfAborted();
      if (performance.now() >= deadline)
        return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
          deadline = performance.now() + budgetMs;
          return advance();
        });
      const value =
        typeof step.value === "number"
          ? getIndent(step.value, { deadline, signal })
          : cursorLevel(step.value.row, step.value.column, { deadline, signal });
      if (value?.then)
        return value.then((result) => {
          step = plan.next(result);
          deadline = performance.now() + budgetMs;
          return advance();
        });
      step = plan.next(value);
    }
    return step.value;
  };
  return advance();
}

function getGuides(visibleFrom, visibleTo, lastRow, cursorPositions, getIndent, options = {}) {
  const bounds = { minColumn: 0, maxColumn: Infinity, ...options };
  return execute(
    guidePlan(visibleFrom, visibleTo, lastRow, cursorPositions, bounds),
    getIndent,
    bounds,
  );
}
function statesAboveVisible(cursors, start, getIndent, lastRow) {
  return execute(
    invisibleStates(cursors, start, lastRow, true, { minColumn: 0, maxColumn: Infinity }),
    getIndent,
  );
}
function statesBelowVisible(cursors, start, getIndent, lastRow) {
  return execute(
    invisibleStates(cursors, start, lastRow, false, { minColumn: 0, maxColumn: Infinity }),
    getIndent,
  );
}

module.exports = { toGuides, uniq, getGuides, statesAboveVisible, statesBelowVisible };
