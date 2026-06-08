import type { KnownBlock } from '@slack/types';
import { Namespace } from '../database/entities/namespace.entity';
import { AnswerResult, RouteMode, SearchResult } from '../rag/rag.service';
import {
  answerStatus,
  formatSourceLine,
  parseSourceFilename,
} from '../documents/document-link.util';
import {
  buttonLabel,
  chitchatReply,
  encodeAction,
  extractCitedIndices,
  structureAnswer,
  welcomeIntro,
  dmWelcomeQuestions,
} from './slack-format.util';
import { ALL_BASES, PICK_BASE_PREFIX } from './slack.constants';

function sourceDedupeKey(source: SearchResult): string {
  const { url } = parseSourceFilename(source.filename);
  return url ?? source.docId ?? source.filename;
}

interface DisplayedSource {
  source: SearchResult;
  citeIndex: number;
}

function pickDisplayedSources(
  sources: SearchResult[],
  answer?: string,
  citedIndices?: number[],
): DisplayedSource[] {
  const cited = citedIndices?.length
    ? citedIndices
    : answer
      ? extractCitedIndices(answer)
      : [];
  const picked: DisplayedSource[] = cited.length
    ? cited
        .map((i) => ({ source: sources[i - 1], citeIndex: i }))
        .filter((p) => p.source)
    : sources.slice(0, 1).map((s, i) => ({ source: s, citeIndex: i + 1 }));

  const seen = new Set<string>();
  return picked
    .filter(({ source }) => {
      const key = sourceDedupeKey(source);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
}

function formatSources(
  sources: SearchResult[],
  userId: string,
  question: string,
  answer?: string,
  citedIndices?: number[],
): KnownBlock[] {
  const displayed = pickDisplayedSources(sources, answer, citedIndices);
  if (!displayed.length) return [];

  const lines = displayed.map(({ source, citeIndex }) =>
    formatSourceLine(citeIndex - 1, source, userId, { citeIndex }),
  );

  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📎 ${lines.join('   ')}` }],
    },
  ];
}

function routeBasesLabel(
  mode: RouteMode | string | undefined,
  bases: string,
  loading = false,
): string {
  if (mode === 'pinned') {
    return loading ? `📌 *In this base:* ${bases}` : `📌 ${bases}`;
  }
  if (mode === 'routed') {
    return loading ? `🎯 *Router picked:* ${bases}` : `🎯 ${bases}`;
  }
  if (mode === 'broadcast_fallback') {
    return loading
      ? `🔍 *Expanded search:* ${bases} (router missed — searching everywhere)`
      : `🔍 ${bases}`;
  }
  return loading ? `📌 *${bases}*` : `📌 ${bases}`;
}

function pickBaseElement(question: string, namespaces: Namespace[]) {
  if (namespaces.length <= 1) return null;
  return {
    type: 'static_select' as const,
    action_id: 'pick_base',
    placeholder: {
      type: 'plain_text' as const,
      text: 'Search another base',
      emoji: true,
    },
    options: [
      ...namespaces.map((n) => ({
        text: {
          type: 'plain_text' as const,
          text: buttonLabel(`📚 ${n.slug}`, 75),
          emoji: true,
        },
        value: n.slug,
      })),
      {
        text: {
          type: 'plain_text' as const,
          text: '🌐 All bases',
          emoji: true,
        },
        value: ALL_BASES,
      },
    ],
  };
}

/** One full-width button per row — avoids Slack truncating 3-up layouts. */
function quickSearchButtonBlocks(questions: string[]): KnownBlock[] {
  return questions.map((q, i) => ({
    type: 'actions' as const,
    block_id: `quick_search_${i}`,
    elements: [
      {
        type: 'button' as const,
        text: {
          type: 'plain_text' as const,
          text: buttonLabel(q),
          emoji: true,
        },
        action_id: `quick_search_${i}`,
        value: encodeAction({ q }),
      },
    ],
  }));
}

export function buildLoadingBlocks(
  phase: 'think' | 'search' | 'generate',
  question: string,
  bases: string[],
  options?: {
    routeMode?: string;
    availableBases?: string[];
    fragmentCount?: number;
  },
): KnownBlock[] {
  const { routeMode, availableBases, fragmentCount } = options ?? {};
  const basesText = bases.join(' · ');
  const contextLine =
    routeMode === 'broadcast' &&
    availableBases &&
    availableBases.length > bases.length
      ? `🔍 *All bases:* ${basesText}`
      : routeBasesLabel(routeMode, basesText, true);

  const fragmentWord = fragmentCount === 1 ? 'fragment' : 'fragments';
  const status =
    phase === 'think'
      ? '💭 *Thinking...*'
      : phase === 'search'
        ? '🔍 *Searching...*'
        : `📄 *Found ${fragmentCount} ${fragmentWord} · drafting answer...*`;

  return [
    { type: 'section', text: { type: 'mrkdwn', text: status } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: question }] },
    ...(phase !== 'think'
      ? [
          {
            type: 'context' as const,
            elements: [{ type: 'mrkdwn' as const, text: contextLine }],
          },
        ]
      : []),
  ];
}

const BULLETS_PER_BLOCK = 6;
const MRKDWN_MAX = 2800;

function chunkBullets(bullets: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const bullet of bullets) {
    const lineLen = `• ${bullet}`.length + 1;
    if (
      current.length >= BULLETS_PER_BLOCK ||
      (chars + lineLen > MRKDWN_MAX && current.length)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(bullet);
    chars += lineLen;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function buildAnswerBodyBlocks(answer: string): KnownBlock[] {
  const segments = structureAnswer(answer);
  const blocks: KnownBlock[] = [];

  for (const seg of segments) {
    if (seg.lead) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: seg.lead },
      });
    }
    if (seg.section) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*${seg.section}*` }],
      });
    }
    for (const chunk of chunkBullets(seg.bullets)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk.map((b) => `• ${b}`).join('\n') },
      });
    }
  }

  if (!blocks.length && answer.trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: answer.trim() },
    });
  }

  return blocks;
}

