// Runs a local Fatline network with made-up Farcaster accounts and walks through what it does.
// `npm run demo` keeps it running afterward so you can try more. `npm run demo -- --exit` stops at the end.
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MessageType, signMessage } from "../src/protocol/messages.ts";
import { Protobuf } from "../src/protocol/protobuf.ts";
import type { NetworkClient } from "./client.ts";
import { keyFileFor, remember, writeKeyFile } from "./keyfile.ts";
import { approveDevice, Ed25519Key } from "./keys.ts";
import { newPerson, startNetwork } from "./local.ts";
import { describePost, describeThread, expect, failure, ok, refusal, section, show } from "./narrate.ts";
import type { Person, TestNetwork } from "./local.ts";

const KEYS = fileURLToPath(new URL("../.demo/", import.meta.url));
const CODE = "DEMO-2026";
const exitAtEnd = process.argv.includes("--exit");
/** Also prints what Fatline Dev needs to join as a made-up account. */
const forApp = process.argv.includes("--app");

const alice = newPerson(1001, "alice");
const bob = newPerson(1002, "bob");
const carol = newPerson(1003, "carol");
const dave = newPerson(1004, "dave");
const erin = newPerson(1005, null);
const frank = newPerson(1006, "frank");
// Only for Fatline Dev: someone who asks without a code and waits for the admin.
const gina = newPerson(1007, "gina");
const people = [alice, bob, carol, dave, erin, frank, gina];

let network: TestNetwork | undefined;
const devices = new Map<number, NetworkClient>();
const as = (person: Person) => devices.get(person.fid)!;
const name = (fid: number) => {
  const person = people.find((candidate) => candidate.fid === fid);
  return person?.username ? `@${person.username}` : `!${fid}`;
};

async function join(person: Person, invite?: string) {
  network!.farcaster.add(person);
  const client = await network!.device(person);
  devices.set(person.fid, client);
  return client.join({ invite });
}

