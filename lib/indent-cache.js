const PAGE_ROWS = 256;

// Numeric pages stay bounded (about544 KiB at the default page count). Source
// strings are short-lived chunks, never retained by row or by viewport.
class IndentCache {
  constructor(editor, maxPages = 128) {
    this.editor = editor;
    this.maxPages = Math.max(1, maxPages);
    this.pages = new Map();
    this.cursorLevels = new Map();
    this.generation = 0;
    this.read = this.read.bind(this);
  }

  prepare() {
    const buffer = this.editor.getBuffer();
    const revision = buffer.getTextRevision();
    const tabLength = this.editor.getTabLength();
    if (this.buffer !== buffer || this.revision !== revision || this.tabLength !== tabLength) {
      this.pages.clear();
      this.cursorLevels.clear();
      this.buffer = buffer;
      this.source = buffer.getTextSnapshot();
      this.revision = revision;
      this.tabLength = tabLength;
      this.generation++;
    }
    return this.read;
  }

  pageFor(row) {
    const index = Math.floor(row / PAGE_ROWS);
    let page = this.pages.get(index);
    if (page) this.pages.delete(index);
    else if (this.pages.size >= this.maxPages) {
      const oldest = this.pages.keys().next().value;
      page = this.pages.get(oldest);
      this.pages.delete(oldest);
      page.levels.fill(NaN);
    } else
      page = {
        levels: new Float64Array(PAGE_ROWS).fill(NaN),
        prefixes: new Float64Array(PAGE_ROWS),
        blank: new Uint8Array(PAGE_ROWS),
      };
    this.pages.set(index, page);
    if (this.pages.size > this.maxPages) this.pages.delete(this.pages.keys().next().value);
    return { page, index: row - index * PAGE_ROWS };
  }

  read(row, options) {
    const { page, index } = this.pageFor(row);
    if (!Number.isNaN(page.levels[index])) return page.blank[index] ? null : page.levels[index];
    const generation = this.generation;
    const finish = (result) => {
      if (this.generation === generation) {
        const current = this.pageFor(row);
        current.page.levels[current.index] = result.level;
        current.page.prefixes[current.index] = result.prefix;
        current.page.blank[current.index] = result.blank ? 1 : 0;
      }
      return result.blank ? null : result.level;
    };
    const result = this.measure(row, Infinity, true, options);
    return result?.then ? result.then(finish) : finish(result);
  }

  cursorLevel(row, column, options) {
    const { page, index } = this.pageFor(row);
    if (!Number.isNaN(page.levels[index]) && column >= page.prefixes[index])
      return page.levels[index];
    const key = `${row}:${column}`;
    if (this.cursorLevels.has(key)) return this.cursorLevels.get(key);
    const generation = this.generation;
    const finish = (result) => {
      if (this.generation === generation) {
        this.cursorLevels.set(key, result.level);
        if (this.cursorLevels.size > 256)
          this.cursorLevels.delete(this.cursorLevels.keys().next().value);
      }
      return result.level;
    };
    const result = this.measure(row, column, false, options);
    return result?.then ? result.then(finish) : finish(result);
  }

  measure(row, column, checkBlank, { signal, deadline = Infinity } = {}) {
    const source = this.source;
    if (row < 0 || row >= source.lineCount) return { level: 0, prefix: 0, blank: true };
    const start = source.lineStart(row);
    let end = row + 1 < source.lineCount ? source.lineStart(row + 1) - 1 : source.length;
    if (row + 1 < source.lineCount && source.charCodeAt(end - 1) === 13) end--;
    end = Math.min(end, start + column);
    const tabLength = this.tabLength;
    let offset = start,
      columns = 0,
      prefix = 0,
      leading = true,
      blank = true;
    const advance = () => {
      while (offset < end) {
        signal?.throwIfAborted();
        const text = source.slice(offset, Math.min(end, offset + 4096));
        if (leading) {
          for (const character of text) {
            if (character === " ") columns++;
            else if (character === "\t") columns += tabLength - (columns % tabLength);
            else {
              leading = false;
              break;
            }
            prefix++;
          }
        }
        if (/\S/.test(text)) blank = false;
        if (!leading && (!checkBlank || !blank))
          return { level: columns / tabLength, prefix, blank };
        offset += text.length;
        if (performance.now() >= deadline)
          return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
            deadline = performance.now() + 4;
            return advance();
          });
      }
      signal?.throwIfAborted();
      return { level: columns / tabLength, prefix, blank };
    };
    return advance();
  }
}

module.exports = IndentCache;
