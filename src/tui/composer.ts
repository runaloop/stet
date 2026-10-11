import { TextareaRenderable, type CliRenderer } from "@opentui/core";
import type { Rect } from "./render.ts";
import { color } from "./screen.ts";
import { BG, FG } from "./style.ts";

/** The composer's text field, laid over the box the frame draws for it; hidden while nobody writes. */
export class ComposerView {
  private readonly field: TextareaRenderable;
  private changed: ((text: string) => void) | null = null;
  private rect: Rect | null = null;
  private shown = false;

  constructor(renderer: CliRenderer) {
    this.field = new TextareaRenderable(renderer, {
      id: "composer",
      position: "absolute",
      left: 0,
      top: 0,
      width: 10,
      height: 3,
      zIndex: 10,
      visible: false,
      wrapMode: "word",
      textColor: color(FG),
      focusedTextColor: color(FG),
      backgroundColor: color(BG),
      focusedBackgroundColor: color(BG),
      placeholderColor: color("#7f8b85"),
      // A blinking cursor would draw frames while nothing happens.
      cursorStyle: { style: "block", blinking: false },
      onContentChange: () => this.changed?.(this.field.plainText),
    });
    renderer.root.add(this.field);
  }

  get open(): boolean {
    return this.shown;
  }

  get text(): string {
    return this.field.plainText;
  }

  show(placeholder: string, text: string, changed: (text: string) => void): void {
    this.changed = null;
    this.field.placeholder = placeholder;
    this.field.setText(text);
    this.field.gotoBufferEnd();
    this.changed = changed;
    this.shown = true;
    this.rect = null;
    this.field.focus();
  }

  hide(): void {
    this.changed = null;
    this.field.blur();
    this.field.visible = false;
    this.shown = false;
    this.rect = null;
  }

  /** Moves the field onto the box; true when it moved, so the frame is drawn again with it in place. */
  place(r: Rect | null): boolean {
    if (!this.open) return false;
    if (!r) {
      if (!this.rect) return false;
      this.field.visible = false;
      this.rect = null;
      return true;
    }
    const same = this.rect && this.rect.x === r.x && this.rect.y === r.y && this.rect.w === r.w && this.rect.h === r.h;
    if (same) return false;
    this.rect = r;
    this.field.visible = true;
    this.field.left = r.x;
    this.field.top = r.y;
    this.field.width = r.w;
    this.field.height = r.h;
    // focus does not take on a hidden renderable
    this.field.focus();
    return true;
  }

  /** Takes back the `j` just typed when a second `j` turns the pair into Esc. */
  dropLastChar(): void {
    this.field.deleteCharBackward();
  }
}
