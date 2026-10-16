import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { boxKey } from "../keyinput.ts";
import { Kbd } from "./Bits.tsx";

export interface Option<T extends string> {
  value: T;
  label: string;
}

interface Question {
  id: number;
  title: string;
  body: ComponentChildren;
  options: Option<string>[];
  answer: (value: string | null) => void;
}

/** The question on screen; the page's keys are off while it is open. */
export const question = signal<Question | null>(null);

let asked = 0;

/** A dialog with the options and Cancel: the value picked, or null for Cancel, Esc or a click outside. */
export function ask<T extends string>(title: string, body: ComponentChildren, options: Option<T>[]): Promise<T | null> {
  question.value?.answer(null);
  return new Promise((resolve) => {
    const q: Question = {
      id: ++asked,
      title,
      body,
      options,
      answer: (value) => {
        if (question.value === q) question.value = null;
        resolve(value as T | null);
      },
    };
    question.value = q;
  });
}

export function ChoiceDialog() {
  const q = question.value;
  return q ? <Dialog key={q.id} q={q} /> : null;
}

function Dialog({ q }: { q: Question }) {
  const choices: { value: string | null; label: string }[] = [...q.options, { value: null, label: "Cancel" }];
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelectorAll("button")[sel]?.focus(), [sel]);
  const move = (dir: 1 | -1) => setSel((s) => (s + dir + choices.length) % choices.length);
  return (
    <div class="overlay" onClick={() => q.answer(null)}>
      <div
        class="choice"
        role="dialog"
        aria-modal="true"
        aria-label={q.title}
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          boxKey(e, "choice", { "choice.down": () => move(1), "choice.up": () => move(-1), "choice.pick": () => q.answer(choices[sel]!.value), "choice.cancel": () => q.answer(null) }, false);
        }}
      >
        <h3>{q.title}</h3>
        <div class="choice-body">{q.body}</div>
        <div class="choice-options">
          {choices.map((c, i) => (
            <button class={`btn${c.value === null ? " ghost" : ""}${i === sel ? " on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => q.answer(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
        <div class="hint">
          <Kbd>j</Kbd> <Kbd>k</Kbd> or <Kbd>↑</Kbd> <Kbd>↓</Kbd> · <Kbd>Enter</Kbd> choose · <Kbd>Esc</Kbd> cancel
        </div>
      </div>
    </div>
  );
}
