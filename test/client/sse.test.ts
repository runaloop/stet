import { expect, test } from "bun:test";
import { sseMessages } from "../../src/client/sse.ts";

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });

test("messages come whole however the stream is cut, without comments or retry", async () => {
  const text = "retry: 2000\n\nevent: hello\ndata: {\"build\":\"dev\"}\n\n: ping\n\nid: 7\nevent: change\ndata: {\"seq\":7}\n\ndata: a\r\ndata:b\r\n\r\n";
  const want = [
    { event: "hello", data: '{"build":"dev"}', id: null },
    { event: "change", data: '{"seq":7}', id: "7" },
    { event: "message", data: "a\nb", id: "7" },
  ];
  for (const size of [1, 3, text.length]) {
    const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
    const got = [];
    for await (const m of sseMessages(streamOf(chunks))) got.push(m);
    expect(got).toEqual(want);
  }
});

test("a message the stream breaks off before its blank line is dropped", async () => {
  const got = [];
  for await (const m of sseMessages(streamOf(["event: store\ndata: {\"kinds\":[\"reads\"]}\n\nevent: store\ndata: {"]))) got.push(m.data);
  expect(got).toEqual(['{"kinds":["reads"]}']);
});
