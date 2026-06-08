import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { App, ExpressReceiver } from '@slack/bolt';
import { Namespace } from '../database/entities/namespace.entity';
import { AnswerResult, RagService } from '../rag/rag.service';
import { ConversationService } from '../rag/conversation.service';
import { AccessService } from './access.service';
import { IntentRoute, IntentRouterService } from './intent-router.service';
import { FeedbackService } from './feedback.service';
import {
  applyFeedbackAck,
  buildAnswerBlocks,
  buildAnswerFallbackText,
  buildChitchatBlocks,
  buildFeedbackPromptBlocks,
  buildLoadingBlocks,
  buildMoreExamplesBlocks,
  buildNoResultsBlocks,
  buildStreamingAnswerBlocks,
  decodeFeedback,
  extractAnswerFromBlocks,
  feedbackAckText,
  parsePickBaseQuestion,
  welcomeBlocks,
} from './slack-blocks.util';
import {
  ALL_BASES,
  BOT_NAME,
  NO_ACCESS_TEXT,
} from './slack.constants';
import {
  chitchatReply,
  helpReply,
  isGreetingOnly,
  isHelpRequest,
  decodeAction,
  isGenericBotReply,
  looksLikeNoDataAnswer,
  streamVisibleAnswer,
} from './slack-format.util';

const STREAM_THROTTLE_MS = 1200;

@Injectable()
export class SlackService implements OnModuleInit {
  private readonly logger = new Logger(SlackService.name);
  /** Per-user pinned namespace slug, or ALL_BASES for search everywhere. */
  private readonly pinnedBaseByUser = new Map<string, string>();
  /** Dedupe when Slack sends both app_mention event and message subtype. */
  private readonly recentMentions = new Set<string>();
  /** Threads where Archie replied — owner can follow up without @mention. */
  private readonly activeThreads = new Map<
    string,
    { ownerId: string; timer: ReturnType<typeof setTimeout> }
  >();
  /** DM users who already saw the welcome screen this session. */
  private readonly welcomedUsers = new Set<string>();
  private botUserId: string | null = null;
  public readonly receiver: ExpressReceiver;
  public readonly app: App;

  constructor(
    @InjectRepository(Namespace)
    private readonly namespaceRepo: Repository<Namespace>,
    private readonly ragService: RagService,
    private readonly conversationService: ConversationService,
    private readonly accessService: AccessService,
    private readonly intentRouter: IntentRouterService,
    private readonly feedbackService: FeedbackService,
  ) {
    this.receiver = new ExpressReceiver({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      endpoints: '/slack/events',
    });

    this.app = new App({
      token: process.env.SLACK_BOT_TOKEN!,
      receiver: this.receiver,
    });
  }

