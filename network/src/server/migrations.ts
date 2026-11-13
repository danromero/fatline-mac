/**
 * The database's tables. The Worker applies any it hasn't yet on its first request, so a fresh deploy
 * needs no migration step. Add new migrations at the end. Never change one that has shipped.
 */
/** Moves the version from even to odd, for the version triggers below. */
const CHANGED = `INSERT INTO settings (key, value) VALUES ('version', '1')
  ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 WHERE CAST(value AS INTEGER) % 2 = 0`;

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    // identity is "farcaster" for now. Email accounts can come later without changing what a row means.
    `CREATE TABLE members (
      fid INTEGER PRIMARY KEY, identity TEXT NOT NULL DEFAULT 'farcaster', username TEXT,
      display_name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', avatar_media TEXT, farcaster_avatar TEXT,
      role TEXT NOT NULL DEFAULT 'member', custody TEXT NOT NULL, joined INTEGER NOT NULL, checked INTEGER NOT NULL)`,
    `CREATE TABLE device_keys (
      key TEXT PRIMARY KEY, fid INTEGER NOT NULL, custody TEXT NOT NULL, issued_at INTEGER NOT NULL,
      signature TEXT NOT NULL, added INTEGER NOT NULL, revoked INTEGER)`,
    `CREATE TABLE network_keys (
      key TEXT PRIMARY KEY, fid INTEGER NOT NULL, device_key TEXT NOT NULL, issued INTEGER NOT NULL,
      signature TEXT NOT NULL, added INTEGER NOT NULL, revoked INTEGER)`,
    `CREATE INDEX network_keys_by_fid ON network_keys (fid)`,
    // token is the SHA-256 of the session token, so the database alone can't sign anyone in.
    `CREATE TABLE sessions (token TEXT PRIMARY KEY, fid INTEGER NOT NULL, network_key TEXT NOT NULL, expires INTEGER NOT NULL)`,
    `CREATE INDEX sessions_by_fid ON sessions (fid)`,
    `CREATE TABLE used_signatures (signature TEXT PRIMARY KEY, expires INTEGER NOT NULL)`,
    `CREATE TABLE join_requests (
      fid INTEGER PRIMARY KEY, username TEXT, avatar TEXT, custody TEXT NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL)`,
    `CREATE TABLE invites (
      code TEXT PRIMARY KEY, uses_left INTEGER, expires INTEGER, created INTEGER NOT NULL, created_by INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, revoked INTEGER)`,
    `CREATE TABLE blocks (fid INTEGER PRIMARY KEY, username TEXT, blocked INTEGER NOT NULL, by INTEGER)`,
    // A deleted post with replies stays as a placeholder: deleted is set, and text, embeds, and message are cleared.
    `CREATE TABLE posts (
      hash TEXT PRIMARY KEY, fid INTEGER NOT NULL, time INTEGER NOT NULL, parent TEXT, text TEXT NOT NULL,
      mentions TEXT NOT NULL, embeds TEXT NOT NULL, message TEXT, deleted INTEGER, received INTEGER NOT NULL)`,
    `CREATE INDEX posts_by_parent_and_time ON posts (parent, time DESC, hash DESC)`,
    `CREATE INDEX posts_by_fid ON posts (fid)`,
    `CREATE INDEX posts_by_time ON posts (time)`,
    `CREATE TABLE mentions (post TEXT NOT NULL, fid INTEGER NOT NULL, author INTEGER NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (post, fid))`,
    `CREATE INDEX mentions_by_fid ON mentions (fid, time DESC)`,
    // Hashes of deleted posts, so the same bytes can't add them again while their timestamp is still accepted.
    `CREATE TABLE removed (hash TEXT PRIMARY KEY, fid INTEGER NOT NULL, removed INTEGER NOT NULL)`,
    `CREATE TABLE likes (post TEXT NOT NULL, fid INTEGER NOT NULL, time INTEGER NOT NULL, message TEXT NOT NULL, PRIMARY KEY (post, fid))`,
    `CREATE INDEX likes_by_fid ON likes (fid)`,
    `CREATE TABLE mutes (fid INTEGER NOT NULL, muted INTEGER NOT NULL, PRIMARY KEY (fid, muted))`,
    `CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post TEXT NOT NULL, post_fid INTEGER NOT NULL, fid INTEGER NOT NULL,
      note TEXT NOT NULL, created INTEGER NOT NULL, resolved INTEGER)`,
    `CREATE TABLE admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, admin INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL)`,
  ],
  [
    // One-time links from the app into the admin pages, and the browser sessions they start. Tokens are stored as SHA-256.
    `CREATE TABLE admin_links (token TEXT PRIMARY KEY, fid INTEGER NOT NULL, expires INTEGER NOT NULL)`,
    `CREATE TABLE admin_sessions (token TEXT PRIMARY KEY, fid INTEGER NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL)`,
  ],
  [
    // Images in R2, by ID. kind is "upload", "avatar" (a Farcaster picture copied in), or "preview" (a link's picture).
    // attached is set once a post or profile uses an upload, so it goes as soon as nothing does.
    `CREATE TABLE media (
      id TEXT PRIMARY KEY, fid INTEGER, kind TEXT NOT NULL, type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      bytes INTEGER NOT NULL, created INTEGER NOT NULL, attached INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX media_by_fid ON media (fid)`,
    `CREATE TABLE link_previews (url TEXT PRIMARY KEY, title TEXT, description TEXT, image TEXT, fetched INTEGER NOT NULL)`,
    `ALTER TABLE members ADD COLUMN farcaster_media TEXT`,
  ],
  [
    // The FIDs the admin follows on Farcaster, as of the last time the admin pulled them on Settings.
    `CREATE TABLE follows (fid INTEGER PRIMARY KEY)`,
  ],
  [
    // Which post uses which image and which link, so the cleanup finds what's unused by index rather
    // than by reading every post's embeds. Filled in from the posts already here.
    `CREATE TABLE post_media (post TEXT NOT NULL, media TEXT NOT NULL, PRIMARY KEY (post, media))`,
    `CREATE INDEX post_media_by_media ON post_media (media)`,
    `CREATE TABLE post_links (post TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (post, url))`,
    `CREATE INDEX post_links_by_url ON post_links (url)`,
    `INSERT OR IGNORE INTO post_media (post, media) SELECT p.hash, json_extract(e.value, '$.id') FROM posts p, json_each(p.embeds) e
      WHERE json_extract(e.value, '$.kind') = 'image'`,
    `INSERT OR IGNORE INTO post_links (post, url) SELECT p.hash, json_extract(e.value, '$.url') FROM posts p, json_each(p.embeds) e
      WHERE json_extract(e.value, '$.kind') = 'link'`,
    `CREATE INDEX members_by_avatar_media ON members (avatar_media)`,
    `CREATE INDEX members_by_farcaster_media ON members (farcaster_media)`,
    `CREATE INDEX link_previews_by_image ON link_previews (image)`,
  ],
  [
    // What each member did today, by kind, for the daily limits in daily.ts. Old days go hourly.
    `CREATE TABLE daily_counts (fid INTEGER NOT NULL, day INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (fid, day, kind))`,
  ],
  [
    // Uploads nothing ever used, by age, so the hourly cleanup reads only what goes.
    `CREATE INDEX media_by_kind_attached_created ON media (kind, attached, created)`,
  ],
  [
    // A FID's device keys, which every join from a new device counts.
    `CREATE INDEX device_keys_by_fid ON device_keys (fid)`,
  ],
  [
    // Placeholders only: top-level posts deleted while they had replies. Every delete checks them.
    `CREATE INDEX posts_placeholders ON posts (hash) WHERE parent IS NULL AND deleted IS NOT NULL`,
  ],
  [
    // Each post keeps its reply and like counts, so a feed or thread reads one row a post, not every
    // reply and like. Triggers keep them right on every path that adds or deletes one.
    `ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0`,
    `UPDATE posts SET reply_count = (SELECT COUNT(*) FROM posts r WHERE r.parent = posts.hash),
      like_count = (SELECT COUNT(*) FROM likes l WHERE l.post = posts.hash)`,
    `CREATE TRIGGER posts_reply_added AFTER INSERT ON posts WHEN NEW.parent IS NOT NULL
      BEGIN UPDATE posts SET reply_count = reply_count + 1 WHERE hash = NEW.parent; END`,
    `CREATE TRIGGER posts_reply_removed AFTER DELETE ON posts WHEN OLD.parent IS NOT NULL
      BEGIN UPDATE posts SET reply_count = reply_count - 1 WHERE hash = OLD.parent; END`,
    `CREATE TRIGGER likes_added AFTER INSERT ON likes BEGIN UPDATE posts SET like_count = like_count + 1 WHERE hash = NEW.post; END`,
    `CREATE TRIGGER likes_removed AFTER DELETE ON likes BEGIN UPDATE posts SET like_count = like_count - 1 WHERE hash = OLD.post; END`,
  ],
  [
    // A placeholder goes the moment its last reply does, in the trigger, so no delete reads them all.
    `DROP TRIGGER posts_reply_removed`,
    `CREATE TRIGGER posts_reply_removed AFTER DELETE ON posts WHEN OLD.parent IS NOT NULL
      BEGIN UPDATE posts SET reply_count = reply_count - 1 WHERE hash = OLD.parent;
      DELETE FROM posts WHERE hash = OLD.parent AND deleted IS NOT NULL AND reply_count = 0; END`,
    `DELETE FROM posts WHERE parent IS NULL AND deleted IS NOT NULL AND reply_count = 0`,
  ],
  [
    // A reply keeps its parent's author, so a member's activity reads replies to them by index, newest
    // first, stopping at a page, instead of every post they ever wrote.
    `ALTER TABLE posts ADD COLUMN parent_fid INTEGER`,
    `UPDATE posts SET parent_fid = (SELECT p.fid FROM posts p WHERE p.hash = posts.parent) WHERE parent IS NOT NULL`,
    `CREATE INDEX posts_by_parent_fid ON posts (parent_fid, time DESC, hash DESC) WHERE parent_fid IS NOT NULL`,
  ],
  [
    // Triggers keep what uses what, on every path that writes a post, a preview, or a profile, so
    // nothing can forget: each post's images and links, and each image's count of uses. A link's
    // preview goes with the last post that has the link. Cleanup then reads only unused images.
    `ALTER TABLE media ADD COLUMN uses INTEGER NOT NULL DEFAULT 0`,
    // Posts an older deploy wrote, and rows whose post or link is gone, as the hourly catch-up and daily tidy did.
    `INSERT OR IGNORE INTO post_media (post, media) SELECT p.hash, json_extract(e.value, '$.id') FROM posts p, json_each(p.embeds) e
      WHERE json_extract(e.value, '$.kind') = 'image'`,
    `INSERT OR IGNORE INTO post_links (post, url) SELECT p.hash, json_extract(e.value, '$.url') FROM posts p, json_each(p.embeds) e
      WHERE json_extract(e.value, '$.kind') = 'link'`,
    `DELETE FROM post_media WHERE NOT EXISTS (SELECT 1 FROM posts WHERE hash = post_media.post)`,
    `DELETE FROM post_links WHERE NOT EXISTS (SELECT 1 FROM posts WHERE hash = post_links.post)`,
    `DELETE FROM link_previews WHERE NOT EXISTS (SELECT 1 FROM post_links WHERE url = link_previews.url)`,
    `DELETE FROM settings WHERE key = 'posts_indexed'`,
    `UPDATE media SET uses = (SELECT COUNT(*) FROM post_media WHERE media = media.id) + (SELECT COUNT(*) FROM link_previews WHERE image = media.id)
      + (SELECT COUNT(*) FROM members WHERE avatar_media = media.id) + (SELECT COUNT(*) FROM members WHERE farcaster_media = media.id)`,
    // attached now means something has used it once, so it goes as soon as nothing does.
    `UPDATE media SET attached = 1 WHERE uses > 0`,
    `DROP INDEX media_by_kind_attached_created`,
    `CREATE INDEX media_unused ON media (attached, created) WHERE uses = 0`,

    `CREATE TRIGGER posts_embeds_added AFTER INSERT ON posts BEGIN
      INSERT OR IGNORE INTO post_media (post, media) SELECT NEW.hash, json_extract(value, '$.id') FROM json_each(NEW.embeds) WHERE json_extract(value, '$.kind') = 'image';
      INSERT OR IGNORE INTO post_links (post, url) SELECT NEW.hash, json_extract(value, '$.url') FROM json_each(NEW.embeds) WHERE json_extract(value, '$.kind') = 'link'; END`,
    `CREATE TRIGGER posts_embeds_removed AFTER DELETE ON posts BEGIN
      DELETE FROM post_media WHERE post = OLD.hash; DELETE FROM post_links WHERE post = OLD.hash; END`,
    // A post that becomes a placeholder keeps nothing.
    `CREATE TRIGGER posts_embeds_changed AFTER UPDATE OF embeds ON posts WHEN OLD.embeds IS NOT NEW.embeds BEGIN
      DELETE FROM post_media WHERE post = OLD.hash; DELETE FROM post_links WHERE post = OLD.hash;
      INSERT OR IGNORE INTO post_media (post, media) SELECT NEW.hash, json_extract(value, '$.id') FROM json_each(NEW.embeds) WHERE json_extract(value, '$.kind') = 'image';
      INSERT OR IGNORE INTO post_links (post, url) SELECT NEW.hash, json_extract(value, '$.url') FROM json_each(NEW.embeds) WHERE json_extract(value, '$.kind') = 'link'; END`,
    `CREATE TRIGGER post_links_removed AFTER DELETE ON post_links WHEN NOT EXISTS (SELECT 1 FROM post_links WHERE url = OLD.url) BEGIN
      DELETE FROM link_previews WHERE url = OLD.url; END`,

    `CREATE TRIGGER post_media_added AFTER INSERT ON post_media BEGIN UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.media; END`,
    `CREATE TRIGGER post_media_removed AFTER DELETE ON post_media BEGIN UPDATE media SET uses = uses - 1 WHERE id = OLD.media; END`,
    `CREATE TRIGGER link_previews_added AFTER INSERT ON link_previews WHEN NEW.image IS NOT NULL BEGIN
      UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.image; END`,
    `CREATE TRIGGER link_previews_removed AFTER DELETE ON link_previews WHEN OLD.image IS NOT NULL BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.image; END`,
    `CREATE TRIGGER link_previews_image_changed AFTER UPDATE OF image ON link_previews WHEN OLD.image IS NOT NEW.image BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.image; UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.image; END`,
    `CREATE TRIGGER members_pictures_added AFTER INSERT ON members BEGIN
      UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.avatar_media;
      UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.farcaster_media; END`,
    `CREATE TRIGGER members_pictures_removed AFTER DELETE ON members BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.avatar_media; UPDATE media SET uses = uses - 1 WHERE id = OLD.farcaster_media; END`,
    `CREATE TRIGGER members_avatar_changed AFTER UPDATE OF avatar_media ON members WHEN OLD.avatar_media IS NOT NEW.avatar_media BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.avatar_media; UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.avatar_media; END`,
    `CREATE TRIGGER members_farcaster_media_changed AFTER UPDATE OF farcaster_media ON members WHEN OLD.farcaster_media IS NOT NEW.farcaster_media BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.farcaster_media; UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.farcaster_media; END`,

    // The version moves with anything feeds, threads, and activity show: posts (and with them their
    // likes, replies, and mentions), previews, and members' names and pictures. A change moves it only
    // from even to odd, and versionTag moves it on to even before a reader's tag uses it, so a change
    // after any read always moves it, and a delete of a thousand rows writes it once.
    `UPDATE settings SET value = CAST(value AS INTEGER) * 2 + 2 WHERE key = 'version'`,
    ...[
      ["posts_added", "AFTER INSERT ON posts"], ["posts_changed", "AFTER UPDATE ON posts"], ["posts_removed", "AFTER DELETE ON posts"],
      ["previews_added", "AFTER INSERT ON link_previews"], ["previews_changed", "AFTER UPDATE ON link_previews"],
      ["previews_removed", "AFTER DELETE ON link_previews"], ["members_added", "AFTER INSERT ON members"], ["members_removed", "AFTER DELETE ON members"],
      ["members_changed", `AFTER UPDATE OF username, display_name, avatar_media, farcaster_media ON members WHEN OLD.username IS NOT NEW.username
        OR OLD.display_name IS NOT NEW.display_name OR OLD.avatar_media IS NOT NEW.avatar_media OR OLD.farcaster_media IS NOT NEW.farcaster_media`],
    ].map(([name, when]) => `CREATE TRIGGER version_${name} ${when} BEGIN ${CHANGED}; END`),
  ],
  [
    // A post's own previews of its links, which its author's app read and sent, so the server needn't
    // fetch the page. Each post keeps its own, so nobody can restyle a link someone else posted. The
    // picture is one of the author's uploads, counted like any other use.
    `ALTER TABLE post_links ADD COLUMN title TEXT`,
    `ALTER TABLE post_links ADD COLUMN description TEXT`,
    `ALTER TABLE post_links ADD COLUMN image TEXT`,
    `CREATE TRIGGER post_links_image_removed AFTER DELETE ON post_links WHEN OLD.image IS NOT NULL BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.image; END`,
    `CREATE TRIGGER post_links_image_changed AFTER UPDATE OF image ON post_links WHEN OLD.image IS NOT NEW.image BEGIN
      UPDATE media SET uses = uses - 1 WHERE id = OLD.image; UPDATE media SET uses = uses + 1, attached = 1 WHERE id = NEW.image; END`,
    `CREATE TRIGGER version_post_links_changed AFTER UPDATE ON post_links BEGIN ${CHANGED}; END`,
  ],
  [
    // An admin page sign-in, and the link that starts it, belong to the network key that asked for
    // them, and end with it: when that device is signed out, or the FID gets a new owner. Sign-ins from
    // before have none, so they end once and the admin opens Manage Network again.
    `ALTER TABLE admin_links ADD COLUMN network_key TEXT`,
    `ALTER TABLE admin_sessions ADD COLUMN network_key TEXT`,
    // When the hourly job may try again a member whose ownership check failed, so a few that keep
    // failing don't hold up everyone else.
    `ALTER TABLE members ADD COLUMN check_after INTEGER NOT NULL DEFAULT 0`,
  ],
];
