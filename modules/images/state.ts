import { effect, signal } from "@preact/signals";
import type { Region } from "../../src/core/types.ts";

export type ImageMode = "2-up" | "swipe" | "onion" | "diff";

function stored(): ImageMode {
  try {
    return (localStorage.getItem("stet.imageMode") as ImageMode | null) ?? "2-up";
  } catch {
    return "2-up";
  }
}

export const imageMode = signal<ImageMode>(stored());
effect(() => {
  try {
    localStorage.setItem("stet.imageMode", imageMode.value);
  } catch {
    return;
  }
});

/** An area drawn on an image of the diff, waiting for its first message. `file` is the diff item it was drawn in. */
export interface ImagePending {
  file: string;
  path: string;
  side: "new" | "old";
  sha: string;
  label: string;
  region: Region;
}
export const imagePending = signal<ImagePending | null>(null);
