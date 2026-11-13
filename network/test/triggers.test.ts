import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, test } from "node:test";
import { MIGRATIONS } from "../src/server/migrations.ts";

/**
 * The triggers that keep what uses what and move the feed version, on the real migrations in SQLite,
 * by writing rows the way any deploy might, old or new.
 */

let db: DatabaseSync;
const run = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).run(...values);
const one = <T>(sql: string, ...values: (string | number | null)[]) => db.prepare(sql).get(...values) as T;
const uses = (id: string) => ({ ...one<{ uses: number; attached: number }>("SELECT uses, attached FROM media WHERE id = ?", id) });
const version = () => Number(one<{ value: string } | undefined>("SELECT value FROM settings WHERE key = 'version'")?.value ?? 0);
/** What versionTag does before it reads the version. */
const read = () => run("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version' AND CAST(value AS INTEGER) % 2 = 1");

const image = (id: string, created = 1000) => run("INSERT INTO media (id, fid, kind, type, width, height, bytes, created) VALUES (?, 7, 'upload', 'image/png', 1, 1, 1, ?)", id, created);
const post = (hash: string, embeds: unknown[], parent: string | null = null) =>
  run("INSERT INTO posts (hash, fid, time, parent, text, mentions, embeds, received) VALUES (?, 7, 1000, ?, '', '[]', ?, 1000)", hash, parent, JSON.stringify(embeds));
const link = (url: string) => ({ kind: "link", url });
const picture = (id: string) => ({ kind: "image", id, url: `https://n.example/m/${id}` });

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS.flat()) db.exec(sql);
  run("INSERT INTO members (fid, custody, joined, checked) VALUES (7, '0x', 1000, 1000)");
});

describe("what uses what", () => {
  test("a post's images and links follow it in, through a placeholder, and out", () => {
    image("a");
    post("p1", [picture("a"), link("https://x.example/")]);
    assert.deepEqual(uses("a"), { uses: 1, attached: 1 });
    assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM post_links WHERE post = 'p1'").n, 1);

    post("r1", [], "p1");
    run("UPDATE posts SET deleted = 1, embeds = '[]' WHERE hash = 'p1'");
    assert.deepEqual(uses("a"), { uses: 0, attached: 1 }, "a placeholder keeps nothing");
    assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM post_links").n, 0);
  });

  test("a preview goes with the last post that has its link, and its picture is let go", () => {
    image("shot");
    post("p1", [link("https://x.example/")]);
    post("p2", [link("https://x.example/")]);
    run("INSERT INTO link_previews (url, title, image, fetched) VALUES ('https://x.example/', 'X', 'shot', 1000)");
    assert.equal(uses("shot").uses, 1);
    run("DELETE FROM posts WHERE hash = 'p1'");
    assert.ok(one("SELECT 1 FROM link_previews"), "p2 still has the link");
    run("DELETE FROM posts WHERE hash = 'p2'");
    assert.equal(one("SELECT 1 FROM link_previews"), undefined);
    assert.deepEqual(uses("shot"), { uses: 0, attached: 1 });
  });

  test("a preview fetched again moves its picture's count", () => {
    image("old");
    image("new");
    post("p1", [link("https://x.example/")]);
    run("INSERT INTO link_previews (url, image, fetched) VALUES ('https://x.example/', 'old', 1000)");
    run(`INSERT INTO link_previews (url, image, fetched) VALUES ('https://x.example/', 'new', 2000)
      ON CONFLICT (url) DO UPDATE SET image = excluded.image, fetched = excluded.fetched`);
    assert.equal(uses("old").uses, 0);
    assert.equal(uses("new").uses, 1);
  });

  test("profile pictures count while a member points to them", () => {
    image("me");
    image("fc");
    run("UPDATE members SET avatar_media = 'me', farcaster_media = 'fc' WHERE fid = 7");
    assert.equal(uses("me").uses + uses("fc").uses, 2);
    run("UPDATE members SET avatar_media = NULL, checked = 2000 WHERE fid = 7");
    assert.equal(uses("me").uses, 0);
    run("DELETE FROM members WHERE fid = 7");
    assert.equal(uses("fc").uses, 0);
  });

  test("the cleanup reads only unused images: used ones at once, never-used ones after a day", () => {
    image("used", 5000);
    image("fresh", 5000);
    image("stale", 1000);
    image("kept", 1000);
    post("p1", [picture("used"), picture("kept")]);
    run("DELETE FROM post_media WHERE media = 'used'");
    const due = db.prepare(`SELECT id FROM media WHERE uses = 0 AND attached = 1
      UNION SELECT id FROM media WHERE uses = 0 AND attached = 0 AND created < ?1
      UNION SELECT id FROM media WHERE fid = ?2 AND uses = 0 LIMIT 200`).all(2000, null) as { id: string }[];
    assert.deepEqual(due.map((row) => row.id).sort(), ["stale", "used"]);
  });
});

