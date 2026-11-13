import type { Post } from "../src/protocol/api.ts";
import { NetworkError } from "./client.ts";

/** Printing for the demo and the real-account walkthrough. */

export const section = (title: string) => console.log(`\n${title}`);
export const ok = (text: string) => console.log(`  ✓ ${text}`);
export const show = (text: string) => console.log(`      ${text}`);

export class WalkthroughFailed extends Error {}

export function expect(condition: unknown, what: string): asserts condition {
  if (!condition) throw new WalkthroughFailed(what);
}

/** The server's message when it refuses, as it should. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NetworkError) return error.message;
    throw error;
  }
  throw new WalkthroughFailed("The server should have refused that.");
}

/** A post as a few lines of text. `name` turns an FID into how it shows. */
export function describePost(post: Post, name: (fid: number) => string): string[] {
  if (post.deleted) return ["This post was deleted"];
  const counts = [
    post.replies && `${post.replies} ${post.replies === 1 ? "reply" : "replies"}`,
    post.likes && `${post.likes} ${post.likes === 1 ? "like" : "likes"}`,
  ].filter(Boolean).join(" · ");
  const lines = [`${name(post.fid).padEnd(7)} ${post.text}${counts ? `   (${counts})` : ""}`];
  for (const embed of post.embeds) {
    if (embed.type === "post") lines.push(`        ↳ quotes ${embed.post ? `${name(embed.post.fid)}: ${embed.post.text}` : "a deleted post"}`);
    if (embed.type === "link") lines.push(`        ↳ link ${embed.url}`);
  }
  return lines;
}

/** A post and its replies, indented under it. */
export function describeThread(post: Post, replies: Post[], name: (fid: number) => string): string[] {
  return [...describePost(post, name), ...replies.flatMap((reply) => describePost(reply, name).map((line) => `  ${line}`))];
}

export function failure(error: unknown) {
  if (error instanceof WalkthroughFailed) return `Expected: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
