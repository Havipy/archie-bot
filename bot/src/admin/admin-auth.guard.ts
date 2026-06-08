import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) {
      throw new UnauthorizedException('ADMIN_SECRET is not configured');
    }

    const req = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${secret}`;

    const a = Buffer.from(header.padEnd(256));
    const b = Buffer.from(expected.padEnd(256));

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid or missing admin token');
    }

    return true;
  }
}
