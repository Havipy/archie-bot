import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual, createHmac } from 'crypto';
import { checkLoginRateLimit, clientIp } from '@/lib/rate-limit.util';
import { adminSecret } from '@/lib/admin-secret';

const COOKIE = 'faq_admin_auth';

function signToken(): string {
  return createHmac('sha256', adminSecret()).update('admin:authenticated').digest('hex');
}

export async function POST(req: NextRequest) {
  if (!process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'ADMIN_SECRET is not configured' }, { status: 503 });
  }

  const ip = clientIp(req);

  try {
    checkLoginRateLimit(ip);
  } catch {
    return NextResponse.json({ error: 'Too many attempts — try again in 15 min' }, { status: 429 });
  }

  const { password } = (await req.json()) as { password?: string };

  if (!password) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const a = Buffer.from(password.padEnd(64));
  const b = Buffer.from(adminSecret().padEnd(64));
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) {
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, signToken(), {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
    secure: process.env.NODE_ENV === 'production',
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
