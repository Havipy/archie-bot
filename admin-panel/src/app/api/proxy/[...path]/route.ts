import { NextRequest, NextResponse } from 'next/server';
import { adminSecret } from '@/lib/admin-secret';

function botUrl(): string {
  return process.env.BOT_API_URL ?? 'http://localhost:3000';
}

async function proxy(req: NextRequest, { params }: { params: { path: string[] } }) {
  if (!process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'ADMIN_SECRET is not configured' }, { status: 503 });
  }

  const target = new URL(`/api/${params.path.join('/')}`, botUrl());
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${adminSecret()}`);

  const contentType = req.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(target.toString(), { method: req.method, headers, body });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
