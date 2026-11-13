/** The JSON a network server answers with. See docs/NETWORK.md. */

export type JoinStatus = "approved" | "pending" | "refused";

export interface JoinRequest {
  fid: number;
  deviceKey: string;
  deviceApproval: { issuedAt: number; signature: string };
  networkKey: string;
  networkApproval: { issued: number; signature: string };
  invite?: string;
  avatar?: string;
}

export interface SessionRequest {
  fid: number;
  networkKey: string;
  issued: number;
  nonce: string;
  signature: string;
}

export interface Session {
  token: string;
  expires: number;
}

export interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
}

export type PostEmbed =
  | { type: "image"; url: string; width: number; height: number; src: string; full: string }
  | { type: "link"; url: string; preview: LinkPreview | null }
  | { type: "post"; hash: string; post: Post | null };

export interface Post {
  hash: string;
  fid: number;
  time: number;
  text: string;
  mentions: { fid: number; username: string }[];
  parent: string | null;
  embeds: PostEmbed[];
  replies: number;
  likes: number;
  liked: boolean;
  deleted: boolean;
  /** The signed message, base64. Missing on a deleted post. */
  message?: string;
}

export interface Member {
  fid: number;
  username: string;
  displayName: string;
  bio: string;
  /** A signed link to the picture's thumb size, or null for initials. */
  avatar: string | null;
  /** Whether the picture was uploaded here, rather than copied from Farcaster. */
  ownAvatar: boolean;
  role: "admin" | "member";
  joined: number;
  muted: boolean;
}

export interface NetworkInfo {
  name: string;
  icon: string | null;
  retention: "30 days" | "forever";
  you: Member;
}

export interface FeedPage {
  posts: Post[];
  next: string | null;
}

export interface Thread {
  post: Post;
  replies: Post[];
}

export interface ActivityItem {
  kind: "reply" | "mention";
  post: Post;
  /** For a reply, the post it answers, without its embeds. */
  parent: Post | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  next: string | null;
}

export interface UploadedImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export interface ProfileChange {
  displayName?: string;
  bio?: string;
  /** An uploaded image's ID, or "farcaster" for the Farcaster picture. */
  avatar?: string;
  /** The Farcaster picture, which the app uploaded itself, so the network needn't fetch it. */
  farcasterPicture?: string;
}

/** A link's preview, which the post's author's app read from the page and sends. */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  /** An uploaded image's ID. */
  image?: string;
}
