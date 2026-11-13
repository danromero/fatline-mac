import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { Ed25519Key } from "../client/keys.ts";
import { toHex } from "../src/protocol/protobuf.ts";
import { deviceApprover } from "../src/protocol/verify.ts";

/**
 * The Mac and iPhone apps sign the device key approval with the bundled recovery helper, run in
 * JavaScriptCore. This runs that same file and checks its signature with the server's verifier.
 */

const PHRASE = "test test test test test test test test test test test junk";
const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

interface Account {
  address: string;
  approveDevice(fid: string, key: string, issuedAt: number): string;
}

function helper(): (phrase: string) => Account | null {
  const source = readFileSync(new URL("../../apple/Shared/Recovery/authorize.js", import.meta.url), "utf8");
  // A bare context, close to the JavaScriptCore one the apps use: no TextEncoder, no network.
  const context = createContext({});
  runInContext(source, context);
  return context.recoverFarcasterAccount as (phrase: string) => Account | null;
}

describe("the apps' recovery helper", () => {
  test("approves a device key that the server accepts", () => {
    const account = helper()(PHRASE);
    assert.ok(account);
    assert.equal(account.address.toLowerCase(), ADDRESS);
    const device = Ed25519Key.random();
    const issuedAt = 1_794_400_000;
    const signature = account.approveDevice("3", toHex(device.publicKey), issuedAt);
    assert.match(signature, /^0x[0-9a-f]{128}(1b|1c)$/);
    assert.equal(deviceApprover(3, device.publicKey, { issuedAt, signature }), ADDRESS);
    assert.notEqual(deviceApprover(4, device.publicKey, { issuedAt, signature }), ADDRESS);
  });

  test("refuses something that isn't a phrase", () => {
    assert.equal(helper()("not a phrase at all"), null);
  });
});
