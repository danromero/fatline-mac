import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { approveDevice, approveNetworkKey, custodyAddress, Ed25519Key, signSession } from "../client/keys.ts";
import { deviceKeyTypedData, networkHost, networkKeyText, networkOrigin, parseInvite, sessionText } from "../src/protocol/approvals.ts";
import { fromHex, toHex } from "../src/protocol/protobuf.ts";
import { deviceApprover, deviceKeyDigest, networkApprovalIsValid, sessionSignatureIsValid } from "../src/protocol/verify.ts";

// A well-known test phrase. Its first address holds nothing.
const PHRASE = "test test test test test test test test test test test junk";
const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const now = new Date("2026-11-11T12:00:00Z");

describe("device key approval", () => {
  test("the phrase gives the address the apps derive", () => {
    assert.equal(custodyAddress(PHRASE), ADDRESS);
    assert.equal(custodyAddress(`  ${PHRASE.toUpperCase().replaceAll(" ", "   ")}\n`), ADDRESS);
  });

  test("viem and the hand-written digest agree, and both recover the custody address", async () => {
    const device = Ed25519Key.random();
    const identity = await approveDevice(PHRASE, 3, device, now);
    const typed = deviceKeyTypedData(3, device.publicKey, identity.approval.issuedAt);
    assert.equal(toHex(deviceKeyDigest(3, device.publicKey, identity.approval.issuedAt)), hashTypedData(typed));

    const signature = fromHex(identity.approval.signature)!;
    assert.equal(signature.length, 65);
    assert.ok([27, 28].includes(signature[64]!));
    assert.equal((await recoverTypedDataAddress({ ...typed, signature: identity.approval.signature as `0x${string}` })).toLowerCase(), ADDRESS);
    assert.equal(deviceApprover(3, device.publicKey, identity.approval), ADDRESS);
  });

  test("changing the FID, key, or time recovers someone else", async () => {
    const device = Ed25519Key.random();
    const { approval } = await approveDevice(PHRASE, 3, device, now);
    assert.notEqual(deviceApprover(4, device.publicKey, approval), ADDRESS);
    assert.notEqual(deviceApprover(3, Ed25519Key.random().publicKey, approval), ADDRESS);
    assert.notEqual(deviceApprover(3, device.publicKey, { ...approval, issuedAt: approval.issuedAt + 1 }), ADDRESS);
  });

  test("malformed signatures recover nobody", () => {
    const key = Ed25519Key.random().publicKey;
    assert.equal(deviceApprover(3, key, { issuedAt: 1, signature: "0x1234" }), null);
    assert.equal(deviceApprover(3, key, { issuedAt: 1, signature: "0x" + "00".repeat(64) + "1d" }), null);
    assert.equal(deviceApprover(3, key, { issuedAt: 1, signature: "0x" + "00".repeat(64) + "1b" }), null);
  });
});

describe("network keys and sessions", () => {
  test("the signed text is exactly what the spec shows", () => {
    const key = fromHex("0x" + "1f".repeat(32))!;
    assert.equal(
      networkKeyText("friends.example.com", 3, key, 1762876800),
      `Fatline network key\nnetwork: friends.example.com\nfid: 3\nkey: 0x${"1f".repeat(32)}\nissued: 1762876800`,
    );
    assert.equal(
      sessionText("friends.example.com", 3, 1762876800, "0x" + "ab".repeat(16)),
      `Fatline session\nnetwork: friends.example.com\nfid: 3\nissued: 1762876800\nnonce: 0x${"ab".repeat(16)}`,
    );
  });

  test("a network key approval checks out only for its own network, FID, and keys", async () => {
    const identity = await approveDevice(PHRASE, 3, Ed25519Key.random(), now);
    const networkKey = Ed25519Key.random();
    const approval = approveNetworkKey(identity, "friends.example.com", networkKey, now);
    const device = identity.device.publicKey;
    assert.ok(networkApprovalIsValid("friends.example.com", 3, device, networkKey.publicKey, approval));
    assert.ok(!networkApprovalIsValid("other.example.com", 3, device, networkKey.publicKey, approval), "replayed on another network");
    assert.ok(!networkApprovalIsValid("friends.example.com", 4, device, networkKey.publicKey, approval));
    assert.ok(!networkApprovalIsValid("friends.example.com", 3, Ed25519Key.random().publicKey, networkKey.publicKey, approval));
    assert.ok(!networkApprovalIsValid("friends.example.com", 3, device, Ed25519Key.random().publicKey, approval));
    assert.ok(!networkApprovalIsValid("friends.example.com", 3, device, networkKey.publicKey, { ...approval, issued: approval.issued + 1 }));
  });

  test("a session signature checks out only for its own network, time, and nonce", () => {
    const networkKey = Ed25519Key.random();
    const { issued, nonce, signature } = signSession(3, "friends.example.com", networkKey, now);
    assert.ok(sessionSignatureIsValid("friends.example.com", 3, networkKey.publicKey, issued, nonce, signature));
    assert.ok(!sessionSignatureIsValid("other.example.com", 3, networkKey.publicKey, issued, nonce, signature));
    assert.ok(!sessionSignatureIsValid("friends.example.com", 3, networkKey.publicKey, issued + 1, nonce, signature));
    assert.ok(!sessionSignatureIsValid("friends.example.com", 3, networkKey.publicKey, issued, "0x" + "00".repeat(16), signature));
    assert.ok(!sessionSignatureIsValid("friends.example.com", 3, networkKey.publicKey, issued, nonce, "0x12"));
  });

  test("two sign-ins in the same second sign different text", () => {
    const networkKey = Ed25519Key.random();
    assert.notEqual(signSession(3, "friends.example.com", networkKey, now).signature, signSession(3, "friends.example.com", networkKey, now).signature);
  });
});

describe("addresses and invites", () => {
  test("hosts", () => {
    assert.equal(networkHost("Friends.Example.com"), "friends.example.com");
    assert.equal(networkHost("https://friends.example.com/"), "friends.example.com");
    assert.equal(networkHost("friends.example.com:8443"), "friends.example.com:8443");
    assert.equal(networkHost("http://localhost:8787"), "localhost:8787");
    assert.equal(networkHost("http://friends.example.com"), null);
    assert.equal(networkHost("https://friends.example.com/path"), null);
    assert.equal(networkHost("https://user@friends.example.com"), null);
    assert.equal(networkHost("https://friends.example.com/?a=1"), null);
    assert.equal(networkHost(""), null);
  });

  test("origins", () => {
    assert.equal(networkOrigin("friends.example.com"), "https://friends.example.com");
    assert.equal(networkOrigin("localhost:8787"), "http://localhost:8787");
  });

  test("invites", () => {
    assert.deepEqual(parseInvite("ABC-123@friends.example.com"), { code: "ABC-123", host: "friends.example.com" });
    assert.deepEqual(parseInvite(" a.b_c~d@Friends.Example.com:8443 "), { code: "a.b_c~d", host: "friends.example.com:8443" });
    assert.equal(parseInvite("@friends.example.com"), null);
    assert.equal(parseInvite("ABC@"), null);
    assert.equal(parseInvite("A B@friends.example.com"), null);
    assert.equal(parseInvite("x".repeat(129) + "@friends.example.com"), null);
  });
});
