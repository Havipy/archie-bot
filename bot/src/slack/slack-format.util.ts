import { BOT_NAME, DM_WELCOME_QUESTIONS } from './slack.constants';
/** Slack plain_text on buttons — hard limit 75 chars. */
export const SLACK_BUTTON_TEXT_MAX = 75;

export function buttonLabel(text: string, max = SLACK_BUTTON_TEXT_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.55 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

export interface ActionPayload {
  q: string;
  /** Namespace slugs to search in directly (skip router). */
  ns?: string[];
  /** Force broadcast over all accessible namespaces. */
  all?: boolean;
  /** Update the clicked message instead of posting a new one. */
  replace?: boolean;
  /** Original question context for follow-ups (helps RAG resolve ambiguous queries). */
  ctx?: string;
  /** Truncated answer text — fallback when in-memory history is gone (e.g. after restart). */
  act?: string;
}

/** Slack action value — max 2000 chars. */
export function encodeAction(payload: ActionPayload): string {
  return JSON.stringify(payload).slice(0, 1990);
}

export function decodeAction(value: string): ActionPayload {
  try {
    const parsed = JSON.parse(value) as ActionPayload;
    if (parsed && typeof parsed.q === 'string') {
      return {
        q: parsed.q,
        ns: Array.isArray(parsed.ns) ? parsed.ns : undefined,
        all: parsed.all === true ? true : undefined,
        replace:
          parsed.replace === true
            ? true
            : parsed.replace === false
              ? false
              : undefined,
        ctx: typeof parsed.ctx === 'string' ? parsed.ctx : undefined,
        act: typeof parsed.act === 'string' ? parsed.act : undefined,
      };
    }
  } catch {
    /* legacy plain-string value */
  }
  return { q: value };
}

export function prefersRussian(text?: string): boolean {
  return text ? /[а-яё]/i.test(text) : false;
}

export function isGreetingOnly(text: string): boolean {
  const q = text
    .trim()
    .replace(/[!?.…]+$/g, '')
    .toLowerCase();
  return (
    /^(привет|здравствуй(те)?|hi|hello|hey|йо|ку|start)[!.?\s]*$/i.test(q) ||
    /^(как дела|как ты|what'?s up|how are you)[!.?\s]*$/i.test(q)
  );
}

export function isHelpRequest(text: string): boolean {
  const q = text.trim().toLowerCase();
  return (
    /^(help|помощь|\/help|\/faq)[!.?\s]*$/.test(q) ||
    /что\s+(ты\s+)?умеешь|what\s+can\s+you\s+do|how\s+(does\s+this\s+work|do i use)/i.test(
      q,
    )
  );
}

/** First-screen intro in DM or empty @mention. */
export function welcomeIntro(
  namespaces: Array<{ name: string }>,
  question?: string,
  forDm = false,
): string {
  const ru = prefersRussian(question);
  const names = namespaces.map((n) => n.name);
  const cta = forDm
    ? '\n\nAsk a question — or tap an example below 👇'
    : ru
      ? '\n\nЗадай вопрос в сообщении.'
      : '\n\nAsk your question in a message.';

  if (ru) {
    if (names.length === 1) {
      return `*${BOT_NAME}* 👋\nИщу ответы в *${names[0]}* и показываю источники.${cta}`;
    }
    return `*${BOT_NAME}* 👋\nИщу по вашим базам знаний и показываю источники.${cta}`;
  }

  if (names.length === 1) {
    return `*${BOT_NAME}* 👋\nI search *${names[0]}* and cite sources.${cta}`;
  }
  return `*${BOT_NAME}* 👋\nI search your knowledge bases and cite sources.${cta}`;
}

export function dmWelcomeQuestions(): string[] {
  return DM_WELCOME_QUESTIONS;
}

/** Warm one-liner for chitchat — not a KB answer. */
export function chitchatReply(question: string): string {
  const q = question
    .trim()
    .replace(/[!?.…]+$/g, '')
    .toLowerCase();
  if (
    /^(как дела|как ты|как сам|what'?s up|how are you|how'?s it going)/.test(q)
  ) {
    return `Hey! 👋 Doing great — ${BOT_NAME} is here and ready to help with knowledge base questions.`;
  }
  if (/^(спасибо|благодарю|thanks|thank you|thx)/.test(q)) {
    return `You're welcome! 😊 Ask anytime — ${BOT_NAME} will find answers in the docs.`;
  }
  if (
    /^(good morning|good afternoon|good evening|доброе утро|добрый день|добрый вечер)/.test(
      q,
    )
  ) {
    return `You too! ☀️ I'm ${BOT_NAME} — ask about leave, benefits, deploys, and anything in the knowledge base.`;
  }
  return `Hey! 👋 I'm ${BOT_NAME} — I find answers in company docs. Ask something specific 👇`;
}

/** Short help blurb — uses real namespace names, matches user language. */
export function helpReply(
  namespaces: Array<{ name: string }>,
  question?: string,
): string {
  const ru = prefersRussian(question);
  const names = namespaces.map((n) => n.name);
  const bases =
    names.length <= 2
      ? names.join(', ')
      : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;

  if (ru) {
    if (names.length === 1) {
      return `Я *${BOT_NAME}* — ищу ответы в *${names[0]}* и показываю источники.\n\nНапиши вопрос в DM или @mention в канале. В треде можно уточнять без @.`;
    }
    return `Я *${BOT_NAME}* — ищу по базам: *${bases}*. Отвечаю с источниками.\n\nDM или @mention в канале; в треде — follow-up без @.`;
  }

  if (names.length === 1) {
    return `I'm *${BOT_NAME}* — I search *${names[0]}* and cite sources.\n\nAsk in DM or @mention me. Follow-ups in the thread need no @.`;
  }
  return `I'm *${BOT_NAME}* — I search *${bases}* and cite sources.\n\nDM or @mention; follow-ups in the thread need no @.`;
}

/** Answer looks like generic bot intro, not KB facts. */
export function isGenericBotReply(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    /помощник по базе знаний|готов ответить|чем я могу|how can i help|knowledge base assistant/i.test(
      lower,
    ) && !extractCitedIndices(answer).length
  );
}

/** LLM prose that means "nothing in KB" — treat as no-data, no follow-up buttons. */
export function looksLikeNoDataAnswer(answer: string): boolean {
  const t = answer.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  return (
    /no (relevant )?information|not (in|found in) (the )?(knowledge base|context|documents)|doesn'?t contain|does not contain|couldn'?t find|can't find|unable to find|nothing (relevant )?found|no answer|cannot answer|can't answer from|not covered in/i.test(
      lower,
    ) && t.length < 500
  );
}

export interface AnswerSegment {
  lead?: string;
  section?: string;
  bullets: string[];
}

const STANDUP_SECTION_RE =
  /^(completed tasks?|action items?|next up|decisions?|blockers?|risks?|attendees?|agenda|notes?)$/i;

function normalizeAnswerText(text: string): string {
  return (
    text
      .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, '')
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/_([^_\n]+?)_/g, '$1')
      .replace(/^---+\s*$/gm, '')
      // LLM sometimes glues bullets onto one line: "done.• Next item"
      .replace(/([.!?;])\s*•\s+/g, '$1\n• ')
      .replace(/([^\n])\s+•\s+/g, '$1\n• ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function isSectionLabel(line: string): boolean {
  const t = line.trim();
  if (/^[•\-*]/.test(t)) return false;

  const bare = t.replace(/:+\s*$/, '').trim();
  if (!bare || bare.length > 64) return false;

  if (STANDUP_SECTION_RE.test(bare)) return true;
  if (/:$/.test(t)) return true;

  return false;
}

function parseSectionHeader(line: string): string | null {
  const t = line.trim();
  const bold = t.match(/^\*([^*]+)\*$/);
  if (bold) return bold[1]!.trim();
  if (isSectionLabel(t)) return t.replace(/:+\s*$/, '').trim();
  return null;
}

function formatSegment(seg: AnswerSegment): string {
  const parts: string[] = [];
  if (seg.lead) parts.push(seg.lead);
  if (seg.section) parts.push(`*${seg.section}*`);
  if (seg.bullets.length)
    parts.push(seg.bullets.map((b) => `• ${b}`).join('\n'));
  return parts.join('\n\n');
}

/** Structured answer for Slack block layout — lead prose, section labels, bullet groups. */
export function structureAnswer(text: string): AnswerSegment[] {
  const t = normalizeAnswerText(text);
  if (!t) return [];

  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const segments: AnswerSegment[] = [];
  let proseBuffer: string[] = [];

  const flushProse = () => {
    if (!proseBuffer.length) return;
    segments.push({ lead: proseBuffer.join('\n\n'), bullets: [] });
    proseBuffer = [];
  };

  for (const line of lines) {
    const sectionHeader = parseSectionHeader(line);
    if (sectionHeader) {
      flushProse();
      segments.push({ section: sectionHeader, bullets: [] });
      continue;
    }

    const bulletMatch = line.match(/^[•\-*]\s+(.*)/);
    if (bulletMatch) {
      const bullet = polishBulletLine(bulletMatch[1]);
      const last = segments[segments.length - 1];
      if (last && (last.section !== undefined || last.bullets.length)) {
        last.bullets.push(bullet);
      } else {
        flushProse();
        segments.push({ bullets: [bullet] });
      }
      continue;
    }

    proseBuffer.push(line);
  }
  flushProse();
  return segments;
}

/** Polish answer text for Slack — strip citations, normalize mrkdwn, structure lead + bullets. */
export function formatAnswerDisplay(text: string): string {
  const segments = structureAnswer(text);
  if (!segments.length) return normalizeAnswerText(text);

  const only = segments.length === 1 ? segments[0]! : null;
  if (only?.bullets.length === 1 && !only.lead && !only.section) {
    return only.bullets[0]!;
  }

  return (
    segments.map(formatSegment).filter(Boolean).join('\n\n') ||
    normalizeAnswerText(text)
  );
}

function polishBulletLine(text: string): string {
  const trimmed = text.trim();
  const alreadyBold = trimmed.match(/^\*([^*]+)\*\s*[—–-]\s*(.+)/);
  if (alreadyBold)
    return `*${alreadyBold[1].trim()}* — ${alreadyBold[2].trim()}`;

  const titled = trimmed.match(/^([A-Z][A-Za-z0-9 /&]+)\s*[—–\-:]\s*(.+)/);
  if (titled && titled[1].length <= 36) {
    return `*${titled[1].trim()}* — ${titled[2].trim()}`;
  }
  return trimmed;
}

/** Visible answer text during streaming — drop the trailing FOLLOW_UPS/NO_DATA scaffolding. */
export function streamVisibleAnswer(raw: string): string {
  const markerIdx = raw.search(/(?:^|\n)(?:---\s*\n)?\*{0,2}FOLLOW_UPS:/i);
  const body = markerIdx >= 0 ? raw.slice(0, markerIdx) : raw;
  return formatAnswerDisplay(body.replace(/^\s*NO_DATA\b.*/i, '').trim());
}

/** 1-based source indices actually cited in the answer, e.g. "[1]", "[2, 3]". */
export function extractCitedIndices(answer: string): number[] {
  const found = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of m[1].split(',')) {
      const i = parseInt(n.trim(), 10);
      if (i > 0) found.add(i);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function parseAnswerWithFollowUps(raw: string): {
  answer: string;
  followUps: string[];
} {
  const marker = /(?:^|\n)(?:---\s*\n)?\*{0,2}FOLLOW_UPS:\*{0,2}\s*\n/i;
  const match = raw.match(marker);

  if (!match || match.index === undefined) {
    return { answer: formatAnswerDisplay(raw), followUps: [] };
  }

  const answer = raw.slice(0, match.index).trim();
  const tail = raw.slice(match.index + match[0].length);
  return {
    answer: formatAnswerDisplay(answer),
    followUps: parseBulletQuestions(tail),
  };
}

/** Parse LLM bullet lines into short questions (follow-ups, welcome suggestions). */
export function parseBulletQuestions(raw: string, max = 3): string[] {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .filter((line) => line.length >= 8 && line.length <= SLACK_BUTTON_TEXT_MAX)
    .slice(0, max);
}
