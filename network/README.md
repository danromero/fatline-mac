# Fatline network

A small private social network on your own server, for people you know on Farcaster. [docs/NETWORK.md](../docs/NETWORK.md) describes what a network server answers and how the apps sign what they send.

This folder has:

- `src/server`: the server, a Cloudflare Worker on D1, with images in R2 and their smaller sizes from Cloudflare's Images binding. It creates its own tables on its first request.
- `src/protocol`: the signed messages, approvals, and limits from the spec, which the server and clients share.
- `client`: a scripted client that joins a network and posts the way the apps will.

The admin pages are at `/admin`, reached through a one-time link the app or `npm run client -- admin-link` asks for.

## Try it

```bash
npm ci
npm run demo
```

This starts a local network with made-up Farcaster accounts and walks through everything it does: joining with a code and by request, posting, replying, quoting, liking, what the server refuses, deleting, muting, reporting, removing someone, leaving, and deleting after 30 days. Each step is checked, and the walkthrough stops at the first one that fails. Nothing touches Farcaster or Optimism.

Afterward the network keeps running, with a key file for each account in `.demo`, so you can carry on as any of them with the scripted client. It prints a few commands to try. Ctrl-C stops it and deletes the key files. `npm run demo -- --exit` stops at the end of the walkthrough instead.

## Try it with real accounts

```bash
npm run real
```

This asks for a Farcaster account's recovery phrase, and then a second account's if you have one. Copy it, or paste it at the prompt, where it doesn't show. It starts a local network run by the first account and walks through it the same way:

- joining as the admin
- posting, replying, liking, quoting, and deleting
- with a second account: asking to join, being approved, mentioning and replying, being removed and blocked, and coming back with an invite code

Each phrase signs one approval on this Mac and is never saved. A phrase on the clipboard is cleared after it's read, and anything else there is left alone. The network runs only on this computer. It checks accounts with Optimism and Farcaster's fname server, as a deployed network would, and posts nothing to Farcaster.

`npm run real -- --keychain` uses the phrase of a throwaway account saved in your login Keychain: set `FATLINE_E2E_HANDLE` to its username, and save the phrase once with `security add-generic-password -s fatline-e2e -a <username> -w`. `FATLINE_PHRASE` and `FATLINE_SECOND_PHRASE` take phrases from the environment instead, and `--exit` stops at the end. Otherwise the network keeps running with key files in `.real`, which hold this Mac's keys but not the phrases, until Ctrl-C deletes them.

## Run it locally

```bash
npm ci
npx wrangler dev --var ADMIN_FID:<your FID>
```

It listens on `http://localhost:8787` with a local database. To reach it from a phone, put it behind a tunnel with an HTTPS address and set `NETWORK_HOST` to that address's host.

| Setting | What it's for |
| --- | --- |
| `ADMIN_FID` | The FID of the person who runs the network. They're let in at once, as its admin |
| `NETWORK_HOST` | The host signatures name. Set it when the network has more than one address, such as a custom domain |
| `INVITE_PATH` | A long random path for an invite page at `/<INVITE_PATH>/invite`. Set it as a secret. Its Download button serves `downloads/Fatline.dmg` from the media bucket. Without it, there's no invite page |
| `OPTIMISM_RPC_URL` | One or more Optimism RPCs, separated by commas and tried in order. With two or more, an owner counts only when two agree. One is trusted alone. Defaults to five public ones |
| `FNAME_URL` | Defaults to Farcaster's fname server |
| `HUB_URL` | A Snapchain HTTP API, such as `https://hub.example/v1`. With it, people the admin follows on Farcaster get in without waiting, unless the admin turns that off in Settings. The admin pulls the follow list on Settings, and joins check that list, never the hub. Without it, everyone waits |
| `HUB_API_KEY` | Sent to `HUB_URL` as `x-api-key`, for hubs that need one. Set it as a secret |

## Run the tests

Use Node 22.18 or later.

```bash
npm ci
npm run typecheck
npm test
```

The server tests run the Worker under `wrangler dev` with an in-memory database, and stand in for Optimism and the fname server, so they need no real accounts. `CHECK_OPTIMISM=1 npm test` also reads Farcaster's real ID registry on Optimism and its fname server.

## The scripted client

```bash
npm run client -- help
```

`sample` prints a join request and one signed message of each type without sending anything. The other commands talk to a server.

The client keeps its keys in a plain file, so use it only for testing. It reads the recovery phrase from `FATLINE_PHRASE`, which keeps the phrase out of shell history.
