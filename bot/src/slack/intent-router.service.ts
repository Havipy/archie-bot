import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { BOT_NAME } from './slack.constants';

export type UserIntent = 'rag' | 'chitchat' | 'examples' | 'help';

export interface IntentRoute {
  intent: UserIntent;
  reply?: string;
  /** Expanded KB search query when intent is rag (nano rewrites vague/short questions). */
  searchQuery?: string;
  /** Exact-match terms for keyword boost when intent is rag. */
  keywords?: string[];
}

const ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL ?? 'gpt-5.4-nano';

const INTENTS = `intents:
- rag — factual question about HR, benefits, deployment, policies, company docs, OR any follow-up in an ongoing Q&A (e.g. "what else", "что еще знаешь", "tell me more", "anything else about that"). reply: ""
- chitchat — ONLY pure greeting/thanks/goodbye with no question (hi, thanks, bye). reply: 1-2 warm sentences in English
- help — ONLY when user explicitly asks what the bot can do (first contact, no prior Q&A). NOT for follow-ups. reply: "" (app builds the message)
- examples — user wants sample questions to ask. reply: one short inviting line

If conversation history exists and the user asks vaguely for more ("what else do you know", "что еще", "а еще") → intent MUST be rag. searchQuery must continue the prior topic from history, not generic capabilities.

If follow-up about the same doc/meeting ("what decisions were made?", "action items?", "who attended?") → searchQuery MUST include the meeting/date/topic from the prior user question in history.

For intent rag also set searchQuery: rewrite the user message into one clear knowledge-base search query.
Expand tech terms (e.g. "zod" → "Zod validation library backend"). If follow-up with history, combine with the prior topic. One line, no quotes.

For intent rag also set keywords: 1-8 exact terms to match in docs (product names, tech, policies, acronyms). Lowercase.
Skip filler/stop words and generic terms (library, backend, system). Example: "Maybe zod" → ["zod"]; "PTO policy" → ["pto", "policy"].`;

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);
  private readonly openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    this.logger.log(`Intent router: ${ROUTER_MODEL}`);
  }

  async route(
    message: string,
    bases: string[] = [],
    options?: { history?: Array<{ role: 'user' | 'assistant'; content: string }> },
  ): Promise<IntentRoute> {
    const basesLine = bases.length ? `Knowledge bases: ${bases.join(', ')}.` : '';
    const history = options?.history?.slice(-4) ?? [];

    try {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: [
            `You are ${BOT_NAME}, a Slack knowledge-base bot. ${basesLine}`,
            'Return JSON: {"intent":"rag|chitchat|help|examples","reply":"...","searchQuery":"...","keywords":[]}',
            'searchQuery + keywords: required when intent is rag, omit otherwise.',
            INTENTS,
            'reply: Slack mrkdwn (*bold* ok), always English, no # headers.',
            'When unsure: {"intent":"rag","reply":""}',
          ].join('\n'),
        },
        ...history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content.slice(0, 400),
        })),
        { role: 'user', content: message.slice(0, 500) },
      ];

      const response = await this.openai.chat.completions.create({
        model: ROUTER_MODEL,
        max_completion_tokens: 250,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages,
      });

      const parsed = this.parseRoute(response.choices[0]?.message?.content ?? '');
      this.logger.debug(
        `Intent ${parsed.intent}: ${message.slice(0, 60)}${parsed.keywords?.length ? ` kw=[${parsed.keywords.join(',')}]` : ''}`,
      );
      return parsed;
    } catch (err) {
      this.logger.warn('Intent router failed, defaulting to rag', err);
      return { intent: 'rag' };
    }
  }

  private parseKeywords(raw: unknown): string[] | undefined {
    if (Array.isArray(raw)) {
      const keywords = raw
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      return keywords.length ? keywords.slice(0, 8) : undefined;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const keywords = raw
        .split(/[,;|]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      return keywords.length ? keywords.slice(0, 8) : undefined;
    }
    return undefined;
  }

  private parseRoute(raw: string): IntentRoute {
    try {
      const data = JSON.parse(raw) as {
        intent?: string;
        reply?: string;
        searchQuery?: string;
        keywords?: unknown;
      };
      const intent = data.intent?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
      const reply = typeof data.reply === 'string' ? data.reply.trim() : undefined;
      const searchQuery =
        typeof data.searchQuery === 'string' ? data.searchQuery.trim().replace(/^["']|["']$/g, '') : undefined;
      const keywords = this.parseKeywords(data.keywords);

      if (intent === 'chitchat' || intent === 'help' || intent === 'examples') {
        return { intent, reply: reply || undefined };
      }
      return { intent: 'rag', searchQuery: searchQuery || undefined, keywords };
    } catch {
      const word = raw.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, '') ?? '';
      if (word === 'chitchat' || word === 'help' || word === 'examples') {
        return { intent: word };
      }
      return { intent: 'rag' };
    }
  }
}
