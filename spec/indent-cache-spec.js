const { TextEditor } = require("lumine");
const IndentCache = require("../lib/indent-cache");

describe("Indentation cache", () => {
  let editor, cache;
  beforeEach(() => {
    editor = new TextEditor({ tabLength: 4 });
    cache = new IndentCache(editor);
  });
  afterEach(() => editor.destroy());

  it("keeps blank lines, fractional indentation and mixed tabs equivalent to editor reads", () => {
    editor.setText("root\n \t child\n  partial\n\t\n\u00a0\n    child");
    const read = cache.prepare();
    const line = spyOn(editor, "lineTextForBufferRow").and.callThrough();
    const expected = [0, 1.25, 0.5, null, null, 1];
    for (let pass = 0; pass < 3; pass++) {
      for (let row = 0; row < expected.length; row++) expect(read(row)).toBe(expected[row]);
    }
    expect(line.calls.count()).toBe(expected.length);
  });

  it("invalidates after edits, row shifts, undo, redo and tab-width changes", () => {
    editor.setText("\tchild\n  other");
    expect(cache.prepare()(1)).toBe(0.5);
    editor.getBuffer().insert([0, 0], "  first\n");
    expect(cache.prepare()(1)).toBe(1);
    editor.undo();
    expect(cache.prepare()(1)).toBe(0.5);
    editor.redo();
    expect(cache.prepare()(1)).toBe(1);
    editor.setTabLength(2);
    expect(cache.prepare()(0)).toBe(1);
    editor.getBuffer().setTextInRange(
      [
        [0, 0],
        [0, 2],
      ],
      "",
    );
    expect(cache.prepare()(0)).toBe(0);
  });

  it("bounds retained pages and rebuilds evicted rows without stale values", () => {
    editor.setText("  child\n".repeat(800));
    cache = new IndentCache(editor, 2);
    const read = cache.prepare();
    const line = spyOn(editor, "lineTextForBufferRow").and.callThrough();
    for (const row of [0, 256, 512, 512, 0]) expect(read(row)).toBe(0.5);
    expect(cache.pages.size).toBe(2);
    expect(line.calls.count()).toBe(4);
  });
});
