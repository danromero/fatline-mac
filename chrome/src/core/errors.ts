const device = "browser";

const messages = {
  invalidPhrase: "Check the spelling and order of the recovery words.",
  accountNotFound: "This recovery phrase is valid, but it isn’t linked to a Farcaster account. Check that it’s your Farcaster recovery phrase, not one from another wallet.",
  invalidClock: `Check your ${device}’s date and time.`,
  expiredAuthorization: "The authorization expired. Enter your phrase again.",
  inactiveKey: `This ${device}’s posting key is no longer active. Sign out and enter your recovery phrase to post again.`,
  postOnlyKey: `This ${device}’s posting key can only post. Sign out and enter your recovery phrase again to get one that can delete casts.`,
  invalidCast: "Write a cast of up to 320 UTF-8 bytes.",
  missingKey: "The posting key is unavailable.",
  awaitingSigner: "Snapchain is still syncing the posting key. Try again.",
  unconfirmed: "Retry to check the same cast.",
  unavailable: "Couldn’t reach the service. Try again.",
  storage: "Fatline couldn’t save to this browser.",
} as const;

export type PostingErrorKind = keyof typeof messages | "rejected";

export class PostingError extends Error {
  readonly kind: PostingErrorKind;

  constructor(kind: keyof typeof messages);
  constructor(kind: "rejected", reason: string);
  constructor(kind: PostingErrorKind, reason?: string) {
    super(kind === "rejected" ? (reason ?? "") : messages[kind]);
    this.kind = kind;
  }
}

export class FeedHTTPError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}