export function buildStreamingAnswerBlocks(
  partialAnswer: string,
  bases: string[],
  routeMode: RouteMode | string | undefined,
): KnownBlock[] {
  const body = buildAnswerBodyBlocks(partialAnswer);
  const last = body[body.length - 1];
  if (last?.type === 'section' && last.text?.type === 'mrkdwn') {
    last.text.text += ' ▌';
  }
  return [
    ...body,
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '✍️ _Typing..._' },
        { type: 'mrkdwn', text: `_${bases.join(' · ')}_` },
      ],
    },
  ];
}

export interface SlackAnswerOptions {
  /** Base picker is DM-only — channels use ACL / router, not manual override. */
  showBasePicker?: boolean;
  /** Inline 👍/👎 on the answer — DM only; channels use ephemeral prompt. */
  includeFeedback?: boolean;
}

export function buildAnswerBlocks(
  question: string,
  result: AnswerResult,
  userId: string,
  namespaces: Namespace[],
  options: SlackAnswerOptions = {},
): KnownBlock[] {
  const showBasePicker = options.showBasePicker ?? false;
  const includeFeedback = options.includeFeedback ?? false;
  const displayed = pickDisplayedSources(
    result.sources,
    result.answer,
    result.citedIndices,
  );
  const sourceBlocks = formatSources(
    result.sources,
    userId,
    question,
    result.answer,
    result.citedIndices,
  );
  const basesText =
    result.routeMode === 'pinned' && result.searchedSlugs.length === 1
      ? `📌 ${result.searchedSlugs[0]}`
      : result.searchedSlugs.join(' · ');

  const blocks: KnownBlock[] = [...buildAnswerBodyBlocks(result.answer)];

  if (sourceBlocks.length) {
    blocks.push(...sourceBlocks);
  } else if (!basesText) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: answerStatus(displayed.length, result.topScore),
        },
      ],
    });
  }

  for (const [i, q] of result.followUps.slice(0, 3).entries()) {
    blocks.push({
      type: 'actions',
      block_id: `follow_up_${i}`,
      elements: [
        {
          type: 'button' as const,
          text: {
            type: 'plain_text' as const,
            text: buttonLabel(q),
            emoji: true,
          },
          action_id: `follow_up_${i}`,
          value: encodeAction({
            q,
            ns: result.searchedSlugs,
            replace: false,
            ctx: question.slice(0, 200),
            act: result.answer.slice(0, 400),
          }),
        },
      ],
    });
  }

  if (showBasePicker && namespaces.length > 1) {
    const pickBase = pickBaseElement(question, namespaces);
    if (pickBase) {
      blocks.push({
        type: 'actions',
        block_id: `${PICK_BASE_PREFIX}${question}`.slice(0, 255),
        elements: [pickBase],
      });
    }
  }

  if (includeFeedback) {
    blocks.push(
      buildFeedbackActionBlock(question, result.answer, result.topScore, result.searchedBases),
    );
  }

  if (basesText) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${basesText}_` }],
    });
  }

  return blocks;
}

export interface FeedbackPayload {
  q: string;
  s: number;
  b: string[];
  /** Answer snapshot — ephemeral feedback has no public answer blocks to parse. */
  a?: string;
}

export function encodeFeedback(
  question: string,
  topScore: number,
  bases: string[],
  answer?: string,
): string {
  const payload: FeedbackPayload = {
    q: question.slice(0, 300),
    s: Number(topScore.toFixed(3)),
    b: bases,
    ...(answer ? { a: answer.slice(0, 1200) } : {}),
  };
  return JSON.stringify(payload).slice(0, 1990);
}

export function decodeFeedback(value: string): FeedbackPayload | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.q === 'string') {
      return {
        q: parsed.q,
        s: typeof parsed.s === 'number' ? parsed.s : 0,
        b: Array.isArray(parsed.b) ? parsed.b : [],
        a: typeof parsed.a === 'string' ? parsed.a : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function buildFeedbackActionBlock(
  question: string,
  answer: string,
  topScore: number,
  bases: string[],
): KnownBlock {
  const value = encodeFeedback(question, topScore, bases, answer);
  return {
    type: 'actions',
    block_id: 'feedback',
    elements: [
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: '👍 Helpful', emoji: true },
        action_id: 'feedback_up',
        value,
      },
      {
        type: 'button' as const,
        text: {
          type: 'plain_text' as const,
          text: '👎 Not helpful',
          emoji: true,
        },
        action_id: 'feedback_down',
        value,
      },
    ],
  };
}

/** Ephemeral in channels — visible to the asker only, not the whole thread. */
export function buildFeedbackPromptBlocks(
  question: string,
  answer: string,
  topScore: number,
  bases: string[],
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '_Was this helpful?_' },
    },
    buildFeedbackActionBlock(question, answer, topScore, bases),
  ];
}

export function feedbackAckText(rating: 'up' | 'down'): string {
  return rating === 'up'
    ? '✅ Thanks! Glad it helped.'
    : "✅ Thanks for the feedback — we'll use it to improve.";
}

/** Pulls the rendered answer text out of an existing answer message (longest section block). */
export function extractAnswerFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let longest = '';
  for (const b of blocks) {
    const text =
      (b as { type?: string; text?: { text?: string } })?.type === 'section'
        ? ((b as { text?: { text?: string } }).text?.text ?? '')
        : '';
    if (text.length > longest.length) longest = text;
  }
  return longest;
}

/** Legacy public-message feedback row — thank-you replaces buttons. */
export function applyFeedbackAck(
  blocks: unknown,
  rating: 'up' | 'down',
): KnownBlock[] {
  const list = Array.isArray(blocks) ? (blocks as KnownBlock[]) : [];
  return [
    ...list.filter((b) => (b as { block_id?: string }).block_id !== 'feedback'),
    { type: 'context', elements: [{ type: 'mrkdwn', text: feedbackAckText(rating) }] },
  ];
}

export function buildNoResultsBlocks(
  question: string,
  baseSlugs: string[],
  namespaces: Namespace[] = [],
  options: SlackAnswerOptions = {},
): KnownBlock[] {
  const showBasePicker = options.showBasePicker ?? false;
  const preview = question.length > 80 ? `${question.slice(0, 79)}…` : question;
  const basesText = baseSlugs.join(' · ');
  const multiBase = showBasePicker && namespaces.length > 1;

  const bodyText = multiBase
    ? `🤔 *No answer yet* for «${preview}»\n\nNothing relevant found — try rephrasing or search a different base.`
    : `🤔 *No answer yet* for «${preview}»\n\nNothing relevant found in the knowledge base — try rephrasing your question.`;

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: bodyText },
    },
  ];

  const pickBase = showBasePicker
    ? pickBaseElement(question, namespaces)
    : null;
  if (pickBase) {
    blocks.push({
      type: 'actions',
      block_id: `${PICK_BASE_PREFIX}${question}`.slice(0, 255),
      elements: [pickBase],
    });
  }

  if (basesText) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${basesText}_` }],
    });
  }

  return blocks;
}