async function tour() {
  section("Joining");
  expect((await join(alice)) === "approved" && (await as(alice).signIn()) === "approved", "alice gets in");
  await as(alice).updateSettings({ name: "Cabin" });
  ok(`${name(alice.fid)} runs this network, so ${name(alice.fid)} is let in at once and names it "Cabin".`);

  await as(alice).createInvite({ code: CODE, uses: null });
  ok(`${name(alice.fid)} makes the invite code ${CODE}@${network!.host}.`);

  expect((await join(bob, CODE)) === "approved" && (await as(bob).signIn()) === "approved", "bob gets in with the code");
  ok(`${name(bob.fid)} joins with the code and is in.`);

  expect((await join(erin, CODE)) === "approved" && (await as(erin).signIn()) === "approved", "erin gets in with the code");
  expect((await as(erin).network()).you.username === "!1005", "erin shows as !1005");
  ok("!1005 joins with the code too. That account has no Farcaster username, so it shows by its FID.");

  expect((await join(carol)) === "pending" && (await as(carol).signIn()) === "pending", "carol waits");
  ok(`${name(carol.fid)} asks without a code and waits for the admin.`);
  await as(alice).approve(carol.fid);
  expect((await as(carol).signIn()) === "approved", "carol is approved");
  ok(`${name(alice.fid)} approves the request, and ${name(carol.fid)} is in.`);

  expect((await join(dave)) === "pending", "dave waits");
  await as(alice).refuse(dave.fid);
  expect((await as(dave).signIn()) === "refused" && (await (await network!.device(dave)).join()) === "refused", "dave stays refused");
  ok(`${name(dave.fid)} asks too. ${name(alice.fid)} refuses, and asking again stays refused.`);

  section("Posting");
  const handles = new Map((await as(bob).members()).map((member) => [member.username, member.fid]));
  const dinner = await as(bob).post({ text: "Dinner at 7? @carol", handles });
  ok(`${name(bob.fid)} posts "Dinner at 7? @carol".`);
  const reply = await as(carol).reply({ fid: bob.fid, hash: dinner }, { text: "In! Bringing bread" });
  ok(`${name(carol.fid)} replies "In! Bringing bread".`);
  await as(alice).post({ text: "Bring wine", embeds: [{ post: { fid: bob.fid, hash: dinner } }, { url: "https://example.com/menu" }] });
  ok(`${name(alice.fid)} quotes it, with a link to a menu.`);
  await as(alice).like({ fid: bob.fid, hash: dinner });
  await as(carol).like({ fid: bob.fid, hash: dinner });
  ok(`${name(alice.fid)} and ${name(carol.fid)} like ${name(bob.fid)}'s post.`);

  const feed = (await as(carol).feed()).posts;
  expect(feed.find((post) => post.hash === dinner)?.likes === 2, "two likes");
  ok(`${name(carol.fid)}'s feed:`);
  for (const post of feed) describePost(post, name).forEach(show);

  const thread = await as(erin).thread(dinner);
  expect(thread.replies.length === 1, "one reply");
  ok(`${name(bob.fid)}'s post with its replies:`);
  describeThread(thread.post, thread.replies, name).forEach(show);

  const bobs = (await as(bob).activity()).items;
  const carols = (await as(carol).activity()).items;
  expect(bobs[0]?.kind === "reply" && carols[0]?.kind === "mention", "activity");
  ok(`${name(bob.fid)}'s Activity shows ${name(carol.fid)}'s reply. ${name(carol.fid)}'s shows the mention.`);

  section("What the server refuses, even from a client that skips its own checks");
  const key = as(bob).membership.networkKey;
  const body = (text: string) => {
    const cast = new Protobuf();
    cast.bytes(2, new Uint8Array());
    cast.string(4, text);
    cast.bytes(5, new Uint8Array());
    return cast.data;
  };
  ok(`281 characters: "${await refusal(as(bob).submit(await signMessage(MessageType.castAdd, body("a".repeat(281)), bob.fid, key)))}"`);
  ok(`A reply to a reply: "${await refusal(as(alice).reply({ fid: carol.fid, hash: reply }, { text: "Nested" }))}"`);
  ok(`A post signed as someone else: "${await refusal(as(bob).submit(await signMessage(MessageType.castAdd, body("I'm carol"), carol.fid, key)))}"`);
  ok(`A mention of someone outside the network: "${await refusal(as(bob).post({ text: "Hi @dave", handles: new Map([["dave", dave.fid]]) }))}"`);

  section("Deleting");
  const typo = await as(erin).post({ text: "Tpyo, deleting this" });
  await as(bob).reply({ fid: erin.fid, hash: typo }, { text: "Too late, saw it" });
  await as(erin).remove(typo);
  const gone = await as(bob).thread(typo);
  expect(gone.post.deleted && gone.replies.length === 1, "placeholder with its reply");
  expect(!(await as(bob).feed()).posts.some((post) => post.hash === typo), "out of the feed");
  ok("!1005 deletes a post that has a reply. It leaves the feed, and the reply stays under a placeholder:");
  describeThread(gone.post, gone.replies, name).forEach(show);

  section("Muting and reporting");
  const hello = await as(erin).post({ text: "Hi all, new here" });
  await as(alice).mute(erin.fid);
  expect(!(await as(alice).feed()).posts.some((post) => post.fid === erin.fid), "muted");
  ok(`${name(alice.fid)} mutes !1005, whose posts leave ${name(alice.fid)}'s feed. Everyone else still sees them.`);
  await as(alice).unmute(erin.fid);
  await as(bob).report(hello, "Testing reports");
  const [report] = await as(alice).reports();
  expect(report?.post === hello, "report");
  ok(`${name(bob.fid)} reports a post, and ${name(alice.fid)} sees the report with its note: "${report.note}".`);

  section("Removing someone");
  await as(alice).removeMember(carol.fid);
  const after = await as(bob).thread(dinner);
  expect(after.replies.length === 0, "carol's reply is gone");
  expect((await as(carol).signIn()) === "refused", "carol is out");
  expect((await (await network!.device(carol)).join()) === "refused", "carol is blocked");
  ok(`${name(alice.fid)} removes ${name(carol.fid)}. The reply and the like from ${name(carol.fid)} are gone, signing in is refused, and asking again is blocked.`);

  section("Leaving");
  await as(erin).leave();
  expect(!(await as(bob).feed()).posts.some((post) => post.fid === erin.fid), "erin's posts are gone");
  ok("!1005 leaves. Their posts go too, and they can ask to join again.");

  section("Deleting after 30 days");
  await as(alice).updateSettings({ retention: "30 days" });
  const now = Math.floor(Date.now() / 1000);
  await network!.runHourly(now + 29 * 24 * 60 * 60);
  for (const person of [alice, bob]) await as(person).signIn();
  const before = (await as(bob).feed()).posts.length;
  await network!.runHourly(now + 31 * 24 * 60 * 60);
  for (const person of [alice, bob]) await as(person).signIn();
  const left = (await as(bob).feed()).posts.length;
  expect(before > 0 && left === 0, "retention");
  ok(`${name(alice.fid)} sets posts to go after 30 days. The hourly job, run as if 29 days later, keeps the ${before} posts. Run as if 31 days later, it deletes them.`);
  await as(alice).updateSettings({ retention: "forever" });
  await as(alice).post({ text: "Welcome to the cabin. Post something!" });
  ok(`${name(alice.fid)} sets it back to forever and posts a welcome.`);
}