  async onModuleInit() {
    this.registerHandlers();
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id ?? null;
      this.logger.log(
        `Slack bot @${auth.user} (${this.botUserId}) — invite to channel + subscribe app_mention & message.channels`,
      );
    } catch (err) {
      this.logger.error('Slack auth.test failed — check SLACK_BOT_TOKEN', err);
    }
  }

  private sessionKey(userId: string, channelId?: string, threadTs?: string): string {
    if (channelId && threadTs) return `thread:${channelId}:${threadTs}:${userId}`;
    return `dm:${userId}`;
  }

  private threadKey(channelId: string, threadTs: string): string {
    return `${channelId}:${threadTs}`;
  }

  private markThreadActive(channelId: string, threadTs: string, ownerId: string): void {
    const key = this.threadKey(channelId, threadTs);
    const existing = this.activeThreads.get(key);
    if (existing) clearTimeout(existing.timer);
    this.activeThreads.set(key, {
      ownerId,
      timer: setTimeout(() => this.activeThreads.delete(key), 24 * 60 * 60 * 1000),
    });
  }

  /** Auto-reply without @mention — only the user who opened the thread. */
  private canAutoReplyInThread(channelId: string, threadTs: string | undefined, userId: string): boolean {
    if (!threadTs) return false;
    return this.activeThreads.get(this.threadKey(channelId, threadTs))?.ownerId === userId;
  }

  private setPinnedBase(userId: string, slug: string): void {
    if (slug === ALL_BASES) this.pinnedBaseByUser.delete(userId);
    else this.pinnedBaseByUser.set(userId, slug);
  }

  private resolvePinnedSlugs(
    userId: string,
    namespaces: Namespace[],
    override?: string[],
  ): { slugs: string[] | null; explicit: boolean } {
    if (override?.length) {
      return { slugs: override, explicit: true };
    }
    const choice = this.pinnedBaseByUser.get(userId);
    if (!choice) return { slugs: null, explicit: false };
    if (choice === ALL_BASES) {
      return { slugs: namespaces.map((n) => n.slug), explicit: true };
    }
    if (namespaces.some((n) => n.slug === choice)) {
      return { slugs: [choice], explicit: true };
    }
    this.pinnedBaseByUser.delete(userId);
    return { slugs: null, explicit: false };
  }

  private isDm(channelId: string, channelName?: string): boolean {
    return channelName === 'directmessage' || channelId.startsWith('D');
  }

  private async isFirstDmContact(client: App['client'], userId: string): Promise<boolean> {
    if (this.welcomedUsers.has(userId)) return false;
    try {
      const history = await client.conversations.history({ channel: userId, limit: 3 });
      const botMessages = (history.messages ?? []).filter(
        (m) => m.bot_id || m.subtype === 'bot_message',
      );
      return botMessages.length === 0;
    } catch {
      // fallback to in-memory check if API call fails (e.g. no im:history scope)
      return this.conversationService.getHistory(userId, this.sessionKey(userId)).length === 0;
    }
  }

  private async showHelp(
    client: App['client'],
    userId: string,
    namespaces: Namespace[],
    question?: string,
  ): Promise<void> {
    const intro = helpReply(namespaces, question);
    await client.chat.postMessage({
      channel: userId,
      blocks: buildChitchatBlocks(intro, namespaces),
      text: intro.replace(/\*([^*]+)\*/g, '$1'),
    });
  }

  private async showWelcome(
    client: App['client'],
    userId: string,
    namespaces: Namespace[],
    question?: string,
  ): Promise<void> {
    this.welcomedUsers.add(userId);
    await client.chat.postMessage({
      channel: userId,
      blocks: welcomeBlocks(namespaces, question, true),
      text: `${BOT_NAME} — ask a question about ${namespaces.map((n) => n.name).join(', ')}.`,
    });
  }

  private isMessageNotFound(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'data' in err &&
      typeof (err as { data?: { error?: string } }).data?.error === 'string' &&
      (err as { data: { error: string } }).data.error === 'message_not_found'
    );
  }

  private async postFeedbackPrompt(
    client: App['client'],
    channelId: string,
    userId: string,
    question: string,
    answer: string,
    topScore: number,
    bases: string[],
    threadTs?: string,
  ): Promise<void> {
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        blocks: buildFeedbackPromptBlocks(question, answer, topScore, bases),
        text: 'Was this helpful?',
      });
    } catch (err) {
      this.logger.warn('Failed to post feedback prompt', err);
    }
  }

  private async updateMessage(
    client: App['client'],
    channel: string,
    ts: string,
    payload: { blocks?: ReturnType<typeof buildAnswerBlocks>; text: string },
  ): Promise<void> {
    try {
      await client.chat.update({ channel, ts, ...payload });
    } catch (err) {
      if (this.isMessageNotFound(err)) {
        await client.chat.postMessage({ channel, ...payload });
        return;
      }
      throw err;
    }
  }

  private async replyMoreExamples(
    client: App['client'],
    channel: string,
    ts: string,
    _userId: string,
    namespaces: Namespace[],
    intro?: string,
  ): Promise<void> {
    const targets = namespaces.map((n) => ({ namespace: n.slug, name: n.name }));
    const seeds = ['HR policies leave benefits', 'deployment release rollback staging', 'onboarding tools setup'];
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    const questions = await this.ragService.generateSampleQuestions(targets, { seed });

    await this.updateMessage(client, channel, ts, {
      blocks: buildMoreExamplesBlocks(namespaces, questions, intro),
      text: intro ?? 'More question ideas — tap or type your own.',
    });
  }

  private async replyConversational(
    client: App['client'],
    channel: string,
    ts: string,
    intro: string,
    namespaces: Namespace[],
  ): Promise<void> {
    const plain = intro.replace(/\*([^*]+)\*/g, '$1');
    await this.updateMessage(client, channel, ts, {
      blocks: buildChitchatBlocks(intro, namespaces),
      text: plain,
    });
  }

  private async dispatchNonRagIntent(
    client: App['client'],
    channelId: string,
    userId: string,
    question: string,
    namespaces: Namespace[],
    route: IntentRoute,
    options?: { replace?: { channel: string; ts: string }; threadTs?: string },
  ): Promise<void> {
    const { intent, reply } = route;

    const fallback =
      intent === 'help'
        ? helpReply(namespaces, question)
        : intent === 'examples'
          ? 'More ideas — tap a button or type your own question 👇'
          : chitchatReply(question);
    const intro = intent === 'help' ? fallback : reply?.trim() || fallback;

    let channel: string;
    let ts: string;
    if (options?.replace) {
      ({ channel, ts } = options.replace);
    } else {
      const msg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: options?.threadTs,
        text: intro.replace(/\*([^*]+)\*/g, '$1'),
      });
      if (!msg.ts) return;
      channel = msg.channel ?? channelId;
      ts = msg.ts;
    }

    if (intent === 'examples') {
      await this.replyMoreExamples(
        client,
        channel,
        ts,
        userId,
        namespaces,
        intro,
      );
      return;
    }

    await this.replyConversational(
      client,
      channel,
      ts,
      intro,
      namespaces,
    );
  }

  private isPureChitchat(question: string): boolean {
    return /^(спасибо|thanks|thank\s+you|thx|привет|hello|hi|hey|пока|bye|goodbye|ок|ok|okay)[!.?\s]*$/i.test(
      question.trim(),
    );
  }

  private isThreadContinuation(question: string): boolean {
    return /^(что\s+(ещё|еще)|what\s+else|tell\s+me\s+more|ещё\s+что|а\s+(ещё|еще)|расскажи\s+(ещё|еще)|anything\s+else|what\s+more|какой\s+ещё|какие\s+ещё|что\s+ещё\s+знаешь|что\s+еще\s+знаешь)/i.test(
      question.trim(),
    );
  }

  private async searchAndReply(
    client: App['client'],
    channelId: string,
    userId: string,
    question: string,
    namespaces: Namespace[],
    options?: {
      pinnedSlugs?: string[];
      replace?: { channel: string; ts: string };
      threadTs?: string;
      syntheticHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
  ): Promise<void> {
    const availableBases = namespaces.map((n) => n.name);
    const key = this.sessionKey(userId, channelId, options?.threadTs);
    const storedHistory = this.conversationService.getHistory(userId, key);
    const history = storedHistory.length
      ? storedHistory
      : (options?.syntheticHistory ?? []);

    const { slugs: pinnedSlugs, explicit: explicitPin } = this.resolvePinnedSlugs(
      userId,
      namespaces,
      options?.pinnedSlugs,
    );
    const pinned = pinnedSlugs?.length
      ? namespaces.filter((n) => pinnedSlugs.includes(n.slug))
      : null;

    // Post an instant placeholder BEFORE intent routing — the router is an LLM call
    // and without this the chat looks frozen right after the user hits send.
    const loadingPayload = {
      blocks: buildLoadingBlocks(
        'think',
        question,
        pinned?.map((n) => n.name) ?? availableBases,
        {
          routeMode: pinned ? 'pinned' : undefined,
          availableBases,
        },
      ),
      text: '💭 Thinking...',
    };

    let channel: string;
    let ts: string;
    if (options?.replace) {
      ({ channel, ts } = options.replace);
      await this.updateMessage(client, channel, ts, loadingPayload);
    } else {
      const loading = await client.chat.postMessage({
        channel: channelId,
        thread_ts: options?.threadTs,
        ...loadingPayload,
      });
      if (!loading.ts) return;
      channel = loading.channel ?? channelId;
      ts = loading.ts;
      if (options?.threadTs) this.markThreadActive(channelId, options.threadTs, userId);
    }

    let route = await this.intentRouter.route(question, availableBases, {
      history: history.length ? history : undefined,
    });

    // Thread follow-up like "что еще знаешь" must search KB, not generic help
    if (
      options?.threadTs &&
      history.length > 0 &&
      route.intent !== 'rag' &&
      !this.isPureChitchat(question) &&
      this.isThreadContinuation(question)
    ) {
      this.logger.log(`Thread follow-up → RAG: ${question.slice(0, 60)}`);
      route = { intent: 'rag' };
    }

    if (route.intent !== 'rag') {
      await this.dispatchNonRagIntent(
        client,
        channelId,
        userId,
        question,
        namespaces,
        route,
        {
          replace: { channel, ts },
          threadTs: options?.threadTs,
        },
      );
      return;
    }

    const pinnedPayload = pinned?.map((ns) => ({
      namespace: ns.slug,
      name: ns.name,
    }));
    const nsPayload = namespaces.map((ns) => ({
      namespace: ns.slug,
      name: ns.name,
    }));

    await this.updateMessage(client, channel, ts, {
      blocks: buildLoadingBlocks(
        'search',
        question,
        pinned?.map((n) => n.name) ?? availableBases,
        {
          routeMode: pinned ? 'pinned' : undefined,
          availableBases,
        },
      ),
      text: '🔍 Searching...',
    });

    try {
      const historyCtx = history.length ? history : undefined;
      const searchQuery = await this.ragService.resolveSearchQuery(
        question,
        route.searchQuery,
        historyCtx,
      );
      const priorSources = this.conversationService.getLastSources(userId, key);
      const followUp = this.ragService.isFollowUpQuestion(question, historyCtx);
      const searchFn = followUp && priorSources.length
        ? (q: string, ns: typeof nsPayload, vec?: number[]) =>
            this.ragService.searchWithPriorDocs(
              q,
              ns,
              priorSources,
              vec,
              route.keywords,
              question,
              searchQuery,
            )
        : (q: string, ns: typeof nsPayload, vec?: number[]) =>
            this.ragService.searchInNamespaces(q, ns, vec, route.keywords, question, searchQuery);

      let search = pinnedPayload?.length
        ? {
            ...(await searchFn(searchQuery, pinnedPayload)),
            routeMode: 'pinned' as const,
            availableBases,
          }
        : followUp && priorSources.length
          ? {
              ...(await this.ragService.searchWithPriorDocs(
                searchQuery,
                nsPayload,
                priorSources,
                undefined,
                route.keywords,
                question,
                searchQuery,
              )),
              routeMode: 'broadcast' as const,
              availableBases,
            }
          : await this.ragService.searchAcrossNamespaces(question, nsPayload, searchQuery, route.keywords);

      if (
        !search.sources.length &&
        pinnedPayload?.length &&
        namespaces.length > pinnedPayload.length &&
        !explicitPin
      ) {
        this.logger.log(
          'Pinned search empty → widening to all accessible bases',
        );
        const wide = await searchFn(searchQuery, nsPayload);
        if (wide.sources.length) {
          search = {
            ...wide,
            routeMode: 'broadcast_fallback' as const,
            availableBases,
          };
        }
      }

      const { sources, topScore, searchedBases, searchedSlugs, routeMode } =
        search;
      const bases = searchedBases.length ? searchedBases : availableBases;
      const baseSlugs = searchedSlugs.length
        ? searchedSlugs
        : namespaces.map((n) => n.slug);

      const inDm = this.isDm(channel);
      const slackOpts = { showBasePicker: inDm, includeFeedback: inDm };

      if (!sources.length) {
        await this.updateMessage(client, channel, ts, {
          blocks: buildNoResultsBlocks(question, baseSlugs, namespaces, slackOpts),
          text: 'No answer found — try rephrasing.',
        });
        return;
      }

      await this.updateMessage(client, channel, ts, {
        blocks: buildLoadingBlocks('generate', question, bases, {
          routeMode,
          availableBases,
          fragmentCount: sources.length,
        }),
        text: '📄 Drafting answer...',
      });

      let lastEdit = 0;
      const raw = await this.ragService.generateAnswerStream(
        question,
        sources,
        history,
        async (full) => {
          if (/^\s*NO_DATA/i.test(full)) return;
          const now = Date.now();
          if (now - lastEdit < STREAM_THROTTLE_MS) return;
          const visible = streamVisibleAnswer(full);
          if (!visible) return;
          lastEdit = now;
          try {
            await this.updateMessage(client, channel, ts, {
              blocks: buildStreamingAnswerBlocks(visible, baseSlugs, routeMode),
              text: visible,
            });
          } catch {
            /* transient Slack rate-limit during stream — ignore */
          }
        },
      );

      let { answer, followUps, noData, citedIndices } = this.ragService.parseRawAnswer(raw);

      if (!noData && (isGenericBotReply(answer) || looksLikeNoDataAnswer(answer))) {
        noData = true;
        followUps = [];
      }

      if (noData) {
        await this.updateMessage(client, channel, ts, {
          blocks: buildNoResultsBlocks(question, bases, namespaces, slackOpts),
          text: 'No answer found — try rephrasing.',
        });
        return;
      }

      this.conversationService.addExchange(
        userId,
        key,
        question,
        answer,
        sources
          .filter((s) => s.docId && s.namespaceSlug)
          .slice(0, 2)
          .map((s) => ({
            docId: s.docId!,
            namespaceSlug: s.namespaceSlug!,
            filename: s.filename,
          })),
      );

      const result: AnswerResult = {
        answer,
        sources,
        topScore,
        followUps,
        searchedBases,
        searchedSlugs,
        routeMode,
        availableBases,
        citedIndices,
      };

      await this.updateMessage(client, channel, ts, {
        blocks: buildAnswerBlocks(question, result, userId, namespaces, slackOpts),
        text: buildAnswerFallbackText(question, result, userId),
      });
      if (!inDm) {
        await this.postFeedbackPrompt(
          client,
          channelId,
          userId,
          question,
          answer,
          topScore,
          searchedBases,
          options?.threadTs,
        );
      }
    } catch (err) {
      this.logger.error('Search failed', err);
      await this.updateMessage(client, channel, ts, {
        text: 'Something went wrong. Please try again later.',
      });
    }
  }

  private async handleDm(
    client: App['client'],
    userId: string,
    channelId: string,
    text?: string,
  ): Promise<void> {
    const question = text?.trim();
    const namespaces = await this.getAccessibleNamespaces(userId);

    if (!namespaces.length) {
      await client.chat.postMessage({ channel: userId, text: NO_ACCESS_TEXT });
      return;
    }

    if (question && isHelpRequest(question)) {
      await this.showHelp(client, userId, namespaces, question);
      return;
    }

    if (!question || ((await this.isFirstDmContact(client, userId)) && isGreetingOnly(question))) {
      await this.showWelcome(client, userId, namespaces, question);
      return;
    }

    await this.searchAndReply(client, channelId, userId, question, namespaces);
  }

  private claimMention(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`;
    if (this.recentMentions.has(key)) return false;
    this.recentMentions.add(key);
    setTimeout(() => this.recentMentions.delete(key), 60_000);
    return true;
  }

  private async handleChannelMention(
    client: App['client'],
    event: {
      channel: string;
      user: string;
      text?: string;
      ts: string;
      thread_ts?: string;
    },
  ): Promise<void> {
    if (!this.claimMention(event.channel, event.ts)) return;

    this.logger.log(`Channel mention: user=${event.user} channel=${event.channel} ts=${event.ts}`);

    try {
      const question = (event.text ?? '')
        .replace(/<@[A-Z0-9]+>/g, '')
        .trim();

      const threadTs = event.thread_ts ?? event.ts;

      const channelNamespaces = await this.accessService.getNamespacesByChannelId(event.channel);
      const accessibleNamespaces = await this.getAccessibleNamespaces(event.user);

      const pinnedNamespaces = channelNamespaces.length
        ? channelNamespaces.filter((cn) => accessibleNamespaces.some((an) => an.id === cn.id))
        : [];

      const namespaces = pinnedNamespaces.length ? pinnedNamespaces : accessibleNamespaces;

      if (!namespaces.length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: NO_ACCESS_TEXT,
        });
        return;
      }

      if (!question) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          blocks: welcomeBlocks(namespaces),
          text: `${BOT_NAME} — mention me with a question.`,
        });
        return;
      }

      const boundLabel = pinnedNamespaces.length
        ? pinnedNamespaces.map((n) => n.slug).join(', ')
        : 'all';
      this.logger.log(`Mention @${event.user} in ${event.channel} [${boundLabel}]: ${question.slice(0, 80)}`);

      await this.searchAndReply(client, event.channel, event.user, question, namespaces, {
        threadTs,
        pinnedSlugs: pinnedNamespaces.length ? pinnedNamespaces.map((n) => n.slug) : undefined,
      });
    } catch (err) {
      this.logger.error(`Channel mention failed channel=${event.channel}`, err);
      try {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts ?? event.ts,
          text: `⚠️ ${BOT_NAME} hit an error. Check bot logs.`,
        });
      } catch {
        /* ignore secondary failure */
      }
    }
  }

  private isChannelMentionMessage(
    message: { channel: string; subtype?: string; text?: string },
    botUserId?: string,
  ): boolean {
    if (this.isDm(message.channel)) return false;
    if (String(message.subtype ?? '') === 'app_mention') return true;
    if (botUserId && message.text?.includes(`<@${botUserId}>`)) return true;
    return false;
  }

  private registerHandlers() {
    this.app.use(async ({ payload, next }) => {
      const body = payload as { type?: string; event?: { type?: string; channel?: string } };
      if (body.type === 'event_callback' && body.event?.type) {
        this.logger.log(`Slack event: ${body.event.type} channel=${body.event.channel ?? '—'}`);
      }
      await next();
    });

    this.app.error(async (err) => {
      this.logger.error('Slack Bolt error', err);
    });

    this.app.message(async ({ message, client, context }) => {
      if (!('user' in message) || !message.user) return;
      if (message.user === context.botUserId || 'bot_id' in message) return;

      const text = 'text' in message ? message.text : undefined;
      const botId = context.botUserId ?? this.botUserId ?? undefined;

      if (
        this.isChannelMentionMessage(
          { channel: message.channel, subtype: 'subtype' in message ? String(message.subtype ?? '') : undefined, text },
          botId,
        ) &&
        'ts' in message &&
        message.ts
      ) {
        await this.handleChannelMention(client, {
          channel: message.channel,
          user: message.user,
          text,
          ts: message.ts,
          thread_ts: 'thread_ts' in message ? message.thread_ts : undefined,
        });
        return;
      }

      // Follow-up without @mention — only the user who @mentioned Archie first
      const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;
      const trimmed = text?.trim() ?? '';
      if (
        threadTs &&
        trimmed &&
        !trimmed.startsWith('/') &&
        !this.isDm(message.channel) &&
        this.canAutoReplyInThread(message.channel, threadTs, message.user) &&
        'ts' in message &&
        message.ts
      ) {
        this.logger.log(`Thread follow-up ${message.user} in ${message.channel}: ${trimmed.slice(0, 80)}`);
        await this.handleChannelMention(client, {
          channel: message.channel,
          user: message.user,
          text: trimmed,
          ts: message.ts,
          thread_ts: threadTs,
        });
        return;
      }

      if (message.subtype || !this.isDm(message.channel)) return;

      if (!trimmed || trimmed.startsWith('/')) return;

      this.logger.log(`DM ${message.user}: ${trimmed.slice(0, 80)}`);
      await this.handleDm(client, message.user, message.channel, trimmed);
    });

    this.app.event('app_mention', async ({ event, client }) => {
      if (!event.user) return;
      await this.handleChannelMention(client, {
        channel: event.channel,
        user: event.user,
        text: event.text,
        ts: event.ts,
        thread_ts: event.thread_ts,
      });
    });

    this.app.command('/archie', async ({ command, ack, client }) => {
      await ack();

      const question = command.text?.trim();
      if (!question) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `Usage: \`/archie your question\``,
        });
        return;
      }

      const channelNamespaces = await this.accessService.getNamespacesByChannelId(command.channel_id);
      const accessibleNamespaces = await this.getAccessibleNamespaces(command.user_id);
      const pinnedNamespaces = channelNamespaces.length
        ? channelNamespaces.filter((cn) => accessibleNamespaces.some((an) => an.id === cn.id))
        : [];
      const namespaces = pinnedNamespaces.length ? pinnedNamespaces : accessibleNamespaces;

      if (!namespaces.length) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: NO_ACCESS_TEXT,
        });
        return;
      }

      this.logger.log(`/archie in ${command.channel_id}: ${question.slice(0, 80)}`);
      await this.searchAndReply(client, command.channel_id, command.user_id, question, namespaces, {
        pinnedSlugs: pinnedNamespaces.length ? pinnedNamespaces.map((n) => n.slug) : undefined,
      });
    });

    this.app.command('/help', async ({ command, ack, client }) => {
      await ack();
      const namespaces = await this.getAccessibleNamespaces(command.user_id);
      if (!namespaces.length) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: NO_ACCESS_TEXT,
        });
        return;
      }
      const intro = helpReply(namespaces, command.text?.trim() || 'help');
      const payload = { blocks: buildChitchatBlocks(intro, namespaces), text: intro.replace(/\*([^*]+)\*/g, '$1') };
      if (this.isDm(command.channel_id, command.channel_name)) {
        await client.chat.postMessage({ channel: command.user_id, ...payload });
      } else {
        await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, ...payload });
      }
    });

    this.app.command('/faq', async ({ command, ack, client }) => {
      await ack();

      if (!this.isDm(command.channel_id, command.channel_name)) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `💬 ${BOT_NAME} works in Direct Messages. Open a DM and ask your question.`,
        });
        return;
      }

      await this.handleDm(
        client,
        command.user_id,
        command.channel_id,
        command.text?.trim(),
      );
    });

    const handleActionSearch = async (
      action: unknown,
      body: unknown,
      client: App['client'],
      opts?: { replaceMessage?: boolean },
    ): Promise<void> => {
      const userId = (body as { user: { id: string } }).user.id;
      const channelId =
        (body as { channel?: { id?: string } }).channel?.id ?? userId;
      const { q, ns, all, replace: replaceFlag, ctx, act } = decodeAction((action as { value: string }).value);
      // Fallback when in-memory history is empty (DM follow-up after restart, etc.)
      const syntheticHistory =
        ctx || act
          ? [
              ...(ctx ? [{ role: 'user' as const, content: ctx }] : []),
              ...(act ? [{ role: 'assistant' as const, content: act }] : []),
            ]
          : undefined;
      const namespaces = await this.getAccessibleNamespaces(userId);
      if (!namespaces.length) return;

      const pinnedSlugs = all
        ? namespaces.map((n) => n.slug)
        : ns?.filter((slug) => namespaces.some((n) => n.slug === slug));

      if (all) this.setPinnedBase(userId, ALL_BASES);
      else if (pinnedSlugs?.length === 1) this.setPinnedBase(userId, pinnedSlugs[0]!);

      const messageTs = (body as { container?: { message_ts?: string } })
        .container?.message_ts;
      // thread_ts: if the button is inside a thread, carry it so history is found
      const threadTs =
        (body as { message?: { thread_ts?: string } }).message?.thread_ts ??
        (body as { container?: { thread_ts?: string } }).container?.thread_ts;
      const shouldReplace =
        replaceFlag ?? opts?.replaceMessage ?? false;
      const replace =
        shouldReplace && messageTs
          ? { channel: channelId, ts: messageTs }
          : undefined;

      await this.searchAndReply(client, channelId, userId, q, namespaces, {
        pinnedSlugs,
        replace,
        threadTs: threadTs ?? undefined,
        syntheticHistory,
      });
    };

    this.app.action(/^quick_search_/, async ({ action, ack, body, client }) => {
      await ack();
      await handleActionSearch(action, body, client, { replaceMessage: true });
    });

    this.app.action(/^follow_up_/, async ({ action, ack, body, client }) => {
      await ack();
      await handleActionSearch(action, body, client);
    });

    this.app.action('pick_base', async ({ action, ack, body, client }) => {
      await ack();
      const userId = (body as { user: { id: string } }).user.id;
      const channelId =
        (body as { channel?: { id?: string } }).channel?.id ?? userId;
      const a = action as {
        selected_option?: { value: string };
        block_id?: string;
      };
      const question = parsePickBaseQuestion(a.block_id);
      const choice = a.selected_option?.value;
      if (!question || !choice) return;

      const namespaces = await this.getAccessibleNamespaces(userId);
      if (!namespaces.length) return;

      const messageTs = (body as { container?: { message_ts?: string } })
        .container?.message_ts;
      const pinnedSlugs =
        choice === ALL_BASES ? namespaces.map((n) => n.slug) : [choice];
      this.setPinnedBase(userId, choice);
      await this.searchAndReply(
        client,
        channelId,
        userId,
        question,
        namespaces,
        {
          pinnedSlugs,
          replace: messageTs
            ? { channel: channelId, ts: messageTs }
            : undefined,
        },
      );
    });

    const handleFeedback = async (
      rating: 'up' | 'down',
      action: unknown,
      body: unknown,
      client: App['client'],
      respond?: (message: { replace_original?: boolean; text: string }) => Promise<unknown>,
    ): Promise<void> => {
      const userId = (body as { user: { id: string } }).user.id;
      const message = (body as { message?: { ts?: string; blocks?: unknown } })
        .message;
      const channelId =
        (body as { channel?: { id?: string } }).channel?.id ?? userId;
      const isEphemeral =
        (body as { container?: { is_ephemeral?: boolean } }).container
          ?.is_ephemeral === true;
      const payload = decodeFeedback((action as { value: string }).value);
      if (!payload) return;

      const answer =
        payload.a ?? extractAnswerFromBlocks(message?.blocks) ?? '';
      await this.feedbackService.record({
        userId,
        question: payload.q,
        answer,
        rating,
        bases: payload.b,
        topScore: payload.s,
      });

      const ackText = feedbackAckText(rating);
      try {
        if (isEphemeral && respond) {
          await respond({ replace_original: true, text: ackText });
          return;
        }
        if (message?.ts) {
          await client.chat.update({
            channel: channelId,
            ts: message.ts,
            blocks: applyFeedbackAck(message.blocks, rating),
            text: answer || 'Answer',
          });
        }
      } catch (err) {
        this.logger.warn('Failed to ack feedback', err);
      }
    };

    this.app.action('feedback_up', async ({ action, ack, body, client, respond }) => {
      await ack();
      await handleFeedback('up', action, body, client, respond);
    });

    this.app.action('feedback_down', async ({ action, ack, body, client, respond }) => {
      await ack();
      await handleFeedback('down', action, body, client, respond);
    });

    this.app.event('app_home_opened', async ({ event, client }) => {
      const namespaces = await this.getAccessibleNamespaces(event.user);
      if (!namespaces.length) return;

      await client.views.publish({
        user_id: event.user,
        view: { type: 'home', blocks: welcomeBlocks(namespaces) },
      });

      // Send welcome DM on first open (tab === 'home' to avoid firing on every tab switch)
      if (event.tab === 'home' && (await this.isFirstDmContact(client, event.user))) {
        try {
          await this.showWelcome(client, event.user, namespaces);
        } catch (err) {
          this.logger.warn(`Could not send welcome DM to ${event.user}`, err);
        }
      }
    });
  }

  private async getAccessibleNamespaces(userId: string): Promise<Namespace[]> {
    const all = await this.namespaceRepo.find();
    const results = await Promise.all(
      all.map(async (ns) => ({
        ns,
        allowed: await this.accessService.canAccess(userId, ns.id, this.app),
      })),
    );
    return results.filter((r) => r.allowed).map((r) => r.ns);
  }
}
