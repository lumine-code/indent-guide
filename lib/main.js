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
  /**
   * Activates the package and sets up indent guide rendering for all editors.
   */
  activate() {
    this.disposables = new CompositeDisposable(
      lumine.config.observe("indent-guide.cursorAwareActive", (value) => {
        this.cursorAwareActive = value;
        this.updateAllEditors();
      }),
      lumine.commands.add("lumine-workspace", {
        "indent-guide:toggle-cursor-aware-active": {
          description: "Highlight only the indent guide the cursor sits inside.",
          didDispatch: () => {
            this.cursorAwareActive = !this.cursorAwareActive;
            this.updateAllEditors();
          },
        },
      }),
      lumine.workspace.observeTextEditors((editor) => {
        if (!editor) {
          return;
        }
        const editorElement = lumine.views.getView(editor);
        if (!editorElement) {
          return;
        }
        this.handleEvents(editor, editorElement);
      }),
    );
  },

  /**
   * Deactivates the package and removes all indent guides.
   */
  deactivate() {
    this.disposables.dispose();
    lumine.workspace.getTextEditors().forEach((editor) => {
      if (editor.component && editor.component.updateSyncAfterMeasuringContent_) {
        editor.component.updateSyncAfterMeasuringContent =
          editor.component.updateSyncAfterMeasuringContent_;
        delete editor.component.updateSyncAfterMeasuringContent_;
      }
      const view = lumine.views.getView(editor);
      if (!view) {
        return;
      }
      for (let e of view.querySelectorAll(".indent-guide-layer")) {
        e.remove();
      }
      for (let e of view.querySelectorAll(".indent-guide")) {
        e.remove();
      }
    });
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
  handleEvents(editor, editorElement) {
    const component = editor.component;
    if (!component || !component.updateSyncAfterMeasuringContent) {
      return;
    }
    component.updateSyncAfterMeasuringContent_ = component.updateSyncAfterMeasuringContent;
    component.updateSyncAfterMeasuringContent = () => {
      // The after-measure phase is scheduled asynchronously, so this can fire
      // after the editor is destroyed or re-pointed at another component —
      // both null editor.component, hence the captured reference and guard.
      if (editor.isAlive()) {
        this.updateGuide(editor, editorElement);
      }
      component.updateSyncAfterMeasuringContent_();
    };
  },
};
