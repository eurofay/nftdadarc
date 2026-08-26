import { describe, it, expect } from "vitest";
import { parseRpcEndpoints, prepareBlast } from "./rpc-blast";

describe("parseRpcEndpoints", () => {
  it("labels known providers by name", () => {
    const labels = parseRpcEndpoints([
      "https://base-mainnet.g.alchemy.com/v2/key",
      "https://mainnet-sequencer.base.org",
      "https://ethereum-rpc.publicnode.com",
      "https://cloudflare-eth.com",
    ]).map((e) => e.label);
    expect(labels).toEqual([
      "ALCHEMY",
      "mainnet-sequencer.base.org",
      "PUBLICNODE",
      "CLOUDFLARE",
    ]);
  });

  it("falls back to the hostname for an unrecognized provider", () => {
    const [ep] = parseRpcEndpoints(["https://my-own-node.example.com"]);
    expect(ep.label).toBe("my-own-node.example.com");
  });

  it("falls back to an indexed placeholder for an unparsable URL", () => {
    const [ep] = parseRpcEndpoints(["not-a-url"]);
    expect(ep.label).toBe("RPC[0]");
  });

  it("preserves the original url alongside the label", () => {
    const [ep] = parseRpcEndpoints(["https://mainnet.base.org"]);
    expect(ep.url).toBe("https://mainnet.base.org");
  });
});

describe("prepareBlast", () => {
  it("derives the tx hash as the keccak256 of the raw tx", () => {
    // Known vector: keccak256("0x00") == this hash.
    const { txHash } = prepareBlast("0x00");
    expect(txHash).toBe("0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a");
  });

  it("wraps the raw tx in a well-formed eth_sendRawTransaction JSON-RPC body", () => {
    const { body } = prepareBlast("0xdeadbeef");
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: ["0xdeadbeef"],
      id: 1,
    });
  });
});
