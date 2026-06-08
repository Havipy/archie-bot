interface Bucket {
  count: number;
  resetAt: number;
}

const loginBuckets = new Map<string, Bucket>();

export function checkLoginRateLimit(ip: string): void {
  const maxAttempts = 10;
  const windowMs = 15 * 60_000;
  const now = Date.now();
  const bucket = loginBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    loginBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxAttempts) {
    throw new Error('RATE_LIMIT');
  }
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return 'unknown';
}
