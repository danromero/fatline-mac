// Tries a local Fatline network with real Farcaster accounts.
//
//   npm run real                       Asks you to copy a recovery phrase, and then a second one if you have it.
//   npm run real -- --keychain         Uses the phrase of the account in FATLINE_E2E_HANDLE, saved in your login Keychain.
//   FATLINE_PHRASE=... npm run real    Takes the phrase from the environment. FATLINE_SECOND_PHRASE adds a second.
//   npm run real -- --exit             Stops at the end of the walkthrough instead of staying up.
//
// The phrase signs one approval on this Mac and is never saved. The network runs only on this computer.
// It reads Optimism and Farcaster's fname server to check accounts, and posts nothing to Farcaster.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { english } from "viem/accounts";
import { fidOf } from "../src/protocol/chain.ts";
import { usernameOf } from "../src/protocol/fnames.ts";
import type { NetworkClient } from "./client.ts";
import { keyFileFor, remember, writeKeyFile } from "./keyfile.ts";
import { custodyAddress } from "./keys.ts";
import { startRealNetwork } from "./local.ts";
import type { LocalNetwork } from "./local.ts";
import { describePost, describeThread, expect, failure, ok, refusal, section, show } from "./narrate.ts";

/** A real Farcaster account, as its recovery phrase and what Farcaster says about it. */
export interface Account {
  phrase: string;
  fid: number;
  username: string | null;
}

const KEYS = fileURLToPath(new URL("../.real/", import.meta.url));
const shown = (account: Account) => (account.username ? `@${account.username}` : `!${account.fid}`);

/** Walks through the network as `me`, the admin, and `second` if given. Returns each one's client. */
export async function realWalkthrough(network: LocalNetwork, me: Account, second: Account | null): Promise<Map<string, NetworkClient>> {
  const name = (fid: number) => (fid === me.fid ? shown(me) : second && fid === second.fid ? shown(second) : `!${fid}`);
  const clients = new Map<string, NetworkClient>();

  section(`Joining as ${shown(me)}, who runs this network`);
  const mine = await network.device(me);
  clients.set("me", mine);
  ok("Approved a key for this Mac with your phrase. The phrase itself isn't kept.");
  expect((await mine.join()) === "approved", "you're let in as the admin");
  ok(`Joined. The server checked with Optimism that your phrase owns FID ${me.fid}, then let you in as its admin.`);
  expect((await mine.signIn()) === "approved", "you can sign in");
  const you = (await mine.network()).you;
  expect(you.username === (me.username ?? `!${me.fid}`) && you.role === "admin", `the network shows you as ${shown(me)}, its admin`);
  ok(`Signed in. Farcaster's fname server says you're ${shown(me)}, and that's how the network shows you.`);
  await mine.updateSettings({ name: "Test network" });
  ok('Named the network "Test network".');

  section("Posting");
  const hello = await mine.post({ text: "Hello from a private Fatline network" });
  const self = { fid: me.fid, hash: hello };
  await mine.reply(self, { text: "Replying to myself" });
  await mine.like(self);
  const quote = await mine.post({ text: "Quoting myself", embeds: [{ post: self }, { url: "https://fatline.tech" }] });
  ok("Posted, replied to the post, liked it, and quoted it with a link.");
  const feed = (await mine.feed()).posts;
  expect(feed.find((post) => post.hash === hello)?.likes === 1, "the like counts");
  ok("Your feed:");
  for (const post of feed) describePost(post, name).forEach(show);
  const reply = (await mine.thread(hello)).replies[0]!;
  ok(`A reply to a reply is refused: "${await refusal(mine.reply({ fid: me.fid, hash: reply.hash }, { text: "Nested" }))}"`);
  await mine.remove(quote);
  expect(!(await mine.feed()).posts.some((post) => post.hash === quote), "the deleted post leaves the feed");
  ok("Deleted the quote, and it left the feed.");

  if (!second) {
    section("A second account");
    ok("Skipped. Run it with a second account's phrase to try joining by request and by code.");
    return clients;
  }

  section(`A second account, ${shown(second)}`);
  const theirs = await network.device(second);
  clients.set("second", theirs);
  expect((await theirs.join()) === "pending", "the second account waits");
  ok(`${shown(second)} asks to join without a code. The server checked with Optimism that their phrase owns FID ${second.fid}, and the request waits.`);
  expect((await mine.requests()).some((request) => request.fid === second.fid), "you see the request");
  await mine.approve(second.fid);
  expect((await theirs.signIn()) === "approved", "the second account is approved");
  ok(`You approve the request, and ${shown(second)} is in.`);

  const handles = new Map((await theirs.members()).map((member) => [member.username, member.fid]));
  const mention = me.username ? `@${me.username}` : "you";
  const greeting = await theirs.post({ text: `Hi ${mention}, I'm in`, handles });
  await theirs.reply(self, { text: "Nice to be here" });
  const activity = (await mine.activity()).items.map((item) => item.kind);
  expect(activity.includes("reply") && (!me.username || activity.includes("mention")), "your Activity shows the reply and the mention");
  ok(`${shown(second)} posts${me.username ? ` mentioning ${mention}` : ""} and replies to your post. Your Activity shows ${me.username ? "both" : "the reply"}.`);
  await mine.like({ fid: second.fid, hash: greeting });
  expect((await theirs.feed()).posts.find((post) => post.hash === greeting)?.likes === 1, "your like counts");
  ok(`You like their post, and ${shown(second)} sees the like.`);
  const thread = await mine.thread(hello);
  ok("Your post with its replies:");
  describeThread(thread.post, thread.replies, name).forEach(show);

  await mine.removeMember(second.fid);
  expect(!(await mine.feed()).posts.some((post) => post.fid === second.fid), "their posts are gone");
  expect((await mine.thread(hello)).replies.every((post) => post.fid !== second.fid), "their reply is gone");
  expect((await theirs.signIn()) === "refused" && (await (await network.device(second)).join()) === "refused", "they're blocked");
  ok(`You remove ${shown(second)}. Their post and reply are gone, and asking again is blocked.`);

  await mine.unblock(second.fid);
  const code = await mine.createInvite();
  const again = await network.device(second);
  clients.set("second", again);
  expect((await again.join({ invite: code.code })) === "approved" && (await again.signIn()) === "approved", "the code lets them back in");
  ok(`You unblock them and make the one-use code ${code.code}. ${shown(second)} joins with it, straight in.`);
  return clients;
}

