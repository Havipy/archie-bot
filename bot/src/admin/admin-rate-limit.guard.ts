import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class AdminRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs = 60_000;
  private readonly maxRequests = 120;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    }>();

    const ip = this.clientIp(req);
    const now = Date.now();
    const bucket = this.buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    bucket.count += 1;
    if (bucket.count > this.maxRequests) {
      throw new HttpException('Too many requests — try again later', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  private clientIp(req: {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
  }): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || 'unknown';
    return req.ip ?? 'unknown';
  }
}

/** Login brute-force protection — shared in-memory limiter. */
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

export function resetLoginRateLimit(ip: string): void {
  loginBuckets.delete(ip);
}
