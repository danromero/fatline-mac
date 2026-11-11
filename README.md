# Fatline

A small Farcaster client for Mac, iPhone, and Chrome, and a reference for building one. It reads the people you follow, posts, and deletes. Each app builds its feed and signs every message on your own device.

Fatline has no built-in server or API key. You choose how it connects.

## What's here

| Folder | What it is | Get it |
| --- | --- | --- |
| [`apple`](apple) | The Mac and iPhone apps, in one Xcode project that shares most of its code | [Download for Mac](https://github.com/danromero/fatline-monorepo/releases/latest/download/Fatline.dmg) or [join the iPhone beta on TestFlight](https://testflight.apple.com/join/SnTSSbrE) |
| [`chrome`](chrome) | A Chrome extension that puts Fatline in x.com's sidebar | [Build it and load it](chrome/README.md#run-it-locally) |
| [`server`](server) | A Cloudflare Worker that forwards Fatline's reads and posts to your own Neynar account | [Deploy it](server/README.md) |
| [`docs`](docs/SERVER.md) | What a server has to answer to hand out codes | |
| [`recovery`](recovery) | The offline signing helper that turns a recovery phrase into a new posting key, shared by the apps and the extension | |

## Left out on purpose

Fatline is an opinionated client. These aren't in it, and there are no plans to add them:

- Replies
- Reactions
- Notifications
- Profiles
- Follow and unfollow
- Interacting with people you don't already follow

If you want any of that, use another client or fork this one.

## Connecting

Setup asks for a Neynar key, with buttons to use a code or a custom server instead. Settings has the same three on one screen.

| Option | What you need | Who pays for reads |
| --- | --- | --- |
| Neynar key | A key from [dev.neynar.com](https://dev.neynar.com) | Your Neynar account |
| Code | A code written as `code@server.example` | Whoever issued it |
| Advanced | An HTTPS server that answers Neynar's feed routes and Snapchain's | Whoever runs it |

Anyone can run either kind of server. To set up a custom server, give a coding agent [this guide](https://fatline.tech/custom-server.md), or deploy [`server`](server) yourself. [docs/SERVER.md](docs/SERVER.md) describes what an invite server has to answer.

## Your keys

You sign in with your Farcaster recovery phrase. It's used once to authorize a new posting key and isn't saved. On Mac and iPhone the posting key stays in that device's Keychain, along with your connection. In Chrome it's a key JavaScript can't export, kept in the extension's own storage, which [the extension's README](chrome/README.md#your-keys) explains. Signing out deletes the key and asks the network to remove it, and a key the network keeps anyway stops working 30 days after its last use.

The server you connect to sees what you read and post, but never your phrase or posting key. Profile pictures and images in casts load straight from wherever they're hosted, so those sites can see your IP address.

Fatline doesn't verify the signatures on what a server sends, so use one you trust. A dishonest server could show false posts or names, or show you a post with another post's ID so that deleting it removes the wrong one of your own casts. It can't post as you or change what you write.

To report a security problem, see [SECURITY.md](SECURITY.md).

## License

MIT. Inter, BLAKE3, and the libraries in the recovery helper keep their own licenses, which are included next to them.