function normalized(phrase: string) {
  return phrase.trim().toLowerCase().split(/\s+/u).join(" ");
}

/** Throws without repeating the phrase. */
function checkPhrase(phrase: string) {
  const words = phrase.split(" ");
  if (![12, 24].includes(words.length)) throw new Error(`That had ${words.length} words. A recovery phrase is 12 or 24.`);
  if (!words.every((word) => english.includes(word))) throw new Error("That isn't a recovery phrase. Some words aren't on the list phrases use.");
}

/** What you type until Return, without showing it. Ctrl-C quits. */
function hiddenLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let typed = "";
    const done = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          done();
          process.exit(130);
        }
        if (character === "\r" || character === "\n") {
          done();
          resolve(typed);
          return;
        }
        if (character === "\u007f" || character === "\b") typed = typed.slice(0, -1);
        else typed += character;
      }
    };
    input.on("data", onData);
  });
}

function isPhrase(phrase: string) {
  try {
    checkPhrase(phrase);
    return true;
  } catch {
    return false;
  }
}

class NoPhraseCopied extends Error {}

/**
 * A phrase pasted at the prompt, which doesn't show, or else one you copied. A phrase is then cleared
 * from the clipboard, and anything else there is left alone. Null if nothing was pasted or copied.
 */
async function askForPhrase(prompt: string): Promise<string | null> {
  const pasted = normalized(await hiddenLine(prompt));
  const copied = normalized(execFileSync("pbpaste", { encoding: "utf8" }));
  if (isPhrase(copied) && (!pasted || pasted === copied)) execFileSync("pbcopy", { input: "" });
  if (pasted) return pasted;
  if (!copied) return null;
  if (!isPhrase(copied)) throw new NoPhraseCopied("Nothing was pasted, and the clipboard doesn't hold a recovery phrase.");
  return copied;
}

