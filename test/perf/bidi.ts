export class Bidi {
  private ws: WebSocket;
  private id = 0;
  private waiters = new Map<number, (m: any) => void>();
  context = "";
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined) this.waiters.get(m.id)?.(m);
    };
  }
  static async connect(url: string): Promise<Bidi> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const b = new Bidi(ws);
    await b.send("session.new", { capabilities: {} });
    const tree = await b.send("browsingContext.getTree", {});
    b.context = tree.contexts[0].context;
    await b.navigate("about:blank");
    return b;
  }
  send(method: string, params: any): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waiters.set(id, (m) => (m.type === "error" ? reject(new Error(`${m.error}: ${m.message}`)) : resolve(m.result))));
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send("script.evaluate", { expression, target: { context: this.context }, awaitPromise: true, resultOwnership: "none" });
    if (r.type === "exception") throw new Error(JSON.stringify(r.exceptionDetails.text ?? r.exceptionDetails));
    return deser(r.result);
  }
  navigate(url: string) {
    return this.send("browsingContext.navigate", { context: this.context, url, wait: "complete" });
  }
  async screenshot(path: string) {
    const r = await this.send("browsingContext.captureScreenshot", { context: this.context });
    await Bun.write(path, Buffer.from(r.data, "base64"));
  }
  async viewport(width: number, height: number, devicePixelRatio?: number) {
    await this.send("browsingContext.setViewport", { context: this.context, viewport: { width, height }, ...(devicePixelRatio ? { devicePixelRatio } : {}) });
  }
  async close() { await this.send("session.end", {}).catch(() => null); this.ws.close(); }
}
function deser(v: any): any {
  if (!v) return v;
  if (v.type === "object") return Object.fromEntries(v.value.map(([k, x]: any) => [typeof k === "string" ? k : deser(k), deser(x)]));
  if (v.type === "array") return v.value.map(deser);
  return v.value;
}
