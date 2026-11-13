// A scripted client for Fatline networks. Run `npm run client -- help`.
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { english, generateMnemonic } from "viem/accounts";
import { networkHost, parseInvite } from "../src/protocol/approvals.ts";
import { fidOf, DEFAULT_RPC } from "../src/protocol/chain.ts";
import { imageURL, makeLike, makePost, makeRemoval, makeUnlike } from "../src/protocol/messages.ts";
import type { Embed, PostRef } from "../src/protocol/messages.ts";
import { toHex } from "../src/protocol/protobuf.ts";
import { NetworkClient } from "./client.ts";
import { clientFrom, identityFrom, keyFileFor, readKeyFile, remember, writeKeyFile } from "./keyfile.ts";
import type { KeyFile } from "./keyfile.ts";
import { approveDevice, approveNetworkKey, custodyAddress, Ed25519Key } from "./keys.ts";

const HELP = `Usage: npm run client -- <command> [options]

  sample                         Print a join request and one signed message of each type. Uses new
                                 keys and a new phrase, and sends nothing.
  device --keys FILE [--fid N]   Approve a device key with the phrase in FATLINE_PHRASE. Looks up
                                 the FID on Optimism unless --fid is given.
  join TARGET --keys FILE        Ask to join. TARGET is an address or CODE@host. [--avatar URL]
  session HOST --keys FILE       Sign in, once the admin has let you in.
  post HOST TEXT --keys FILE     [--image PATH]... [--link URL]... [--quote FID:HASH] [--reply FID:HASH]
  like | unlike HOST FID:HASH --keys FILE
  delete HOST HASH --keys FILE
  network | feed | members | activity | admin-link HOST --keys FILE
  thread HOST HASH --keys FILE

  For the admin:
  requests | invites | blocks | reports | log HOST --keys FILE
  approve | refuse | remove | unblock HOST FID --keys FILE
  invite HOST --keys FILE [--code CODE] [--uses N | --uses unlimited]
  settings HOST --keys FILE [--name NAME] [--retention "30 days" | --retention forever]

Keys are kept in FILE in plain text. Use this only for testing.
The phrase is read from FATLINE_PHRASE so it stays out of shell history.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    keys: { type: "string" },
    fid: { type: "string" },
    avatar: { type: "string" },
    image: { type: "string", multiple: true },
    link: { type: "string", multiple: true },
    quote: { type: "string" },
    reply: { type: "string" },
    rpc: { type: "string" },
    code: { type: "string" },
    uses: { type: "string" },
    name: { type: "string" },
    retention: { type: "string" },
  },
});
const [command, ...rest] = positionals;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadKeys(): KeyFile {
  if (!values.keys) fail("Needs --keys FILE");
  if (!existsSync(values.keys)) fail(`No key file at ${values.keys}. Run device first.`);
  return readKeyFile(values.keys);
}

function saveKeys(keys: KeyFile) {
  writeKeyFile(values.keys!, keys);
}

function clientFor(keys: KeyFile, host: string): NetworkClient {
  return clientFrom(keys, host) ?? fail(`Not joined to ${host}. Run join first.`);
}

function hostArgument(text: string | undefined): string {
  const host = text ? networkHost(text) : null;
  if (!host) fail(`Not a network address: ${text ?? "(none)"}`);
  return host;
}

function postRef(text: string | undefined): PostRef {
  const match = /^(\d+):(0x[0-9a-fA-F]{40})$/.exec(text ?? "");
  if (!match) fail(`Expected FID:HASH, got ${text ?? "(none)"}`);
  return { fid: Number(match[1]), hash: match[2]!.toLowerCase() };
}

const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif" } as const;

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main() {
  switch (command) {
    case undefined:
    case "help":
      console.log(HELP);
      return;

    case "sample": {
      const phrase = generateMnemonic(english);
      const host = "friends.example.com";
      const identity = await approveDevice(phrase, 1, Ed25519Key.random());
      const networkKey = Ed25519Key.random();
      const client = new NetworkClient(identity, { host, networkKey, approval: approveNetworkKey(identity, host, networkKey) });
      const target = { fid: 1, hash: "0x" + "ab".repeat(20) };
      const messages = {
        post: await makePost(1, { text: "Dinner at 7? @alice", handles: new Map([["alice", 2]]) }, networkKey),
        postWithEmbeds: await makePost(1, { text: "Menu", embeds: [{ url: imageURL(host, "0123456789abcdef") }, { url: "https://example.com/menu" }] }, networkKey),
        reply: await makePost(1, { text: "In", parent: target }, networkKey),
        quote: await makePost(1, { text: "This one", embeds: [{ post: target }] }, networkKey),
        removal: await makeRemoval(1, target.hash, networkKey),
        like: await makeLike(1, target, networkKey),
        unlike: await makeUnlike(1, target, networkKey),
      };
      print({
        custody: identity.custody,
        joinRequest: client.joinRequest({ invite: "SAMPLE" }),
        messages: Object.fromEntries(Object.entries(messages).map(([name, message]) => [name, { hash: message.hash, bytes: toHex(message.bytes) }])),
      });
      return;
    }

    case "device": {
      if (!values.keys) fail("Needs --keys FILE");
      const phrase = process.env.FATLINE_PHRASE;
      if (!phrase) fail("Set FATLINE_PHRASE to the recovery phrase.");
      const custody = custodyAddress(phrase);
      const fid = values.fid ? Number(values.fid) : await fidOf(custody, values.rpc ?? DEFAULT_RPC);
      if (!fid) fail(`No FID belongs to ${custody}.`);
      const identity = await approveDevice(phrase, fid, Ed25519Key.random());
      const existing = existsSync(values.keys) ? loadKeys() : undefined;
      saveKeys(keyFileFor(identity, existing?.fid === fid ? existing.networks : {}));
      console.log(`Approved a device key for FID ${fid}, custody ${identity.custody}.`);
      return;
    }

    case "join": {
      const keys = loadKeys();
      const invite = parseInvite(rest[0] ?? "");
      const host = invite?.host ?? hostArgument(rest[0]);
      const client = keys.networks[host] ? clientFor(keys, host) : NetworkClient.forNetwork(identityFrom(keys), host);
      const status = await client.join({ invite: invite?.code, avatar: values.avatar });
      saveKeys(remember(keys, client));
      console.log(status);
      return;
    }

    case "session": {
      const keys = loadKeys();
      const host = hostArgument(rest[0]);
      const client = clientFor(keys, host);
      const status = await client.signIn();
      saveKeys(remember(keys, client));
      console.log(status);
      return;
    }

    case "post": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      const embeds: Embed[] = [];
      for (const path of values.image ?? []) {
        const type = IMAGE_TYPES[extname(path).toLowerCase() as keyof typeof IMAGE_TYPES];
        if (!type) fail(`Only JPEG, PNG, and GIF: ${path}`);
        const image = await client.uploadImage(readFileSync(path), type);
        embeds.push({ url: image.url });
      }
      for (const url of values.link ?? []) embeds.push({ url });
      if (values.quote) embeds.push({ post: postRef(values.quote) });
      const handles = new Map((await client.members()).map((member) => [member.username.toLowerCase(), member.fid]));
      const draft = { text: rest[1] ?? "", handles, embeds };
      const hash = values.reply ? await client.reply(postRef(values.reply), draft) : await client.post(draft);
      console.log(hash);
      return;
    }

    case "like":
    case "unlike": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      console.log(await (command === "like" ? client.like(postRef(rest[1])) : client.unlike(postRef(rest[1]))));
      return;
    }

    case "delete": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      console.log(await client.remove(rest[1] ?? fail("Needs a hash")));
      return;
    }

    case "network":
    case "feed":
    case "members":
    case "activity":
    case "admin-link": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      const read = { network: () => client.network(), feed: () => client.feed(), members: () => client.members(), activity: () => client.activity(), "admin-link": () => client.adminLink() };
      print(await read[command]());
      return;
    }

    case "thread": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      print(await client.thread(rest[1] ?? fail("Needs a hash")));
      return;
    }

    case "requests":
    case "invites":
    case "blocks":
    case "reports":
    case "log": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      const read = { requests: () => client.requests(), invites: () => client.invites(), blocks: () => client.blocks(), reports: () => client.reports(), log: () => client.log() };
      print(await read[command]());
      return;
    }

    case "approve":
    case "refuse":
    case "remove":
    case "unblock": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      const fid = Number(rest[1]);
      if (!Number.isSafeInteger(fid) || fid < 1) fail("Needs an FID");
      const act = { approve: () => client.approve(fid), refuse: () => client.refuse(fid), remove: () => client.removeMember(fid), unblock: () => client.unblock(fid) };
      await act[command]();
      console.log("done");
      return;
    }

    case "invite": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      const uses = values.uses === undefined ? undefined : values.uses === "unlimited" ? null : Number(values.uses);
      const invite = await client.createInvite({ code: values.code, uses });
      console.log(`${invite.code}@${client.host}`);
      return;
    }

    case "settings": {
      const client = clientFor(loadKeys(), hostArgument(rest[0]));
      const retention = values.retention as "30 days" | "forever" | undefined;
      print(values.name !== undefined || retention ? await client.updateSettings({ name: values.name, retention }) : await client.settings());
      return;
    }

    default:
      fail(`Unknown command: ${command}\n\n${HELP}`);
  }
}

await main();