export function buildConversationalBlocks(opts: {
  intro: string;
  namespaces: Namespace[];
  questions?: string[];
  showBases?: boolean;
}): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: opts.intro } },
  ];

  if (opts.showBases) {
    const nsList = opts.namespaces.map((n) => n.name).join(' · ');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📚 *${nsList}*` }],
    });
  }

  const questions = opts.questions ?? [];
  if (questions.length) {
    blocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Try:*' } },
      ...quickSearchButtonBlocks(questions),
    );
  }

  return blocks;
}

export function buildMoreExamplesBlocks(
  namespaces: Namespace[],
  questions: string[],
  intro?: string,
): KnownBlock[] {
  return buildConversationalBlocks({
    intro: intro ?? 'More ideas — tap a button or type your own question 👇',
    namespaces,
    questions,
  });
}

export function buildChitchatBlocks(
  intro: string,
  namespaces: Namespace[],
): KnownBlock[] {
  return buildConversationalBlocks({
    intro,
    namespaces,
    questions: [],
  });
}

/** Welcome screen. Hardcoded suggestion buttons in DM only. */
export function welcomeBlocks(
  namespaces: Namespace[],
  question?: string,
  forDm = false,
): KnownBlock[] {
  return buildConversationalBlocks({
    intro: welcomeIntro(namespaces, question, forDm),
    namespaces,
    showBases: namespaces.length > 1,
    questions: forDm ? dmWelcomeQuestions() : [],
  });
}

export function buildAnswerFallbackText(
  question: string,
  result: AnswerResult,
  userId: string,
): string {
  const parts = [result.answer];
  const displayed = pickDisplayedSources(
    result.sources,
    result.answer,
    result.citedIndices,
  );
  if (displayed.length) {
    parts.push('', '📎 Sources');
    for (const { source, citeIndex } of displayed) {
      parts.push(
        formatSourceLine(citeIndex - 1, source, userId, { citeIndex }),
      );
    }
  }
  parts.push('', `↳ ${question}`);
  return parts.join('\n');
}

export function parsePickBaseQuestion(blockId?: string): string {
  if (!blockId?.startsWith(PICK_BASE_PREFIX)) return '';
  return blockId.slice(PICK_BASE_PREFIX.length);
}
