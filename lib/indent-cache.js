const PAGE_ROWS = 256;
const WHITESPACE_REGEX = /^\s*$/;

// Keep numeric indentation, not source strings, across viewport updates. Pages
// cap storage at 256 KiB per editor even when a distant cursor causes a scan of
// a very large block. Revisions and tab-width changes invalidate it together.
class IndentCache {
  constructor(editor, maxPages = 128) {
    this.editor = editor;
    this.maxPages = maxPages;
    this.pages = new Map();
    this.read = this.read.bind(this);
  }

  prepare() {
    const buffer = this.editor.getBuffer();
    const revision = buffer.getTextRevision();
    const tabLength = this.editor.getTabLength();
    if (this.buffer !== buffer || this.revision !== revision || this.tabLength !== tabLength) {
      this.pages.clear();
      this.page = null;
      this.buffer = buffer;
      this.revision = revision;
      this.tabLength = tabLength;
    }
    return this.read;
  }

  read(row) {
    const pageIndex = Math.floor(row / PAGE_ROWS);
    if (!this.page || this.pageIndex !== pageIndex) {
      let page = this.pages.get(pageIndex);
      if (page) this.pages.delete(pageIndex);
      else page = new Float64Array(PAGE_ROWS).fill(NaN);
      this.pages.set(pageIndex, page);
      if (this.pages.size > this.maxPages) this.pages.delete(this.pages.keys().next().value);
      this.pageIndex = pageIndex;
      this.page = page;
    }
    const index = row - pageIndex * PAGE_ROWS;
    let indent = this.page[index];
    if (Number.isNaN(indent)) {
      const line = this.editor.lineTextForBufferRow(row);
      indent = WHITESPACE_REGEX.test(line) ? -1 : this.editor.indentLevelForLine(line);
      this.page[index] = indent;
    }
    return indent === -1 ? null : indent;
  }
}

module.exports = IndentCache;
