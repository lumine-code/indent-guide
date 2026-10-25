const path = require("node:path");

describe("indent-guide with no grammar", () => {
  let editor, main;
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage(path.join(__dirname, ".."))).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("root\n    child\n        nested\nend");
  });
  afterEach(() => editor?.destroy());

  it("clears guides and the indent cache before any further scan, then resumes", async () => {
    const element = editor.getElement();
    const grammar = lumine.grammars.grammarForScopeName("text.plain");
    editor.setGrammar(grammar);
    await conditionPromise(() => {
      main.updateGuide(editor, element);
      return element.querySelectorAll(".indent-guide").length > 0;
    });
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(element.querySelectorAll(".indent-guide").length).toBe(0);
    expect(main.owner.indents.has(editor)).toBe(false);
    spyOn(editor, "lineTextForBufferRow").and.callThrough();
    main.updateGuide(editor, element);
    expect(editor.lineTextForBufferRow).not.toHaveBeenCalled();
    editor.setGrammar(grammar);
    await conditionPromise(() => {
      main.updateGuide(editor, element);
      return element.querySelectorAll(".indent-guide").length > 0;
    });
    expect(main.owner.indents.has(editor)).toBe(true);
  });
});
