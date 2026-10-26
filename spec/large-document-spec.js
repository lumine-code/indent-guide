const { getGuides } = require("../lib/guides");
const IndentCache = require("../lib/indent-cache");
const { TextEditor } = require("lumine");

describe("bounded indentation analysis", () => {
  beforeEach(() => jasmine.useRealClock());

  it("builds only the visible depths of an enormous indent without recursion", () => {
    const guides = getGuides(0, 2, 2, [{ row: 1, level: Infinity }], () => 1000000, {
      minColumn: 9990,
      maxColumn: 10000,
    });
    expect(guides.length).toBe(11);
    expect(guides[0].point.column).toBe(9990);
    expect(guides.at(-1).point.column).toBe(10000);
    expect(guides.every((guide) => guide.stack && !guide.active)).toBeTrue();
  });

  it("does not connect active blocks across a fractional indent outside the viewport", () => {
    const values = [1, 0.5, 1, 1, 1];
    const guides = getGuides(3, 4, 4, [{ row: 0, level: Infinity }], (row) => values[row]);
    expect(guides.length).toBe(1);
    expect(guides[0].stack).toBeFalse();
    expect(guides[0].active).toBeFalse();
  });

  it("yields and cancels while resolving an offscreen blank run without retaining its rows", async () => {
    const controller = new AbortController();
    let reads = 0;
    const pending = getGuides(
      0,
      5,
      10000000,
      [],
      () => {
        reads++;
        return null;
      },
      { minColumn: 0, maxColumn: 20, budgetMs: 1, signal: controller.signal },
    );
    expect(typeof pending.then).toBe("function");
    controller.abort();
    await expectAsync(pending).toBeRejected();
    expect(reads).toBeLessThan(10000000);
  });

  it("measures long indentation in bounded chunks and cancels retired reads", async () => {
    const editor = new TextEditor({ tabLength: 4 });
    try {
      editor.setText(" ".repeat(200000) + "x\n");
      const cache = new IndentCache(editor);
      cache.prepare();
      spyOn(editor, "lineTextForBufferRow").and.throwError("whole row");
      const controller = new AbortController();
      const pending = cache.read(0, { deadline: performance.now() - 1, signal: controller.signal });
      expect(typeof pending.then).toBe("function");
      controller.abort();
      await expectAsync(pending).toBeRejected();
      expect(await cache.read(0, { deadline: performance.now() + 1 })).toBe(50000);
      expect(cache.cursorLevel(0, 200000)).toBe(50000);
      expect(cache.pages.size).toBe(1);
    } finally {
      editor.destroy();
    }
  });
});

describe("viewport indentation geometry", () => {
  let main, editor, element;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-text");
    const workspace = lumine.workspace.getElement();
    workspace.style.height = "600px";
    jasmine.attachToDOM(workspace);
    main = (await lumine.packages.activatePackage("indent-guide")).mainModule;
    editor = await lumine.workspace.open();
    editor.setSoftWrapped(false);
    element = editor.getElement();
    element.style.height = "240px";
    element.setWidth(400);
    editor.component.didResize();
  });
  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("indent-guide");
  });

  async function ready() {
    await conditionPromise(() => {
      main.updateGuide(editor, element);
      return element.querySelectorAll(".indent-guide").length > 0;
    });
  }

  function bounded() {
    const nodes = [...element.querySelectorAll(".indent-guide")];
    expect(nodes.length).toBeLessThan(100);
    for (const node of nodes) {
      expect(parseFloat(node.style.top)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(node.style.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(node.style.left)).toBeLessThanOrEqual(element.getWidth());
      expect(parseFloat(node.style.top) + parseFloat(node.style.height)).toBeLessThanOrEqual(
        element.getHeight() + 0.01,
      );
    }
  }

  it("keeps guides inside the viewport beyond the browser's CSS height limit", async () => {
    editor.setText("  x\n".repeat(2000000));
    editor.setCursorBufferPosition([1999999, 2]);
    element.setScrollTop(Infinity);
    await ready();
    expect(element.getScrollTop()).toBeGreaterThan(16000000);
    bounded();
    expect(element.querySelector(".indent-guide-layer").parentElement).toBe(
      element.querySelector(".scroll-view"),
    );
  });

  it("renders a small horizontal slice of deep indentation and cancels on None", async () => {
    editor.setTabLength(4);
    editor.setText(" ".repeat(100000) + "x\n");
    editor.displayLayer.reset({ softWrapColumn: Infinity });
    editor.setCursorBufferPosition([0, 80000]);
    element.setScrollLeft(80000 * editor.getDefaultCharWidth());
    await ready();
    bounded();
    expect(Number(element.querySelector(".indent-guide").getAttribute("depth"))).toBeGreaterThan(
      1000,
    );
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(element.querySelector(".indent-guide-layer")).toBeNull();
    expect(main.owner.tasks.has(editor)).toBeFalse();
  });

  it("projects only visible screen rows across a fold spanning most of the document", async () => {
    editor.setText("root\n" + "  child\n".repeat(400000) + "  tail\nend\n");
    editor.foldBufferRange([
      [1, 0],
      [399990, 0],
    ]);
    editor.setCursorBufferPosition([400001, 2]);
    element.setScrollTop(Infinity);
    const read = spyOn(editor, "lineTextForBufferRow").and.throwError("whole row");
    try {
      await ready();
      bounded();
    } finally {
      read.and.callThrough();
    }
    expect(editor.getScreenLineCount()).toBeLessThan(30);
    expect(main.owner.indents.get(editor).pages.size).toBeLessThan(5);
  });
});