/** Key files for the scripted client, so you can carry on as any of them. */
async function writeKeys() {
  rmSync(KEYS, { recursive: true, force: true });
  mkdirSync(KEYS, { recursive: true });
  for (const person of [alice, bob, carol, dave, erin]) {
    const client = as(person);
    writeKeyFile(`${KEYS}${person.username ?? "erin"}.json`, remember(keyFileFor(client.identity), client));
  }
  network!.farcaster.add(frank);
  network!.farcaster.add(gina);
  const identity = await approveDevice(frank.phrase, frank.fid, Ed25519Key.random());
  writeKeyFile(`${KEYS}frank.json`, keyFileFor(identity));
}

async function stop() {
  rmSync(KEYS, { recursive: true, force: true });
  await network?.stop();
}

async function main() {
  console.log("Fatline network demo");
  console.log("Starting a local network with made-up Farcaster accounts. Nothing touches Farcaster or Optimism.");
  network = await startNetwork(alice, { port: 8787 });
  console.log(`It's at http://${network.host}.`);

  try {
    await tour();
  } catch (error) {
    console.error(`\n  ✗ ${failure(error)}`);
    await stop();
    process.exit(1);
  }

  if (exitAtEnd) {
    console.log("\nEverything worked.");
    await stop();
    return;
  }

  await writeKeys();
  const host = network.host;
  const run = (args: string, who: string) => `npm run client -- ${args} --keys .demo/${who}.json`;
  console.log(`
Everything worked. The network is still running, so you can carry on as any of them.
In another terminal, in the network folder:

  ${run(`feed ${host}`, "bob")}
  ${run(`post ${host} "Hello from bob"`, "bob")}
  ${run(`join ${CODE}@${host}`, "frank")}       (frank hasn't joined yet)
  ${run(`session ${host}`, "frank")}
  ${run(`members ${host}`, "alice")}
  ${run(`session ${host}`, "carol")}            (carol was removed)

  npm run client -- help                        (everything else)

Press Ctrl-C to stop. The network and the .demo key files are deleted when it stops.`);
  if (forApp) {
    console.log(`
To join from Fatline Dev, open it with the stand-in for Optimism:

  open -n "../apple/DerivedData.noindex/Dev/Build/Products/Debug/Fatline Dev.app" --env FATLINE_OPTIMISM_URL=http://127.0.0.1:${network.farcaster.port}/rpc

Then choose Add Network… from the File menu, enter ${CODE}@${host}, and use frank's made-up phrase:

  ${frank.phrase}

To see the waiting screen instead, enter just ${host} and use gina's. Approve her in the admin pages,
which ${run(`admin-link ${host}`, "alice")} opens, then choose Check Again in the app:

  ${gina.phrase}

Debug > Forget Networks on This Mac starts over.`);
  }

  // Wrangler may exit on Ctrl-C before this handler runs, so the key files also go on exit.
  process.once("exit", () => {
    rmSync(KEYS, { recursive: true, force: true });
    console.log("\nStopped. The network and the .demo key files are gone.");
  });
  process.once("SIGINT", () => stop().then(() => process.exit(0)));
}

await main();
