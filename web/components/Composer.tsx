import { useEffect, useRef, useState } from "preact/hooks";
import { Kbd } from "./Bits.tsx";

export function loadText(key: string | undefined): string | null {
  if (!key) return null;
  try {
    return localStorage.getItem(`stet.text.${key}`);
  } catch {
    return null;
  }
}

export function saveText(key: string | undefined, text: string): void {
  if (!key) return;
  try {
    if (text.trim()) localStorage.setItem(`stet.text.${key}`, text);
    else localStorage.removeItem(`stet.text.${key}`);
  } catch {
    return;
  }
}

export interface ComposerProps {
  storageKey?: string;
  placeholder?: string;
  initial?: string;
  autoFocus?: boolean;
  focusSignal?: number;
  append?: { seq: number; text: string } | null;
  primaryLabel?: string;
  secondaryLabel?: string | null;
  onSubmit: (body: string, mode: "draft" | "now") => Promise<boolean | void>;
  onCancel?: () => void;
  onEscape?: (el: HTMLTextAreaElement) => void;
  compact?: boolean;
  /** Saving with no text is fine, e.g. a draft that carries a restore request. */
  allowEmpty?: boolean;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState(() => loadText(props.storageKey) ?? props.initial ?? "");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastJ = useRef(0);

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, []);
  useEffect(() => {
    if (props.focusSignal) ref.current?.focus();
  }, [props.focusSignal]);
  const appended = useRef(props.append?.seq ?? 0);
  useEffect(() => {
    const a = props.append;
    if (!a || a.seq <= appended.current) return;
    appended.current = a.seq;
    setText((prev) => {
      const value = prev.trim() ? `${prev.replace(/\s*$/, "")}\n\n${a.text}` : a.text;
      saveText(props.storageKey, value);
      return value;
    });
    ref.current?.focus();
  }, [props.append?.seq]);

  const send = async (mode: "draft" | "now") => {
    if ((!text.trim() && !props.allowEmpty) || busy) return;
    setBusy(true);
    const ok = await props.onSubmit(text, mode);
    setBusy(false);
    if (ok !== false) {
      setText("");
      saveText(props.storageKey, "");
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send(e.shiftKey && props.secondaryLabel !== null ? "now" : "draft");
    } else if (e.code === "KeyS" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void send("draft");
    } else if (e.key === "Escape" || (e.key === "j" && lastJ.current > Date.now() - 300 && text.endsWith("j"))) {
      e.preventDefault();
      const el = e.target as HTMLTextAreaElement;
      if (e.key === "j") {
        const value = text.slice(0, -1);
        setText(value);
        saveText(props.storageKey, value);
      }
      if (props.onEscape) props.onEscape(el);
      else {
        el.blur();
        props.onCancel?.();
      }
    }
    lastJ.current = e.key === "j" ? Date.now() : 0;
  };

  return (
    <div class={`composer${props.compact ? " compact" : ""}`}>
      <textarea
        ref={ref}
        value={text}
        placeholder={props.placeholder ?? "Write a comment…"}
        rows={props.compact ? 3 : 4}
        onInput={(e) => {
          const value = (e.target as HTMLTextAreaElement).value;
          setText(value);
          saveText(props.storageKey, value);
        }}
        onKeyDown={onKey}
        disabled={busy}
      />
      <div class="composer-actions">
        <span class="hint">
          <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> or <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> {props.primaryLabel?.toLowerCase() ?? "save draft"}
          {props.secondaryLabel !== null ? <> · <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> {props.secondaryLabel?.toLowerCase() ?? "send now"}</> : null}
        </span>
        {props.onCancel ? (
          <button
            class="btn ghost"
            onClick={() => {
              saveText(props.storageKey, "");
              props.onCancel?.();
            }}
          >
            Cancel
          </button>
        ) : null}
        {props.secondaryLabel !== null ? (
          <button class="btn" disabled={busy || !text.trim()} onClick={() => void send("now")}>{props.secondaryLabel ?? "Send now"}</button>
        ) : null}
        <button class="btn primary" disabled={busy || (!text.trim() && !props.allowEmpty)} onClick={() => void send("draft")}>{props.primaryLabel ?? "Save draft"}</button>
      </div>
    </div>
  );
}
