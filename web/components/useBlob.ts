import { useEffect, useState } from "preact/hooks";
import { api, type BlobDto } from "../api.ts";

export function useBlob(sha: string | null, path: string | null): BlobDto | null | "loading" {
  const [blob, setBlob] = useState<BlobDto | null | "loading">("loading");
  useEffect(() => {
    let live = true;
    if (!sha || !path) {
      setBlob(null);
      return;
    }
    setBlob("loading");
    api.blob(sha, path).then(
      (b) => live && setBlob(b),
      () => live && setBlob(null),
    );
    return () => {
      live = false;
    };
  }, [sha, path]);
  return blob;
}
