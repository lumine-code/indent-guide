const { CompositeDisposable } = require("lumine");
const { createElementsForGuides, styleGuide, segmentsForGuides } = require("./element");
const { getGuides } = require("./guides");
const IndentCache = require("./indent-cache");

/**
 * Indent Guide Package
 * Renders indentation guides with active line highlighting.
 */
module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "indent-guide",
      tips: [
        "The indentation guides enclosing the cursor are highlighted, so you always see which block you are in.",
      ],
    };
  },

  /**
   * Activates the package and sets up indent guide rendering for all editors.
   */
  activate() {
    const owner = {
      subscriptions: new CompositeDisposable(),
      patches: new Map(),
      elements: new Set(),
      indents: new WeakMap(),
      tasks: new Map(),
    };
    this.owner = owner;
    this.disposables = owner.subscriptions;
    const retain = (resource) => {
      if (this.owner === owner) owner.subscriptions.add(resource);
      else resource.dispose();
    };
    retain(
      lumine.config.observe("indent-guide.cursorAwareActive", (value) => {
        if (this.owner !== owner) return;
        this.cursorAwareActive = value;
        this.updateAllEditors();
      }),
    );
    if (this.owner !== owner) return;
    retain(
      lumine.commands.add("lumine-workspace", {
        "indent-guide:toggle-cursor-aware-active": {
          description: "Highlight only the indent guide the cursor sits inside.",
          didDispatch: () => {
            if (this.owner !== owner) return;
            this.cursorAwareActive = !this.cursorAwareActive;
            this.updateAllEditors();
          },
        },
      }),
    );
    if (this.owner !== owner) return;
    retain(
      lumine.workspace.observeTextEditors((editor) => {
        if (this.owner !== owner || !editor) {
          return;
        }
        const editorElement = lumine.views.getView(editor);
        if (!editorElement) {
          return;
        }
        this.handleEvents(editor, editorElement, owner);
        const subscriptions = new CompositeDisposable(
          editor.onDidChangeGrammar(() => {
            if (this.owner !== owner) return;
            owner.tasks.get(editor)?.controller.abort();
            owner.tasks.delete(editor);
            owner.indents.delete(editor);
            this.removeGuides(editorElement);
            this.updateGuide(editor, editorElement);
          }),
          editor.onDidDestroy(() => {
            subscriptions.dispose();
            owner.subscriptions.remove(subscriptions);
          }),
        );
        owner.subscriptions.add(subscriptions);
      }),
    );
  },

  /**
   * Deactivates the package and removes all indent guides.
   */
  deactivate() {
    const owner = this.owner;
    this.owner = null;
    this.disposables = null;
    if (!owner) return;
    for (const task of owner.tasks.values()) task.controller.abort();
    owner.tasks.clear();
    const patches = [...owner.patches.values()];
    for (const record of patches) record.retired = true;
    owner.patches.clear();
    for (const record of patches) this.restorePatch(record);
    for (const element of owner.elements) this.removeGuides(element);
    owner.elements.clear();
    owner.indents = new WeakMap();
    owner.subscriptions.dispose();
  },

  updateAllEditors() {
    if (!this.owner) return;
    lumine.workspace.getTextEditors().forEach((editor) => {
      const editorElement = lumine.views.getView(editor);
      if (editorElement) {
        this.updateGuide(editor, editorElement);
      }
    });
  },

  /**
   * Updates the indent guides for the visible portion of an editor.
   * @param {TextEditor} editor - The text editor
   * @param {Element} editorElement - The editor's DOM element
   */
  updateGuide(editor, editorElement) {
    const owner = this.owner;
    if (!owner) return;
    if (editor.getGrammar() === lumine.grammars.nullGrammar) {
      owner.tasks.get(editor)?.controller.abort();
      owner.tasks.delete(editor);
      owner.indents.delete(editor);
      this.removeGuides(editorElement);
      return;
    }
    const component = editorElement.component;
    if (!component || !component.visible || !component.hasInitialMeasurements) {
      return;
    }
    const startScreenRow = Math.max(0, editorElement.getFirstVisibleScreenRow() - 1);
    const endScreenRow = Math.min(
      editor.getScreenLineCount() - 1,
      editorElement.getLastVisibleScreenRow() + 1,
    );
    if (endScreenRow < startScreenRow) return;
    const cellWidth = editor.getTabLength() * editor.getDefaultCharWidth();
    if (!(cellWidth > 0)) return;
    const minColumn = Math.max(0, Math.floor(editorElement.getScrollLeft() / cellWidth) - 1);
    const maxColumn =
      Math.ceil((editorElement.getScrollLeft() + editorElement.getWidth()) / cellWidth) + 1;
    const cursorPositions = editor.getCursorBufferPositions().map((point) => ({
      row: editor.screenPositionForBufferPosition(point).row,
      bufferRow: point.row,
      column: point.column,
      level: this.cursorAwareActive ? null : Infinity,
    }));

    let indents = owner.indents.get(editor);
    if (!indents) owner.indents.set(editor, (indents = new IndentCache(editor)));
    indents.prepare();
    const buffer = indents.buffer;
    const revision = indents.revision;
    const key = JSON.stringify([
      indents.generation,
      startScreenRow,
      endScreenRow,
      minColumn,
      maxColumn,
      this.cursorAwareActive,
      cursorPositions,
    ]);
    const previous = owner.tasks.get(editor);
    const render = (guides) => {
      if (this.owner !== owner || editor.isDestroyed()) return;
      owner.elements.add(editorElement);
      const absolute = guides.map((guide) => ({
        ...guide,
        point: guide.point.translate([startScreenRow, 0]),
      }));
      const segments = segmentsForGuides(absolute, editor, editorElement);
      createElementsForGuides(
        editorElement,
        segments.map((segment) => (element) => styleGuide(element, segment)),
      );
    };
    if (previous?.key === key) {
      if (previous.guides) render(previous.guides);
      return;
    }
    previous?.controller.abort();
    const task = { key, controller: new AbortController(), guides: null };
    owner.tasks.set(editor, task);
    const getIndent = (screenRow, options) =>
      indents.read(editor.bufferPositionForScreenPosition([screenRow, 0]).row, options);
    const guides = getGuides(
      startScreenRow,
      endScreenRow,
      editor.getScreenLineCount() - 1,
      cursorPositions,
      getIndent,
      {
        minColumn,
        maxColumn,
        budgetMs: 4,
        signal: task.controller.signal,
        cursorLevel: (row, column, options) => indents.cursorLevel(row, column, options),
      },
    );
    const publish = (value) => {
      if (
        this.owner !== owner ||
        owner.tasks.get(editor) !== task ||
        task.controller.signal.aborted ||
        editor.isDestroyed() ||
        editor.getBuffer() !== buffer ||
        buffer.getTextRevision() !== revision ||
        editor
          .getCursorBufferPositions()
          .some(
            (point, index) =>
              point.row !== cursorPositions[index]?.bufferRow ||
              point.column !== cursorPositions[index]?.column,
          ) ||
        editor.getCursors().length !== cursorPositions.length
      )
        return;
      task.guides = value;
      render(value);
    };
    if (guides?.then) {
      createElementsForGuides(editorElement, []);
      guides.then(publish).catch((error) => {
        if (!task.controller.signal.aborted)
          console.error("Unable to compute indentation guides", error);
      });
    } else publish(guides);
  },

  /**
   * Sets up event handling to update guides when the editor content changes.
   * @param {TextEditor} editor - The text editor
   * @param {Element} editorElement - The editor's DOM element
   */
  handleEvents(editor, editorElement, owner = this.owner) {
    if (!owner || this.owner !== owner) return;
    const component = editor.component;
    if (!component || !component.updateSyncAfterMeasuringContent) {
      return;
    }
    if (owner.patches.has(component)) return;
    const descriptor = Object.getOwnPropertyDescriptor(
      component,
      "updateSyncAfterMeasuringContent",
    );
    if (descriptor && !descriptor.configurable && !descriptor.writable) return;
    const original = component.updateSyncAfterMeasuringContent;
    const slot = Object.getOwnPropertyDescriptor(component, "updateSyncAfterMeasuringContent_");
    const record = {
      component,
      descriptor,
      original,
      slot,
      retired: false,
      slotOwned: !slot || slot.configurable,
    };
    record.wrapper = (...args) => {
      const result = original.apply(component, args);
      // The after-measure phase is scheduled asynchronously, so this can fire
      // after the editor is destroyed or re-pointed at another component —
      // both null editor.component, hence the captured reference and guard.
      if (
        !record.retired &&
        this.owner === owner &&
        owner.patches.get(component) === record &&
        editor.isAlive() &&
        editor.component === component
      ) {
        this.updateGuide(editor, editorElement);
      }
      return result;
    };
    if (record.slotOwned)
      Object.defineProperty(component, "updateSyncAfterMeasuringContent_", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: original,
      });
    Object.defineProperty(component, "updateSyncAfterMeasuringContent", {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      writable: descriptor?.writable ?? true,
      value: record.wrapper,
    });
    owner.patches.set(component, record);
    const subscription = editor.onDidDestroy(() => {
      record.retired = true;
      if (owner.patches.get(component) === record) owner.patches.delete(component);
      this.restorePatch(record);
      owner.elements.delete(editorElement);
      owner.indents.delete(editor);
      owner.tasks.get(editor)?.controller.abort();
      owner.tasks.delete(editor);
      this.removeGuides(editorElement);
    });
    if (this.owner === owner && !record.retired) owner.subscriptions.add(subscription);
    else subscription.dispose();
    owner.subscriptions.add(
      editorElement.onDidChangeScrollTop(() => this.updateGuide(editor, editorElement)),
      editorElement.onDidChangeScrollLeft(() => this.updateGuide(editor, editorElement)),
    );
  },

  restorePatch({ component, descriptor, original, wrapper, slot, slotOwned }) {
    if (
      Object.getOwnPropertyDescriptor(component, "updateSyncAfterMeasuringContent")?.value ===
      wrapper
    ) {
      if (descriptor)
        Object.defineProperty(component, "updateSyncAfterMeasuringContent", descriptor);
      else delete component.updateSyncAfterMeasuringContent;
    }
    if (
      slotOwned &&
      Object.getOwnPropertyDescriptor(component, "updateSyncAfterMeasuringContent_")?.value ===
        original
    ) {
      if (slot) Object.defineProperty(component, "updateSyncAfterMeasuringContent_", slot);
      else delete component.updateSyncAfterMeasuringContent_;
    }
  },

  removeGuides(element) {
    for (const guide of element.querySelectorAll(".indent-guide-layer, .indent-guide"))
      guide.remove();
  },
};
