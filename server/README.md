# Fatline Server

Your own proxy to Neynar for [Fatline](https://fatline.tech), a Farcaster client.

Fatline builds the feed and signs every message on the device. This Cloudflare Worker forwards only the routes Fatline uses to your Neynar account. You control the Worker and its URL. Reads and posts still go through Neynar and use your credits.

It never needs your Farcaster recovery phrase.

## You need

- A Cloudflare account
- A Neynar API key from https://dev.neynar.com

## Deploy with one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/danromero/fatline-monorepo/tree/main/server)

Cloudflare copies this folder to a new repository on your GitHub or GitLab account, then asks for two secrets:

- `NEYNAR_API_KEY` is your Neynar key.
- `PATH_SECRET` is a random path segment of at least 32 letters and numbers. Use a password generator, or run `openssl rand -hex 24`. Save it, because Cloudflare won't show it again.

The Worker answers 503 until both are set and `PATH_SECRET` is strong enough.

Your server's URL is the Worker's `workers.dev` address plus the path segment:

```
https://fatline-server.<your-subdomain>.workers.dev/<PATH_SECRET>
```

## Deploy from a terminal

You also need Node.js 22 or later, `curl`, `jq`, and `openssl`.

```bash
git clone https://github.com/danromero/fatline-monorepo.git
cd fatline-monorepo/server
npm ci
npx wrangler login
```

If your login has more than one Cloudflare account, run `export CLOUDFLARE_ACCOUNT_ID=<account id>`.

Check that the name is free. An error saying the Worker doesn't exist means it is. If the name is taken, change `name` in `wrangler.jsonc`.

```bash
npx wrangler deployments list --name fatline-server
```

Deploy, then set the path segment and save the value it prints:

```bash
npx wrangler deploy
PATH_SECRET=$(openssl rand -hex 24)
printf %s "$PATH_SECRET" | npx wrangler secret put PATH_SECRET
echo "$PATH_SECRET"
```

Enter your Neynar key at this prompt:

```bash
npx wrangler secret put NEYNAR_API_KEY
```

## Check it

```bash
./check.sh "https://fatline-server.<your-subdomain>.workers.dev/<PATH_SECRET>"
```

Every line should say `ok`. A new address or secret can take a few seconds to apply, so run it again before debugging a 404. The script uses about 500 Neynar credits and posts nothing.

## Connect Fatline

In Fatline, choose Advanced, paste the URL, and continue. Then sign in, post a test cast, and delete it. That's the only full test of writing.

## Keep the URL private

The full URL works like a password, because Fatline can't send a key or header to a custom server. Keep it out of logs, screenshots, issues, and shared chats. The output of `wrangler tail` contains it.

The Worker has no rate limit or spending cap, so anyone with the URL can spend your credits until the path changes. If it may have been exposed, make a new one:

```bash
PATH_SECRET=$(openssl rand -hex 24)
printf %s "$PATH_SECRET" | npx wrangler secret put PATH_SECRET
echo "$PATH_SECRET"
```

The old URL stops working and your Neynar key stays the same. In Fatline, open Settings, then Connection, choose Advanced, and paste the new URL.

## Turn it off or remove it

Switch Fatline to another connection first.

- To turn it off and keep the Worker, run `npx wrangler secret delete PATH_SECRET`. It answers 503 until you set a new path.
- To remove it, run `npx wrangler delete`.

Neither changes your Neynar key.

## Build your own server

Any HTTPS server can back Fatline if it meets [the server contract](https://fatline.tech/custom-server.md#server-contract). Point `check.sh` at it to see what's missing. A server that hands out codes also answers the routes in [docs/SERVER.md](../docs/SERVER.md).

## Develop

```bash
npm ci
npm test
```

CI runs the tests on every push. Set a `SERVER_URL` repository secret to also check a live server every day.

MIT licensed.
