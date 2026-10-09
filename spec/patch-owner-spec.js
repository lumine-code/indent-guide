describe("Indent Guide captured measurement patch ownership", () => {
  let main, editor, component, original, extras;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("a\n  b\n    c\nz\n");
    component = editor.component;
    original = spyOn(component, "updateSyncAfterMeasuringContent").and.callThrough();
    main = (await lumine.packages.activatePackage("indent-guide")).mainModule;
    extras = [];
    await conditionPromise(
      () => component.updateSyncAfterMeasuringContent_,
      "the actual component patch",
    );
  });
  afterEach(async () => {
    for (const resource of extras) resource.dispose();
    await lumine.packages.deactivatePackage("indent-guide");
    for (const item of lumine.workspace.getTextEditors()) item.destroy();
  });

  it("keeps a retained flush delegated once without rendering guides after retirement", async () => {
    const flush = component.updateSyncAfterMeasuringContent;
    await lumine.packages.deactivatePackage("indent-guide");
    spyOn(main, "updateGuide");
    original.calls.reset();
    expect(() => flush("normal")).not.toThrow();
    expect(original).toHaveBeenCalledOnceWith("normal");
    expect(main.updateGuide).not.toHaveBeenCalled();
    expect(lumine.views.getView(editor).querySelector(".indent-guide-layer")).toBeNull();
  });

  it("preserves a newer foreign measurement descriptor while retiring its old delegated wrapper", async () => {
    const flush = component.updateSyncAfterMeasuringContent;
    const foreign = (...args) => flush(...args);
    const descriptor = { configurable: true, enumerable: false, writable: true, value: foreign };
    Object.defineProperty(component, "updateSyncAfterMeasuringContent", descriptor);
    await lumine.packages.deactivatePackage("indent-guide");
    expect(Object.getOwnPropertyDescriptor(component, "updateSyncAfterMeasuringContent")).toEqual(
      descriptor,
    );
    original.calls.reset();
    expect(() => foreign("normal")).not.toThrow();
    expect(original).toHaveBeenCalledOnceWith("normal");
  });

  it("does not patch a new editor from an actual copied observer after an earlier callback retires the package", async () => {
    await lumine.packages.deactivatePackage("indent-guide");
    let armed = false;
    extras.push(
      lumine.workspace.observeTextEditors(() => {
        if (armed) main.deactivate();
      }),
    );
    main = (await lumine.packages.activatePackage("indent-guide")).mainModule;
    armed = true;
    const next = await lumine.workspace.open();
    expect(next.component.updateSyncAfterMeasuringContent_).toBeUndefined();
  });
});
