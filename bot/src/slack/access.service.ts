import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { App } from '@slack/bolt';
import { AccessRule, AccessRuleType } from '../database/entities/access-rule.entity';
import { Namespace } from '../database/entities/namespace.entity';
import { AccessMode } from '../database/entities/types';

export interface AddRuleDto {
  type: AccessRuleType;
  value: string;
  label?: string;
}

interface ResolvedUsergroup {
  id: string;
  handle: string;
  name: string;
}

interface ResolvedChannel {
  id: string;
  name: string;
}

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private static readonly GROUP_ID_RE = /^S[A-Z0-9]+$/;
  private static readonly CHANNEL_ID_RE = /^[CG][A-Z0-9]+$/;

  private static readonly CACHE_TTL = 10 * 60_000;

  private emailCache = new Map<string, { email: string; exp: number }>();
  private groupMembersCache = new Map<string, { members: Set<string>; exp: number }>();

  constructor(
    @InjectRepository(AccessRule)
    private readonly ruleRepo: Repository<AccessRule>,
    @InjectRepository(Namespace)
    private readonly namespaceRepo: Repository<Namespace>,
  ) {}

  async getRules(namespaceId: string): Promise<AccessRule[]> {
    return this.ruleRepo.find({ where: { namespaceId }, order: { createdAt: 'ASC' } });
  }

  async addRule(namespaceId: string, dto: AddRuleDto, app: App): Promise<AccessRule> {
    let { type, value, label } = dto;

    if (type === 'slack_group') {
      const group = await this.resolveUsergroup(app, value);
      const existing = await this.ruleRepo.findOne({
        where: { namespaceId, type: 'slack_group', value: group.id },
      });
      if (existing) return existing;

      value = group.id;
      label = label?.trim() || `@${group.handle}`;
    } else if (type === 'slack_channel') {
      const channel = await this.resolveChannel(app, value);
      const existing = await this.ruleRepo.findOne({
        where: { namespaceId, type: 'slack_channel', value: channel.id },
      });
      if (existing) return existing;

      value = channel.id;
      label = label?.trim() || `#${channel.name}`;
    } else {
      label = label ?? value;
    }

    const rule = this.ruleRepo.create({ namespaceId, type, value, label });
    return this.ruleRepo.save(rule);
  }

  async removeRule(namespaceId: string, ruleId: string): Promise<void> {
    await this.ruleRepo.delete({ id: ruleId, namespaceId });
  }

  /**
   * Returns namespaces linked to a Slack channel (slack_channel rule).
   * Used by app_mention to pin search — not an ACL gate (see canAccess).
   */
  async getNamespacesByChannelId(channelId: string): Promise<Namespace[]> {
    const rules = await this.ruleRepo.find({
      where: { type: 'slack_channel', value: channelId },
      relations: ['namespace'],
    });
    return rules.map((r) => r.namespace).filter(Boolean);
  }

  async canAccess(userId: string, namespaceId: string, app: App): Promise<boolean> {
    const ns = await this.namespaceRepo.findOne({ where: { id: namespaceId } });
    if (!ns) return false;
    if (ns.accessMode === AccessMode.PUBLIC) return true;

    const rules = await this.getRules(namespaceId);
    if (rules.length === 0) return false;

    const accessRules = rules.filter((r) => r.type !== 'slack_channel');
    if (accessRules.length === 0) {
      // Channel link only → KB searchable in DM; channel rule pins @mentions.
      return true;
    }

    const results = await Promise.all(accessRules.map((r) => this.matchRule(userId, r, app)));
    return results.some(Boolean);
  }

  private async matchRule(userId: string, rule: AccessRule, app: App): Promise<boolean> {
    switch (rule.type) {
      case 'email':
      case 'email_domain': {
        const email = await this.getUserEmail(userId, app);
        return rule.type === 'email' ? email === rule.value : email.endsWith(rule.value);
      }
      case 'slack_group':
        return this.isUserInGroup(userId, rule.value, app);
      default:
        return false;
    }
  }

  private async resolveUsergroup(app: App, handleOrId: string): Promise<ResolvedUsergroup> {
    const input = handleOrId.trim().replace(/^@/, '');
    if (!input) throw new BadRequestException('Slack group handle is required');

    const res = await app.client.usergroups.list({ include_disabled: false });
    if (!res.ok) {
      throw new BadRequestException(`Failed to list Slack user groups: ${res.error ?? 'unknown error'}`);
    }

    const groups = res.usergroups ?? [];
    const byId = AccessService.GROUP_ID_RE.test(input)
      ? groups.find((g) => g.id === input)
      : undefined;
    const byHandle = groups.find((g) => g.handle === input);
    const group = byId ?? byHandle;

    if (!group?.id) {
      throw new BadRequestException(`Slack user group "${handleOrId}" not found`);
    }

    return {
      id: group.id,
      handle: group.handle ?? input,
      name: group.name ?? group.handle ?? input,
    };
  }

  private async resolveChannel(app: App, nameOrId: string): Promise<ResolvedChannel> {
    const input = nameOrId.trim().replace(/^#/, '');
    if (!input) throw new BadRequestException('Slack channel name is required');

    if (AccessService.CHANNEL_ID_RE.test(input)) {
      try {
        const res = await app.client.conversations.info({ channel: input });
        if (res.ok && res.channel?.id) {
          return { id: res.channel.id, name: (res.channel as { name?: string }).name ?? input };
        }
      } catch (err) {
        this.rethrowSlackScopeError(err, 'resolve channel by ID');
        /* fall through to name lookup */
      }
    }

    let cursor: string | undefined;
    do {
      let res;
      try {
        res = await app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });
      } catch (err) {
        this.rethrowSlackScopeError(err, 'list channels');
        throw err;
      }
      if (!res.ok) {
        throw new BadRequestException(`Failed to list Slack channels: ${res.error ?? 'unknown error'}`);
      }
      const match = (res.channels ?? []).find((c) => c.name === input || c.id === input);
      if (match?.id) return { id: match.id, name: match.name ?? input };
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new BadRequestException(
      `Slack channel "${nameOrId}" not found. ` +
        'For private channels, invite the bot first (/invite @Archie in the channel), then retry. ' +
        'You can also paste the channel ID (starts with C or G) from channel details.',
    );
  }

  private async getUserEmail(userId: string, app: App): Promise<string> {
    const hit = this.emailCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.email;
    try {
      const res = await app.client.users.info({ user: userId });
      const email = (res.user as any)?.profile?.email ?? '';
      this.emailCache.set(userId, { email, exp: Date.now() + AccessService.CACHE_TTL });
      return email;
    } catch { return ''; }
  }

  private async isUserInGroup(userId: string, groupId: string, app: App): Promise<boolean> {
    const members = await this.getGroupMembers(groupId, app);
    return members?.has(userId) ?? false;
  }

  private rethrowSlackScopeError(err: unknown, action: string): void {
    const data = (err as { data?: { error?: string; needed?: string } })?.data;
    if (data?.error !== 'missing_scope') return;

    throw new BadRequestException(
      `Slack bot is missing scopes for ${action}. Add ${data.needed ?? 'channels:read, groups:read'} under OAuth & Permissions, then Reinstall to Workspace.`,
    );
  }

  private async getGroupMembers(groupId: string, app: App): Promise<Set<string> | null> {
    const hit = this.groupMembersCache.get(groupId);
    if (hit && hit.exp > Date.now()) return hit.members;

    try {
      const res = await app.client.usergroups.users.list({ usergroup: groupId });
      if (!res.ok) {
        this.logger.warn(`Could not fetch user group ${groupId}: ${res.error ?? 'unknown error'}`);
        return null;
      }

      const members = new Set(((res as { users?: string[] }).users ?? []));
      this.groupMembersCache.set(groupId, {
        members,
        exp: Date.now() + AccessService.CACHE_TTL,
      });
      return members;
    } catch (err) {
      this.logger.warn(`Could not fetch user group ${groupId}: ${err}`);
      return null;
    }
  }
}