function fromKeychain(): string {
  try {
    const handle = process.env.FATLINE_E2E_HANDLE;
    if (!handle) throw new Error("no handle");
    return normalized(execFileSync("security", ["find-generic-password", "-s", "fatline-e2e", "-a", handle, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    throw new Error("Set FATLINE_E2E_HANDLE to a throwaway account's username, and save its phrase with: security add-generic-password -s fatline-e2e -a <username> -w");
  }
}

async function account(phrase: string): Promise<Account> {
  checkPhrase(phrase);
  const custody = custodyAddress(phrase);
  const fid = await fidOf(custody);
  if (!fid) throw new Error(`No FID belongs to ${custody}, the address that phrase holds. Check the phrase.`);
  return { phrase, fid, username: await usernameOf(fid) };
}

async function main() {
  const exitAtEnd = process.argv.includes("--exit");
  const interactive = process.stdin.isTTY && !exitAtEnd;
  console.log("Fatline network, with real accounts");
  console.log("Your phrase signs one approval on this Mac and is never saved. The network runs only on this computer.");
  console.log("It reads Optimism and Farcaster's fname server to check accounts, and posts nothing to Farcaster.\n");

  let first: string | null;
  if (process.env.FATLINE_PHRASE) first = normalized(process.env.FATLINE_PHRASE);
  else if (process.argv.includes("--keychain")) first = fromKeychain();
  else if (process.stdin.isTTY) first = await askForPhrase("Copy the recovery phrase of the account to run the network, or paste it here (it won't show), then press Return. ");
  else throw new Error("Set FATLINE_PHRASE, or run this in a terminal to copy a phrase.");
  if (!first) throw new Error("No phrase was pasted, and the clipboard was empty.");
  const me = await account(first);
  console.log(`That phrase owns FID ${me.fid}${me.username ? `, @${me.username}` : ", which has no fname"}.`);

  let second: Account | null = null;
  let secondPhrase = process.env.FATLINE_SECOND_PHRASE ? normalized(process.env.FATLINE_SECOND_PHRASE) : null;
  if (!secondPhrase && interactive) {
    const prompt = "\nTo try joining and approval, copy or paste a second account's phrase and press Return. To skip, just press Return. ";
    secondPhrase = await askForPhrase(prompt).catch((error: unknown) => {
      if (error instanceof NoPhraseCopied) return null;
      throw error;
    });
  }
  if (secondPhrase && secondPhrase !== first) {
    second = await account(secondPhrase);
    if (second.fid === me.fid) throw new Error("Both phrases own the same FID. Use a different account for the second.");
    console.log(`The second phrase owns FID ${second.fid}${second.username ? `, @${second.username}` : ", which has no fname"}.`);
  }

  const network = await startRealNetwork(me.fid, { port: 8787 });
  console.log(`\nStarted a local network at http://${network.host}, run by FID ${me.fid}.`);
  let clients: Map<string, NetworkClient>;
  try {
    clients = await realWalkthrough(network, me, second);
  } catch (error) {
    console.error(`\n  ✗ ${failure(error)}`);
    await network.stop();
    process.exit(1);
  }

  if (exitAtEnd) {
    console.log("\nEverything worked.");
    await network.stop();
    return;
  }

  rmSync(KEYS, { recursive: true, force: true });
  mkdirSync(KEYS, { recursive: true });
  for (const [who, client] of clients) writeKeyFile(`${KEYS}${who}.json`, remember(keyFileFor(client.identity), client));
  const run = (args: string, who: string) => `npm run client -- ${args} --keys .real/${who}.json`;
  console.log(`
Everything worked. The network is still running. In another terminal, in the network folder:

  ${run(`feed ${network.host}`, "me")}
  ${run(`post ${network.host} "Hello again"`, "me")}
  ${run(`members ${network.host}`, "me")}${second ? `\n  ${run(`post ${network.host} "Hello from the second account"`, "second")}` : ""}

  npm run client -- help                     (everything else)

To use it in Fatline Dev, run ../apple/scripts/dev.sh, choose Add Network… from the File menu, and enter
${network.host}. The app asks for your phrase once. You run this network, so Manage Network… in the title
menu opens its admin pages.

The .real key files hold this Mac's keys for these accounts, not the phrases. Press Ctrl-C to stop.
The network and the key files are deleted when it stops.`);

  // Wrangler may exit on Ctrl-C before this handler runs, so the key files also go on exit.
  process.once("exit", () => {
    rmSync(KEYS, { recursive: true, force: true });
    console.log("\nStopped. The network and the .real key files are gone.");
  });
  process.once("SIGINT", () => network.stop().then(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
