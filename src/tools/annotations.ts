// The annotation sets the tool definitions share. Every tool reaches Stockbit over the internet, so
// openWorldHint is true throughout.

// Reads only: calling again changes nothing.
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// Changes something the user owns that is easy to undo: a watchlist entry, an alert.
export const CHANGES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// Removes something the user owns, or moves money: deleting a watchlist, placing, amending or
// cancelling an order. Clients ask before running these.
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
