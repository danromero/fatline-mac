import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addressBlock, isPublicHost } from "../src/server/hosts.ts";

/** The hosts the server fetches avatars and link previews from. Nothing here looks up a name. */

function refuses(hosts: string[]) {
  for (const host of hosts) assert.equal(isPublicHost(host), false, host);
}

describe("hosts the server may fetch", () => {
  test("public names and addresses pass", () => {
    for (const host of ["example.com", "pictures.example", "1.1.1.1", "8.8.8.8", "[2606:4700:4700::1111]", "2a00:1450:4001:80b::200e",
      "2001:4860:4860::8888", "[2001:4860:4860:0:0:0:0:8888]", "imgur.com."]) {
      assert.equal(isPublicHost(host), true, host);
    }
  });

  test("local names, and private and reserved IPv4", () => {
    refuses(["localhost", "localhost.", "a.localhost", "printer.local", "metadata.internal", "intranet",
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "255.255.255.255"]);
  });

  test("IPv4 spelled another way", () => {
    refuses(["127.1", "0x7f000001", "2130706433", "0177.0.0.1", "0x7f.0.0.1", "999.1.1.1", "1.2.3.04"]);
  });

  test("private and reserved IPv6", () => {
    refuses(["::", "::1", "[::1]", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "100::1", "4000::1"]);
  });

  test("IPv4-mapped IPv6, whatever the address inside", () => {
    refuses(["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "[::FFFF:7F00:1]", "0:0:0:0:0:ffff:7f00:1", "::ffff:10.0.0.1",
      "::ffff:8.8.8.8", "::ffff:0:7f00:1"]);
  });

  test("IPv4-compatible IPv6", () => {
    refuses(["::7f00:1", "[::7f00:1]", "::127.0.0.1", "::a00:1", "0:0:0:0:0:0:a00:1", "::8.8.8.8"]);
  });

  test("NAT64", () => {
    refuses(["64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "[64:ff9b::a9fe:a9fe]", "0064:ff9b:0000:0000:0000:0000:0a00:0001", "64:ff9b::808:808", "64:ff9b:1::1"]);
  });

  test("6to4 and Teredo", () => {
    refuses(["2002::1", "2002:7f00:1::1", "2002:c0a8:101::1", "[2002:a00:1::]", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:0000:abcd::1", "2001:db8::1", "2001:DB8::1"]);
  });

  test("things that aren't addresses", () => {
    refuses(["1::2::3", ":::", "12345::", "::g", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", ":1::", "fe80::1%en0", "::ffff:300.0.0.1", "2001:db8::1.2.3"]);
  });

  test("hosts as a URL gives them, after its own rewriting", () => {
    for (const link of ["https://[::ffff:127.0.0.1]/", "https://[::127.0.0.1]/", "https://[64:ff9b::10.0.0.1]/", "https://0x7f.1/",
      "https://2130706433/", "https://[2002:7f00:1::]/", "https://[2001::7f00:1]/"]) {
      assert.equal(isPublicHost(new URL(link).hostname), false, link);
    }
    assert.equal(isPublicHost(new URL("https://example.com/a.png").hostname), true);
  });
});

describe("addresses for rate limits", () => {
  test("IPv6 counts by its /64, and IPv4 as it is", () => {
    assert.equal(addressBlock("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
    assert.equal(addressBlock("2001:db8:1:2::1"), "2001:db8:1:2::/64");
    assert.equal(addressBlock("2001:DB8:1:2:ffff::"), "2001:db8:1:2::/64");
    assert.equal(addressBlock("2001:db8::1"), "2001:db8:0:0::/64");
    assert.notEqual(addressBlock("2001:db8:1:3::1"), addressBlock("2001:db8:1:2::1"));
    assert.equal(addressBlock("203.0.113.9"), "203.0.113.9");
    assert.equal(addressBlock("local"), "local");
  });
});
