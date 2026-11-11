# Fatline for Chrome

A Farcaster client in x.com's right sidebar. On the home feed it replaces X's widgets and keeps X's search. It reads the people you follow, posts, and deletes, like the [Mac and iPhone apps](../apple).

Fatline has no built-in server or API key. You choose how it connects: a Neynar key, a code, or a custom server. Replies, reactions, notifications, profiles, following, and interacting with people you don't follow are left out on purpose.

## Run it locally

You need Node.js 22.18 or later and Chrome 137 or later. Everything below runs from this folder.

```bash
npm ci
```

```bash
npm run build
```

Then, in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** at the top right.
2. Choose **Load unpacked** and pick this folder's `dist` directory.
3. Open `x.com/home` in a window at least 1,010 pixels wide. Fatline appears under X's search.
4. Click **Continue**. A tab opens for your connection: a Neynar key from [dev.neynar.com](https://dev.neynar.com), a code, or a custom server.
5. Enter your Farcaster recovery phrase. It authorizes a new posting key, and the tab closes when that's done.

After changing the code, run `npm run build`, press the reload button on Fatline's card in `chrome://extensions`, and refresh x.com.

Chrome ties an unpacked extension's ID to its folder. Loading it from a different folder makes a new install with empty storage, so you'll sign in again.

If Fatline doesn't appear:

| What you see | Try |
| --- | --- |
| X's normal sidebar | Fatline is only on `/home`. Refresh after loading or reloading the extension |
| No sidebar at all | The window is too narrow. X removes the rail below about 1,000 pixels |
| "Chrome needs permission to reach that server." | Choose Allow when Chrome asks about a code's or custom server's address |
| X's widgets are back after an X update | X may have changed `sidebarColumn` or its search form. Check `src/content/content.ts` |

## How it's put together

| Piece | Runs in | Job | Sees secrets |
| --- | --- | --- | --- |
| `src/content` | x.com | Finds the rail on the home feed, places the frame, hides X's widgets | No |
| `src/rail` | Extension frame | Feed, composer, Settings, People | No |
| `src/setup` | Its own tab | Connection, recovery phrase | The phrase, once, in memory |
| `src/background` | Service worker | The only code that signs or reads the network | The posting key and connection |
| `src/core` | Anywhere | Ported from the Apple apps' Swift, and tested without a browser | |

The service worker answers only this extension's own pages. If X changes its page and Fatline can't place its frame, X's sidebar stays as it was.

## Your keys

You sign in with your Farcaster recovery phrase. It's used once in the setup tab to authorize a new posting key, and isn't saved. The posting key can post and delete casts, and expires 30 days after its last use.

The posting key is non-extractable and lives in this extension's IndexedDB, which x.com can't read. That's weaker than the Keychain the Apple apps use: JavaScript can't export it, but anything that can read your Chrome profile should be assumed able to. A Neynar key is stored the same way. Avatars and images load straight from where they're hosted, so those sites can see your IP address.

## Test it

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run e2e
```

`npm run e2e` runs the extension in a throwaway headless Chrome, on a local page that sends x.com's real security policy, against a mock network that verifies every signature. Set `FATLINE_SHOTS` to a folder to save a picture of each screen.

`static/authorize.js` is the same offline signing helper the Apple apps use. [`recovery/build.sh`](../recovery/build.sh) rebuilds both copies.
