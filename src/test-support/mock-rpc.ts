// A tiny JSON-RPC node for integration tests. Real HTTP over loopback, so
// ethers' provider (and our own raw fetch() calls) go through their normal
// code paths instead of a mocked fetch that has to guess ethers' batching
// behavior.

import http, { Server } from "http";
import { AddressInfo } from "net";

export type RpcHandler = (params: any[]) => any;

export interface MockRpc {
  url: string;
  calls: { method: string; params: any[] }[];
  close: () => Promise<void>;
}

export function startMockRpc(handlers: Record<string, RpcHandler>): Promise<MockRpc> {
  const calls: { method: string; params: any[] }[] = [];

  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const requests = Array.isArray(body) ? body : [body];
      const responses = requests.map((r) => {
        calls.push({ method: r.method, params: r.params ?? [] });
        const handler = handlers[r.method];
        if (!handler) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "Method not found" } };
        }
        try {
          return { jsonrpc: "2.0", id: r.id, result: handler(r.params ?? []) };
        } catch (err: any) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: err.message } };
        }
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
