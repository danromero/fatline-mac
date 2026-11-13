// Three local networks for trying the iPhone app in the Simulator, and a control port to change them
// while it's open. `npm run demo:phone` keeps them running until Ctrl-C.
//
// - Cabin (localhost:8787) and Pine Street (localhost:8788), with posts, replies, and likes, and an
//   invite code each.
// - Orchard (localhost:8789), where frank asks without a code and waits for the admin.
// - frank's key file in .demo/phone/, for Fatline Dev's -FatlineDeviceKeyFile, and gina's, a second
//   person in no network yet, for Fatline Dev for Mac beside the Simulator.
// - heidi, with no key file: her made-up phrase is printed, for trying the recovery phrase step.
//
// Control, with curl, while it runs:
//   http://127.0.0.1:8799/post?net=pine&text=Hello   a new post, for the dot on the network not showing
//   http://127.0.0.1:8799/reply?text=Hello           a reply under Cabin's dinner post
//   http://127.0.0.1:8799/delete                     deletes Cabin's dinner post, for the placeholder
//   http://127.0.0.1:8799/approve                    lets frank into Orchard
//   http://127.0.0.1:8799/refuse                     refuses frank's request to Orchard
//   http://127.0.0.1:8799/remove                     removes frank from Orchard, once he's in
//   http://127.0.0.1:8799/remove?net=cabin&fid=1007  removes someone from Cabin or Pine Street, as its admin
//
// And to see what the app did, as another member would (carol in Cabin, quinn in Pine Street):
//   http://127.0.0.1:8799/feed?net=pine              the feed, newest first, one line per post
//   http://127.0.0.1:8799/thread?net=pine&hash=0x…   a post and its replies
//   http://127.0.0.1:8799/reports?net=pine           the admin's open reports
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { keyFileFor, writeKeyFile } from "./keyfile.ts";
import { approveDevice, Ed25519Key } from "./keys.ts";
import { newPerson, startNetwork } from "./local.ts";
import type { Person, TestNetwork } from "./local.ts";
import type { Post } from "../src/protocol/api.ts";

const KEYS = fileURLToPath(new URL("../.demo/phone/", import.meta.url));
// Fatline Dev's bundle ID, as Xcode builds it: FATLINE_BUNDLE_ID from apple/Signing.local.xcconfig, plus .dev.
const DEV_BUNDLE = (() => {
  try {
    const local = readFileSync(fileURLToPath(new URL("../../apple/Signing.local.xcconfig", import.meta.url)), "utf8");
    const id = /^FATLINE_BUNDLE_ID\s*=\s*(\S+)/m.exec(local)?.[1];
    if (id) return `${id}.dev`;
  } catch {}
  return "com.example.fatline.dev";
})();
const CONTROL = 8799;

const alice = newPerson(1001, "alice");
const bob = newPerson(1002, "bob");
const carol = newPerson(1003, "carol");
const frank = newPerson(1006, "frank");
const gina = newPerson(1007, "gina");
const heidi = newPerson(1008, "heidi");
const pat = newPerson(2001, "pat");
const quinn = newPerson(2002, "quinn");
const rosa = newPerson(3001, "rosa");

const cabin = await startNetwork(alice, { port: 8787 });
const pine = await startNetwork(pat, { port: 8788 });
const orchard = await startNetwork(rosa, { port: 8789 });
for (const network of [cabin, pine, orchard]) {
  network.farcaster.add(frank);
  network.farcaster.add(gina);
  network.farcaster.add(heidi);
}

async function member(network: TestNetwork, person: Person, invite?: string) {
  network.farcaster.add(person);
  const client = await network.device(person);
  await client.join({ invite });
  await client.signIn();
  return client;
}

const a = await member(cabin, alice);
await a.updateSettings({ name: "Cabin" });
await a.createInvite({ code: "CABIN-2026", uses: null });
const b = await member(cabin, bob, "CABIN-2026");
const c = await member(cabin, carol, "CABIN-2026");
const dinner = await b.post({ text: "Dinner at 7? @carol", handles: new Map([["carol", carol.fid]]) });
await c.reply({ fid: bob.fid, hash: dinner }, { text: "In! Bringing bread" });
await a.reply({ fid: bob.fid, hash: dinner }, { text: "I’ll bring the wine." });
await a.like({ fid: bob.fid, hash: dinner });
await c.like({ fid: bob.fid, hash: dinner });
await a.post({ text: "Menu for tonight is on example.com/menu if you want to look ahead." });
await c.post({ text: "First frost on the porch this morning. The kettle is on if anyone is up early tomorrow and wants to walk the ridge before breakfast." });

const p = await member(pine, pat);
await p.updateSettings({ name: "Pine Street" });
await p.createInvite({ code: "PINE-2026", uses: null });
const q = await member(pine, quinn, "PINE-2026");
await p.post({ text: "Folding tables are in my garage if anyone needs them Saturday." });
await q.post({ text: "Is the Saturday swap still at the library, or did it move?" });

