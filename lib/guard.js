// Abuse limits for the public endpoint. Every request spends the deployer's Wafer credits, so:
//   - per-client token bucket: a real game makes ~5 decisions/sec, so 12/sec with a burst of 30
//     never bothers a player but stops a script hammering the endpoint
//   - per-client cap per minute, and a per-instance cap per minute as a spend ceiling
//   - same-origin check, so other sites can't embed the API
// These live in memory, so they are per server instance: good against casual abuse, not a
// distributed attack. Wafer credits are prepaid, which bounds the worst case at the account balance.

const PER_SEC = 12;
const BURST = 30;
const PER_CLIENT_PER_MIN = 500;
const PER_INSTANCE_PER_MIN = Number(process.env.MAX_DECISIONS_PER_MIN || 3000);

const buckets = new Map(); // client -> { tokens, last, minute, count }
let instanceMinute = 0;
let instanceCount = 0;

export function checkLimits(client, now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  if (minute !== instanceMinute) (instanceMinute = minute), (instanceCount = 0);
  if (++instanceCount > PER_INSTANCE_PER_MIN) return { ok: false, retryAfter: 60 - Math.floor((now / 1000) % 60), reason: "server busy" };

  let b = buckets.get(client);
  if (!b) {
    if (buckets.size > 10_000) buckets.clear(); // bound memory
    b = { tokens: BURST, last: now, minute, count: 0 };
    buckets.set(client, b);
  }
  b.tokens = Math.min(BURST, b.tokens + ((now - b.last) / 1000) * PER_SEC);
  b.last = now;
  if (b.minute !== minute) (b.minute = minute), (b.count = 0);
  if (b.tokens < 1) return { ok: false, retryAfter: 1, reason: "slow down" };
  if (++b.count > PER_CLIENT_PER_MIN) return { ok: false, retryAfter: 60 - Math.floor((now / 1000) % 60), reason: "minute limit" };
  b.tokens -= 1;
  return { ok: true };
}

/** Reject requests whose Origin is another site. Requests with no Origin (curl, same-origin GET) pass. */
export function sameOrigin(originHeader, hostHeader) {
  if (!originHeader) return true;
  try {
    return new URL(originHeader).host === hostHeader;
  } catch {
    return false;
  }
}
