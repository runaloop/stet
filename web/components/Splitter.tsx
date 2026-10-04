import { signal } from "@preact/signals";

const widths = signal<Record<string, number | null>>({});

function stored(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(`stet.w.${key}`));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function widthOf(key: string): number | null {
  const w = widths.value;
  return key in w ? w[key]! : stored(key);
}

export function setWidth(key: string, value: number | null): void {
  widths.value = { ...widths.value, [key]: value };
  try {
    if (value === null) localStorage.removeItem(`stet.w.${key}`);
    else localStorage.setItem(`stet.w.${key}`, String(value));
  } catch {
    return;
  }
}

export function Splitter(props: { id: string; kind: string; target: () => HTMLElement | null; grows: "right" | "left"; min: number; max: () => number }) {
  const down = (e: PointerEvent) => {
    const el = props.target();
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const start = e.clientX;
    const from = el.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const dx = props.grows === "right" ? ev.clientX - start : start - ev.clientX;
      setWidth(props.id, Math.round(Math.max(props.min, Math.min(props.max(), from + dx))));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    <div class={`splitter ${props.kind}`} role="separator" aria-orientation="vertical" title="drag to resize · double-click resets" onPointerDown={down} onDblClick={() => setWidth(props.id, null)}>
      <span class="grip" />
    </div>
  );
}