describe("the feed version", () => {
  test("moves with a change after a read, once however many rows change", () => {
    read();
    const start = version();
    for (let index = 0; index < 50; index++) post(`p${index}`, []);
    assert.equal(version(), start + 1, "fifty posts before anyone reads move it once");
    read();
    const seen = version();
    assert.notEqual(seen, start);
    run("DELETE FROM posts");
    assert.equal(version(), seen + 1);
    read();
    assert.notEqual(version(), seen);
  });

  test("likes and replies move it through their post, and previews and names on their own", () => {
    post("p1", []);
    const moves = (change: () => void) => {
      read();
      const before = version();
      change();
      return version() !== before;
    };
    assert.ok(moves(() => run("INSERT INTO likes (post, fid, time, message) VALUES ('p1', 7, 1000, '')")));
    assert.ok(moves(() => post("r1", [], "p1")));
    assert.ok(moves(() => run("INSERT INTO link_previews (url, fetched) VALUES ('https://x.example/', 1000)")));
    assert.ok(moves(() => run("UPDATE members SET username = 'new' WHERE fid = 7")));
    assert.ok(!moves(() => run("UPDATE members SET username = 'new', checked = 3000 WHERE fid = 7")), "the hourly check, with nothing new");
    assert.ok(!moves(() => run("INSERT INTO mutes (fid, muted) VALUES (7, 8)")), "mutes are in the viewer's own tag");
  });
});

describe("the migration that added them", () => {
  test("counts what uses each image already, and catches up rows an older deploy left", () => {
    db = new DatabaseSync(":memory:");
    const added = MIGRATIONS.findIndex((migration) => migration.some((sql) => sql.includes("ADD COLUMN uses")));
    for (const sql of MIGRATIONS.slice(0, added).flat()) db.exec(sql);
    run("INSERT INTO members (fid, custody, joined, checked, avatar_media) VALUES (7, '0x', 1000, 1000, 'me')");
    for (const id of ["me", "posted", "shot", "orphan"]) image(id);
    // Posted by a deploy that didn't write post_media or post_links.
    post("p1", [picture("posted"), link("https://x.example/")]);
    run("INSERT INTO link_previews (url, image, fetched) VALUES ('https://x.example/', 'shot', 1000), ('https://gone.example/', 'orphan', 1000)");
    run("INSERT INTO settings (key, value) VALUES ('version', '5'), ('posts_indexed', '900')");

    for (const sql of MIGRATIONS.slice(added).flat()) db.exec(sql);
    assert.deepEqual([uses("me").uses, uses("posted").uses, uses("shot").uses, uses("orphan").uses], [1, 1, 1, 0]);
    assert.equal(one("SELECT 1 FROM link_previews WHERE url = 'https://gone.example/'"), undefined, "a preview no post has goes");
    assert.equal(one("SELECT 1 FROM settings WHERE key = 'posts_indexed'"), undefined);
    assert.ok(version() % 2 === 0 && version() > 5, "every old tag stops matching");
  });
});
