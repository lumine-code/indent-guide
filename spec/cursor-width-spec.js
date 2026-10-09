describe("Indent guides at visual tab stops", () => {
  let main;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    lumine.config.set("indent-guide.cursorAwareActive", true);
    main = (await lumine.packages.activatePackage("indent-guide")).mainModule;
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("indent-guide")) {
      await lumine.packages.deactivatePackage("indent-guide");
      await lumine.packages.unloadPackage("indent-guide");
    }
  });

  for (const [name, outer, inner] of [
    ["spaces", "    ", "        "],
    ["hard tabs", "\t", "\t\t"],
    ["mixed spaces and tabs", " \t", " \t\t"],
  ]) {
    it(`marks the same inner guide when the indentation uses ${name}`, async () => {
      const editor = await lumine.workspace.open();
      editor.setTabLength(4);
      editor.setSoftTabs(false);
      editor.setSoftWrapped(false);
      editor.setText(`root\n${outer}one\n${inner}two\n${outer}tail\nend\n`);
      editor.setCursorBufferPosition([2, inner.length]);
      const element = lumine.views.getView(editor);
      await conditionPromise(() => {
        main.updateGuide(editor, element);
        return element.querySelectorAll(".indent-guide-layer .indent-guide").length === 2;
      });
      expect(editor.indentationForBufferRow(2)).toBe(2);
      expect(element.querySelector(".indent-guide[depth='1']").classList).toContain(
        "indent-guide-active",
      );
      expect(element.querySelector(".indent-guide[depth='0']").classList).not.toContain(
        "indent-guide-active",
      );
    });
  }
});
