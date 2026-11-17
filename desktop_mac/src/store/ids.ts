import crypto from "node:crypto";

/**
 * Prefixed ULID. The first 10 chars are a millisecond timestamp (time-ordered), the last 16 random.
 *
 * Why not UUID v4: ULIDs are naturally ordered, so far fewer page splits when indexed on the backend later;
 * the prefix makes logs readable at a glance and catches wrongly passed parameters immediately.
 * These rules match conductor's, so pushing standalone data up later is just a copy with no ID changes.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIX = {
  user: "u_",
  conversation: "t_",
  message: "m_",
  skill: "k_",
  memory: "y_",
  proposal: "p_",
  workspace: "w_",
  attachment: "f_"
} as const;

export function ulid(): string {
  const now = Date.now();
  let out = "";
  let ts = now;
  const timePart: string[] = [];
  for (let i = 0; i < 10; i++) {
    timePart.unshift(ENCODING[ts % 32]);
    ts = Math.floor(ts / 32);
  }
  out += timePart.join("");
  const random = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    out += ENCODING[random[i] % 32];
  }
  return out;
}

export function newId(kind: keyof typeof ID_PREFIX): string {
  return ID_PREFIX[kind] + ulid();
}