const r = await member(orchard, rosa);
await r.updateSettings({ name: "Orchard" });

rmSync(KEYS, { recursive: true, force: true });
mkdirSync(KEYS, { recursive: true });
writeKeyFile(`${KEYS}frank.json`, keyFileFor(await approveDevice(frank.phrase, frank.fid, Ed25519Key.random())));
writeKeyFile(`${KEYS}gina.json`, keyFileFor(await approveDevice(gina.phrase, gina.fid, Ed25519Key.random())));

const posters = { cabin: b, pine: q };
const readers = { cabin: c, pine: q };
const admins = { cabin: a, pine: p };
const line = (post: Post) =>
  `${post.hash} @${post.fid}${post.parent ? ` reply to ${post.parent}` : ""}${post.deleted ? " (deleted)" : ""}: ${JSON.stringify(post.text)}` +
  post.embeds.map((embed) => ` [${embed.type}${"url" in embed && embed.url ? ` ${embed.url}` : ""}]`).join("") +
  ` replies ${post.replies} likes ${post.likes}\n`;
createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const net = url.searchParams.get("net") === "pine" ? "pine" : "cabin";
  const text = url.searchParams.get("text") ?? "Hello";
  try {
    switch (url.pathname) {
      case "/post": response.end(`posted ${await posters[net].post({ text })}\n`); break;
      case "/reply": response.end(`replied ${await c.reply({ fid: bob.fid, hash: dinner }, { text })}\n`); break;
      case "/delete": await b.remove(dinner); response.end("deleted the dinner post\n"); break;
      case "/approve": await r.approve(frank.fid); response.end("frank is in Orchard\n"); break;
      case "/refuse": await r.refuse(frank.fid); response.end("refused frank\n"); break;
      case "/remove": {
        const fid = Number(url.searchParams.get("fid"));
        if (url.searchParams.has("net") && fid) {
          await admins[net].removeMember(fid);
          response.end(`removed ${fid} from ${net}\n`);
        } else {
          await r.removeMember(frank.fid);
          response.end("removed frank from Orchard\n");
        }
        break;
      }
      case "/feed": response.end((await readers[net].feed()).posts.map(line).join("")); break;
      case "/thread": {
        const thread = await readers[net].thread(url.searchParams.get("hash") ?? "");
        response.end([thread.post, ...thread.replies].map(line).join(""));
        break;
      }
      case "/reports": response.end(JSON.stringify(await admins[net].reports(), null, 2) + "\n"); break;
      default: response.statusCode = 404; response.end("unknown\n");
    }
  } catch (error) {
    response.statusCode = 500;
    response.end(`${error}\n`);
  }
}).listen(CONTROL, "127.0.0.1");

console.log(`Three networks are running: Cabin at ${cabin.host}, Pine Street at ${pine.host}, and Orchard at ${orchard.host}.

Open Fatline Dev in the booted Simulator as frank, joined to all three (from apple/, after building it):

  xcrun simctl launch --terminate-running-process booted ${DEV_BUNDLE} \\
    -FatlineProfile phone -FatlineForgetNetworks YES \\
    -FatlineDeviceKeyFile ${KEYS}frank.json \\
    -FatlineJoin "CABIN-2026@${cabin.host},PINE-2026@${pine.host},${orchard.host}"

And Fatline Dev for Mac as gina, in no network yet, to join one with Add Network beside the Simulator:

  open -n "<Fatline Dev.app>" --args -FatlineProfile gina -FatlineForgetNetworks YES \\
    -FatlineDeviceKeyFile ${KEYS}gina.json

And to try the recovery phrase step, as heidi, whose made-up phrase is
  ${heidi.phrase}

  SIMCTL_CHILD_FATLINE_OPTIMISM_URL=http://127.0.0.1:${cabin.farcaster.port}/rpc \\
    xcrun simctl launch --terminate-running-process booted ${DEV_BUNDLE} \\
    -FatlineProfile heidi -FatlineForgetNetworks YES

Then change things with curl on http://127.0.0.1:${CONTROL}: /post?net=pine&text=Hi, /reply?text=Hi, /delete,
/approve, /refuse, /remove. See them as another member would with /feed?net=pine, /thread?net=pine&hash=…,
and /reports?net=pine. Ctrl-C stops the networks and deletes the key files.`);

// Wrangler may exit on Ctrl-C before the SIGINT handler runs, so the key file also goes on exit.
process.once("exit", () => rmSync(KEYS, { recursive: true, force: true }));
process.once("SIGINT", async () => {
  await Promise.all([cabin.stop(), pine.stop(), orchard.stop()]);
  process.exit(0);
});
