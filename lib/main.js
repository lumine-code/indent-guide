const { CompositeDisposable, Point } = require("lumine");
const { createElementsForGuides, styleGuide } = require("./element");
const { getGuides } = require("./guides");

// Cached regex for whitespace-only line detection
const WHITESPACE_REGEX = /^\s*$/;

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
    const patches = [...owner.patches.values()];
    for (const record of patches) record.retired = true;
    owner.patches.clear();
    for (const record of patches) this.restorePatch(record);
    for (const element of owner.elements) this.removeGuides(element);
    owner.elements.clear();
    owner.subscriptions.dispose();
  },

  /**
   * Creates a Point with safe NaN handling.
   * @param {number} x - The row value
   * @param {number} y - The column value
   * @returns {Point} A new Point with the coordinates
   */
  createPoint(x, y) {
    x = isNaN(x) ? 0 : x;
    y = isNaN(y) ? 0 : y;
    return new Point(x, y);
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
    const component = editorElement.component;
    if (!component || !component.visible || !component.hasInitialMeasurements) {
      return;
    }
    // Smooth scrolling moves the content transform without running a full
    // editor update, so no guide refresh happens until the viewport leaves the
    // mounted tiles. Guides live inside that transformed layer and track the
    // scroll for free — cover the whole rendered tile range rather than just
    // the visible rows, so every row a scroll frame can reveal already
    // carries its guides.
    const startScreenRow = component.getRenderedStartRow();
    const endScreenRow = component.getRenderedEndRow();
    if (endScreenRow <= startScreenRow) {
      return;
    }

    const visibleRange = [startScreenRow, endScreenRow - 1].map(
      (row) => editor.bufferPositionForScreenPosition(this.createPoint(row, 0)).row,
    );
    const tabLength = editor.getTabLength();
    const cursorPositions = editor.getCursorBufferPositions().map((point) => ({
      row: point.row,
      level: this.cursorAwareActive ? Math.floor(point.column / tabLength) : Infinity,
    }));

    const getIndent = (row) => {
      if (WHITESPACE_REGEX.test(editor.lineTextForBufferRow(row))) {
        return null;
      } else {
        return editor.indentationForBufferRow(row);
      }
    };
    const guides = getGuides(
      visibleRange[0],
      visibleRange[1] + 1,
      editor.getLastBufferRow(),
      cursorPositions,
      getIndent,
    );
    if (this.owner !== owner) return;
    owner.elements.add(editorElement);
    return createElementsForGuides(
      editorElement,
      guides.map(
        (g) => (el) =>
          styleGuide(
            el,
            g.point.translate(this.createPoint(visibleRange[0], 0)),
            g.length,
            g.stack,
            g.active,
            editor,
          ),
      ),
    );
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
      return original.apply(component, args);
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
      this.removeGuides(editorElement);
    });
    if (this.owner === owner && !record.retired) owner.subscriptions.add(subscription);
    else subscription.dispose();
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
