import { BoxRenderable, RGBA, TextareaRenderable, type CliRenderer } from "@opentui/core";

/** The rows the composer takes at the bottom of a screen this high, its border included. */
export function composerHeight(rows: number): number {
  return Math.max(5, Math.min(12, Math.floor(rows / 3)));
}

/** A multi-line text field over the bottom of the page, above the footer; hidden while nobody writes. */
export class ComposerView {
  private readonly box: BoxRenderable;
  private readonly field: TextareaRenderable;
  private changed: ((text: string) => void) | null = null;

  constructor(private readonly renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      id: "composer",
      position: "absolute",
      left: 0,
      bottom: 1,
      width: "100%",
      height: composerHeight(renderer.height),
      zIndex: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: RGBA.fromIndex(6),
      backgroundColor: RGBA.defaultBackground(),
      titleColor: RGBA.fromIndex(6),
      visible: false,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.field = new TextareaRenderable(renderer, {
      id: "composer-text",
      width: "100%",
      flexGrow: 1,
      wrapMode: "word",
      textColor: RGBA.defaultForeground(),
      focusedTextColor: RGBA.defaultForeground(),
      backgroundColor: RGBA.defaultBackground(),
      focusedBackgroundColor: RGBA.defaultBackground(),
      placeholderColor: RGBA.fromIndex(8),
      // A blinking cursor would draw frames while nothing happens.
      cursorStyle: { style: "block", blinking: false },
      onContentChange: () => this.changed?.(this.field.plainText),
    });
    this.box.add(this.field);
    renderer.root.add(this.box);
    renderer.on("resize", (_w: number, h: number) => (this.box.height = composerHeight(h)));
  }

  get open(): boolean {
    return this.box.visible;
  }

  get text(): string {
    return this.field.plainText;
  }

  show(title: string, placeholder: string, text: string, changed: (text: string) => void): void {
    this.changed = null;
    this.box.title = ` ${title} `;
    this.field.placeholder = placeholder;
    this.field.setText(text);
    this.field.gotoBufferEnd();
    this.changed = changed;
    this.box.visible = true;
    this.field.focus();
  }

  hide(): void {
    this.changed = null;
    this.field.blur();
    this.box.visible = false;
  }

  /** Takes back the `j` just typed when a second `j` turns the pair into Esc. */
  dropLastChar(): void {
    this.field.deleteCharBackward();
  }
}
