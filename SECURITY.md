# Security

Fatline handles Farcaster recovery phrases and posting keys, so security reports are very welcome.

## Report a problem

Please [report it privately](https://github.com/danromero/fatline-monorepo/security/advisories/new) instead of opening a public issue. Say which app and version you're running, and how to reproduce the problem.

Only the latest version of each app, and of the network server, gets fixes.

## What counts

- Anything that exposes a recovery phrase or posting key.
- Anything that lets someone post or delete as you.
- Anything that gets the Mac app to install an update its developer didn't sign.
- Anything that runs code on your device through a cast, an image, or a server's answer.
- Anything that lets x.com or another site read the Chrome extension's storage or get it to sign.
- Anything that lets someone spend a server's Neynar credits without its secret path.
- Anything that lets someone read a private network they aren't in, or post, delete, or act as its admin without being one.
- Anything that lets an FID's former owner keep using a network after the FID changes hands.

The README's [Your keys](README.md#your-keys) section lists what a server and image hosts can already do. Those limits are known, but a way to go further than it describes is a real report.
