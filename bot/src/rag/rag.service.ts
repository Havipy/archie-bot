import { Injectable, Logger } from '@nestjs/common';
import { Pinecone, PineconeRecord } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import {
  extractCitedIndices,
  looksLikeNoDataAnswer,
  parseAnswerWithFollowUps,
  parseBulletQuestions,
} from '../slack/slack-format.util';
import { StoredSourceRef } from './conversation.service';
import {
  NamespaceRouterService,
  NamespaceTarget,
  RouteResult,
} from './namespace-router.service';

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? 'gpt-5.4-mini';
const ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL ?? 'gpt-5.4-nano';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ChunkRecord {
  id: string;
  text: string;
  filename: string;
  chunkIndex: number;
}

export interface SearchResult {
  text: string;
  filename: string;
  score: number;
  docId?: string;
  namespaceSlug?: string;
  chunkIndex?: number;
}

export type RouteMode =
  | 'routed'
  | 'broadcast'
  | 'broadcast_fallback'
  | 'pinned';

export interface AnswerResult {
  answer: string;
  sources: SearchResult[];
  topScore: number;
  followUps: string[];
  searchedBases: string[];
  searchedSlugs: string[];
  routeMode: RouteMode;
  availableBases: string[];
  citedIndices?: number[];
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly pinecone: Pinecone;
  private readonly openai: OpenAI;
  private readonly indexName = 'faq-knowledge';
  private readonly minScore = 0.2;

  constructor(private readonly router: NamespaceRouterService) {
    this.pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    this.logger.log(`LLM: ${CHAT_MODEL}`);
  }

  /** Terms worth exact-match boosting — from raw question + expanded search query. */
  private extractKeywordTerms(...sources: string[]): string[] {
    const terms = new Set<string>();

    for (const source of sources) {
      if (!source?.trim()) continue;

      // Proper nouns / acronyms before lowercasing: Zod, AWS, HR
      for (const m of source.match(
        /\b[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)*\b|\b[A-Z]{2,}\b/g,
      ) ?? []) {
        const t = m.toLowerCase();
        if (t.length >= 2) terms.add(t);
      }

      // kebab-case / snake_case: text-embedding-3-small
      for (const m of source.match(/[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)+/g) ??
        []) {
        terms.add(m.toLowerCase());
      }

      const normalized = source.toLowerCase().replace(/[^\w\s-]/g, ' ');
      for (const raw of normalized.split(/\s+/)) {
        const t = raw.replace(/^-+|-+$/g, '');
        if (!t) continue;
        const minLen = /\d/.test(t) ? 2 : 3;
        if (t.length >= minLen) terms.add(t);
      }
    }

    return [...terms];
  }

  private termInHaystack(haystack: string, term: string): boolean {
    if (/[-_]/.test(term)) return haystack.includes(term);
    return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(haystack);
  }

  private normalizeKeywords(keywords?: string[]): string[] {
    if (!keywords?.length) return [];
    return [
      ...new Set(
        keywords
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length >= 2),
      ),
    ].slice(0, 8);
  }

  private applyKeywordBoost(
    hits: SearchResult[],
    keywords?: string[],
    ...fallbackSources: string[]
  ): SearchResult[] {
    const terms = this.normalizeKeywords(keywords);
    const finalTerms = terms.length
      ? terms
      : this.extractKeywordTerms(...fallbackSources.filter(Boolean));
    if (!finalTerms.length) return hits;

    if (terms.length) {
      this.logger.debug(`Keyword boost: [${finalTerms.join(', ')}]`);
    }

    return hits
      .map((h) => {
        const haystack = `${h.text}\n${h.filename}`.toLowerCase();
        let boost = 0;
        for (const term of finalTerms) {
          if (this.termInHaystack(haystack, term)) boost += 0.08;
        }
        return boost ? { ...h, score: h.score + Math.min(boost, 0.2) } : h;
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Short / anaphoric follow-up in an ongoing Q&A (same doc/thread). */
  isFollowUpQuestion(
    question: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): boolean {
    if (!history?.length) return false;
    const q = question.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 10) return false;

    if (words.length <= 6) return true;

    return (
      /^(what|which|who|when|where|how|why|tell me|any|were there|was there)\b/.test(
        q,
      ) ||
      /\b(more|else|that|those|them|it|this|decisions?|action items?|completed|next up|standup|meeting)\b/.test(
        q,
      )
    );
  }

  private priorTopicFromHistory(
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string {
    if (!history?.length) return '';
    const lastUser = [...history]
      .reverse()
      .find((m) => m.role === 'user')
      ?.content?.trim();
    return lastUser?.slice(0, 160) ?? '';
  }

  /** Expand vague/short questions for embedding search. Uses preExpanded from intent router when available. */
  async resolveSearchQuery(
    question: string,
    preExpanded?: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const trimmed = question.trim();
    const followUp = this.isFollowUpQuestion(trimmed, history);
    const topic = followUp ? this.priorTopicFromHistory(history) : '';

    if (preExpanded?.trim()) {
      let expanded = preExpanded.trim();
      if (
        followUp &&
        topic &&
        !expanded.toLowerCase().includes(topic.slice(0, 40).toLowerCase())
      ) {
        expanded = `${expanded} ${topic}`.trim().slice(0, 220);
      }
      if (expanded !== trimmed) {
        this.logger.debug(
          `Query expand (intent): "${trimmed}" → "${expanded}"`,
        );
      }
      return expanded;
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    const vagueFollowUp = words.length <= 6 && history?.length;

    if (words.length > 4 && !vagueFollowUp) return trimmed;

    try {
      const context = history?.length
        ? history
            .slice(-4)
            .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
            .join('\n')
        : '';

      const res = await this.openai.chat.completions.create({
        model: ROUTER_MODEL,
        max_completion_tokens: 80,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Rewrite the user message into one clear knowledge-base search query. ' +
              'If the user asks vaguely for more ("what else", "что еще") use the conversation context to pick the topic. ' +
              'Expand tech terms. One line, no quotes.',
          },
          ...(context
            ? [{ role: 'user' as const, content: `Context:\n${context}` }]
            : []),
          { role: 'user', content: trimmed },
        ],
      });
      const expanded = res.choices[0]?.message?.content
        ?.trim()
        .replace(/^["']|["']$/g, '');
      if (
        expanded &&
        expanded.length >= 3 &&
        expanded.length < 200 &&
        expanded !== trimmed
      ) {
        this.logger.debug(
          `Query expand (fallback): "${trimmed}" → "${expanded}"`,
        );
        return expanded;
      }
    } catch (err) {
      this.logger.warn('Query expand failed', err);
    }
    return trimmed;
  }

  async embedText(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  }

  async upsertChunks(chunks: ChunkRecord[], namespace: string): Promise<void> {
    const ns = this.pinecone.index(this.indexName).namespace(namespace);

    const records: PineconeRecord[] = await Promise.all(
      chunks.map(async (chunk) => ({
        id: chunk.id,
        values: await this.embedText(chunk.text),
        metadata: {
          text: chunk.text,
          filename: chunk.filename,
          namespace,
          chunkIndex: chunk.chunkIndex,
          docId: chunk.id.replace(/-chunk-\d+$/, ''),
        },
      })),
    );

    await ns.upsert({ records });
    this.logger.log(
      `Upserted ${records.length} chunks → namespace "${namespace}"`,
    );
  }

  async deleteNamespaceVectors(namespace: string): Promise<void> {
    await this.pinecone.index(this.indexName).deleteAll({ namespace });
  }

  async deleteDocumentChunks(
    docId: string,
    namespace: string,
    knownCount = 0,
  ): Promise<void> {
    const ns = this.pinecone.index(this.indexName).namespace(namespace);

    try {
      await ns.deleteMany({ filter: { docId: { $eq: docId } } });
      return;
    } catch (err) {
      this.logger.debug(
        `Filter delete failed for ${docId}, trying ID list`,
        err,
      );
    }

    if (knownCount <= 0) return;

    const ids = Array.from(
      { length: knownCount + 5 },
      (_, i) => `${docId}-chunk-${i}`,
    );
    try {
      await ns.deleteMany({ ids });
    } catch (err) {
      this.logger.warn(`Could not delete old chunks for ${docId}`, err);
    }
  }

  async searchSimilarByVector(
    vector: number[],
    namespace: string,
    topK = 5,
  ): Promise<SearchResult[]> {
    const ns = this.pinecone.index(this.indexName).namespace(namespace);
    const result = await ns.query({ vector, topK, includeMetadata: true });

    return result.matches.map((m) => ({
      text: (m.metadata?.text as string) ?? '',
      filename: (m.metadata?.filename as string) ?? '',
      score: m.score ?? 0,
      docId: (m.metadata?.docId as string) ?? m.id.replace(/-chunk-\d+$/, ''),
      namespaceSlug: (m.metadata?.namespace as string) ?? namespace,
      chunkIndex: m.metadata?.chunkIndex as number | undefined,
    }));
  }

  private async fetchAllDocumentChunks(
    docId: string,
    namespaceSlug: string,
  ): Promise<SearchResult[]> {
    const ns = this.pinecone.index(this.indexName).namespace(namespaceSlug);
    const ids = Array.from({ length: 64 }, (_, i) => `${docId}-chunk-${i}`);
    const fetched = await ns.fetch({ ids });
    const chunks: SearchResult[] = [];

    for (const id of ids) {
      const rec = fetched.records?.[id];
      if (!rec) continue;
      chunks.push({
        text: (rec.metadata?.text as string) ?? '',
        filename: (rec.metadata?.filename as string) ?? '',
        score: 0,
        docId,
        namespaceSlug,
        chunkIndex:
          (rec.metadata?.chunkIndex as number) ??
          Number(id.split('-chunk-')[1]),
      });
    }

    return chunks.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  }

  private mergeChunksInOrder(chunks: SearchResult[]): SearchResult {
    const sorted = [...chunks].sort(
      (a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0),
    );
    const first = sorted[0];
    return {
      ...first,
      text: sorted
        .map((c) => c.text.trim())
        .filter(Boolean)
        .join('\n\n'),
      score: Math.max(...sorted.map((c) => c.score)),
    };
  }

  private async expandTopDocuments(
    hits: SearchResult[],
  ): Promise<SearchResult[]> {
    if (!hits.length) return hits;

    const topDocs: Array<{
      docId: string;
      namespaceSlug: string;
      score: number;
    }> = [];
    for (const hit of hits) {
      if (!hit.docId || !hit.namespaceSlug) continue;
      if (topDocs.some((d) => d.docId === hit.docId)) continue;
      topDocs.push({
        docId: hit.docId,
        namespaceSlug: hit.namespaceSlug,
        score: hit.score,
      });
      if (topDocs.length >= 2) break;
    }

    const fullByDoc = new Map<string, SearchResult>();
    for (const { docId, namespaceSlug, score } of topDocs) {
      const chunks = await this.fetchAllDocumentChunks(docId, namespaceSlug);
      if (!chunks.length) continue;
      const merged = this.mergeChunksInOrder(chunks);
      merged.score = Math.max(score, merged.score);
      fullByDoc.set(docId, merged);
    }

    const out: SearchResult[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (hit.docId && fullByDoc.has(hit.docId)) {
        if (!seen.has(hit.docId)) {
          out.push(fullByDoc.get(hit.docId)!);
          seen.add(hit.docId);
        }
        continue;
      }
      if (hit.docId && seen.has(hit.docId)) continue;
      out.push(hit);
      if (hit.docId) seen.add(hit.docId);
    }

    return out;
  }

  async searchSimilar(
    query: string,
    namespace: string,
    topK = 5,
  ): Promise<SearchResult[]> {
    const vector = await this.embedText(query);
    return this.searchSimilarByVector(vector, namespace, topK);
  }

  private sourceMergeKey(source: SearchResult): string {
    const raw = source.filename.replace(/^\[[^\]]+\]\s*/, '');
    if (raw.startsWith('url:')) {
      const payload = raw.slice(4);
      const sep = payload.indexOf('::');
      return sep >= 0 ? payload.slice(0, sep) : payload;
    }
    return source.docId ?? source.filename;
  }

  private mergeChunksByDocument(sources: SearchResult[]): SearchResult[] {
    const map = new Map<string, SearchResult>();

    for (const source of sources) {
      const key = this.sourceMergeKey(source);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...source, text: source.text.trim() });
        continue;
      }

      const marker = source.text.trim().slice(0, 80);
      if (marker && !existing.text.includes(marker)) {
        existing.text = `${existing.text}\n\n${source.text.trim()}`;
      }
      existing.score = Math.max(existing.score, source.score);
    }

    return [...map.values()].sort((a, b) => b.score - a.score);
  }

  private buildAnswerPrompt(contexts: SearchResult[]): string {
    const contextText = contexts.length
      ? contexts
          .map((c, i) => `[${i + 1}] (${c.filename})\n${c.text}`)
          .join('\n\n---\n\n')
      : null;

    return [
      'You are Archie — answer ONLY from the knowledge base context below.',
      'Output language: English.',
      '',
      'Style — write like a helpful coworker in Slack DM:',
      '- Casual and conversational. Contractions OK. Short sentences.',
      "- Simple factual question → *2–3 sentences*: main answer + one or two useful related details from context (deadlines, limits, how-to). Don't stop at one line.",
      "- If the source has named sections, mirror that structure — header then bullets per section. Don't merge unrelated sections into one list.",
      '- Bold key numbers: *28 days*, *14 days*.',
      '- Light openers OK: "Yeah,", "So," — or skip.',
      '- No self-intro, no "Great question!", no repeating the question.',
      '',
      'Rules:',
      '- Do NOT include [N] citations — sources show below as links.',
      '- Combine facts from all context fragments before answering.',
      '- Answer only what the question literally asks. If the user asks about one section (e.g. "decisions"), return only that section — not completed tasks or action items.',
      '- Multiple distinct topics → "• " bullets (*Term* — explanation). Otherwise keep it prose.',
      '- Slack mrkdwn: *bold* only. No # headers, no ---.',
      '- If context does not contain the answer → first line exactly: NO_DATA. Nothing else — no explanation, no FOLLOW_UPS.',
      "- If partial answer → say what you know, don't invent the rest.",
      '',
      'After a real answer (never after NO_DATA), optionally add:',
      'FOLLOW_UPS:',
      '• question (max 50 chars)',
      '• question (max 50 chars)',
      'Only follow-ups answerable from the same context. Omit FOLLOW_UPS if none or if answer was partial/missing.',
      '',
      'Forbidden: "usually", "I recommend", "as a rule", "contact HR", advice not in context.',
      contextText ? `\nKnowledge base context:\n${contextText}` : '',
    ].join('\n');
  }

  async generateAnswer(
    question: string,
    contexts: SearchResult[],
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 900,
      temperature: 0.4,
      messages: [
        { role: 'system', content: this.buildAnswerPrompt(contexts) },
        ...history,
        { role: 'user', content: question },
      ],
    });

    return (
      response.choices[0]?.message?.content?.trim() ||
      'Failed to generate an answer.'
    );
  }

  /** Streams the raw answer; calls onDelta with accumulated text. Returns full raw text. */
  async generateAnswerStream(
    question: string,
    contexts: SearchResult[],
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    onDelta: (full: string) => Promise<void> | void,
  ): Promise<string> {
    const stream = await this.openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 900,
      temperature: 0.4,
      stream: true,
      messages: [
        { role: 'system', content: this.buildAnswerPrompt(contexts) },
        ...history,
        { role: 'user', content: question },
      ],
    });

    let full = '';
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content ?? '';
      if (!delta) continue;
      full += delta;
      await onDelta(full);
    }

    return full.trim() || 'Failed to generate an answer.';
  }

  /** Splits a raw LLM answer into NO_DATA flag + parsed answer/followUps. */
  parseRawAnswer(raw: string): {
    answer: string;
    followUps: string[];
    noData: boolean;
    citedIndices: number[];
  } {
    if (/^\s*NO_DATA\b/i.test(raw)) {
      return { answer: '', followUps: [], noData: true, citedIndices: [] };
    }
    const citedIndices = extractCitedIndices(raw);
    const parsed = parseAnswerWithFollowUps(raw);
    if (looksLikeNoDataAnswer(parsed.answer)) {
      return { answer: '', followUps: [], noData: true, citedIndices: [] };
    }
    return { ...parsed, noData: false, citedIndices };
  }

  async routeQuestion(
    question: string,
    namespaces: NamespaceTarget[],
  ): Promise<RouteResult> {
    return this.router.route(question, namespaces);
  }

  private async loadPreferredDocuments(
    refs: StoredSourceRef[],
  ): Promise<SearchResult[]> {
    const out: SearchResult[] = [];
    for (const ref of refs.slice(0, 2)) {
      const chunks = await this.fetchAllDocumentChunks(
        ref.docId,
        ref.namespaceSlug,
      );
      if (!chunks.length) continue;
      const merged = this.mergeChunksInOrder(chunks);
      merged.filename = ref.filename || merged.filename;
      merged.score = Math.max(merged.score, 0.95);
      out.push(merged);
    }
    return out;
  }

  /** Keep prior answer docs in context for short follow-ups ("what decisions?", etc.). */
  async searchWithPriorDocs(
    question: string,
    namespaces: NamespaceTarget[],
    priorSources: StoredSourceRef[],
    queryVector?: number[],
    keywords?: string[],
    ...fallbackKeywordSources: string[]
  ): Promise<{
    sources: SearchResult[];
    topScore: number;
    searchedBases: string[];
    searchedSlugs: string[];
  }> {
    const base = await this.searchInNamespaces(
      question,
      namespaces,
      queryVector,
      keywords,
      ...fallbackKeywordSources,
    );

    if (!priorSources.length) return base;

    const preferred = await this.loadPreferredDocuments(priorSources);
    if (!preferred.length) return base;

    const seen = new Set<string>();
    const combined: SearchResult[] = [];

    for (const hit of [...preferred, ...base.sources]) {
      const key = this.sourceMergeKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(hit);
    }

    const expanded = await this.expandTopDocuments(combined.slice(0, 12));
    const merged = this.applyKeywordBoost(
      this.mergeChunksByDocument(expanded),
      keywords,
      ...fallbackKeywordSources.filter(Boolean),
    ).filter(
      (r) =>
        r.score >= this.minScore || preferred.some((p) => p.docId === r.docId),
    );

    this.logger.debug(
      `Follow-up: pinned ${priorSources.map((s) => s.filename).join(', ')} → ${merged.length} sources`,
    );

    return {
      sources: merged.length ? merged : base.sources,
      topScore: merged[0]?.score ?? base.topScore,
      searchedBases: base.searchedBases,
      searchedSlugs: base.searchedSlugs,
    };
  }

  async searchInNamespaces(
    question: string,
    namespaces: NamespaceTarget[],
    queryVector?: number[],
    keywords?: string[],
    ...fallbackKeywordSources: string[]
  ): Promise<{
    sources: SearchResult[];
    topScore: number;
    searchedBases: string[];
    searchedSlugs: string[];
  }> {
    if (!namespaces.length) {
      return { sources: [], topScore: 0, searchedBases: [], searchedSlugs: [] };
    }

    const vector = queryVector ?? (await this.embedText(question));

    const allResults = await Promise.all(
      namespaces.map(async ({ namespace, name }) => {
        const results = await this.searchSimilarByVector(vector, namespace, 8);
        return results.map((r) => ({
          ...r,
          filename: `[${name}] ${r.filename}`,
          namespaceSlug: r.namespaceSlug ?? namespace,
        }));
      }),
    );

    const hits = this.applyKeywordBoost(
      allResults
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, 12),
      keywords,
      ...(fallbackKeywordSources.length ? fallbackKeywordSources : [question]),
    ).filter((r) => r.score >= this.minScore);

    const expanded = await this.expandTopDocuments(hits);
    const merged = this.mergeChunksByDocument(expanded);

    return {
      sources: merged,
      topScore: merged[0]?.score ?? 0,
      searchedBases: namespaces.map((n) => n.name),
      searchedSlugs: namespaces.map((n) => n.namespace),
    };
  }

  async searchAcrossNamespaces(
    question: string,
    namespaces: NamespaceTarget[],
    searchQuery?: string,
    keywords?: string[],
  ): Promise<{
    sources: SearchResult[];
    topScore: number;
    searchedBases: string[];
    searchedSlugs: string[];
    routeMode: AnswerResult['routeMode'];
    availableBases: string[];
  }> {
    const t0 = Date.now();
    const availableBases = namespaces.map((n) => n.name);
    const query = searchQuery?.trim() || question;
    const vector = await this.embedText(query);

    const route = await this.router.route(query, namespaces, vector);
    this.logger.debug(`embed+route ${Date.now() - t0}ms → ${route.mode}`);

    let result = await this.searchInNamespaces(
      query,
      route.targets,
      vector,
      keywords,
      question,
      query,
    );
    let routeMode: AnswerResult['routeMode'] = route.mode;
    this.logger.debug(`search ${Date.now() - t0}ms`);

    if (
      !result.sources.length &&
      route.mode === 'routed' &&
      namespaces.length > route.targets.length
    ) {
      this.logger.log('Router fallback → searching all accessible namespaces');
      result = await this.searchInNamespaces(
        query,
        namespaces,
        vector,
        keywords,
        question,
        query,
      );
      routeMode = 'broadcast_fallback';
    }

    return { ...result, routeMode, availableBases };
  }

  async answerFromSources(
    question: string,
    sources: SearchResult[],
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<{ answer: string; followUps: string[]; noData: boolean }> {
    const raw = await this.generateAnswer(question, sources, history);
    return this.parseRawAnswer(raw);
  }

  async answerQuestion(
    question: string,
    namespace: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<AnswerResult> {
    const results = await this.searchSimilar(question, namespace);
    const sources = results.filter((r) => r.score >= this.minScore);
    if (!sources.length) {
      return {
        answer: this.noDataAnswer(),
        sources: [],
        topScore: 0,
        followUps: [],
        searchedBases: [],
        searchedSlugs: [],
        routeMode: 'broadcast',
        availableBases: [],
      };
    }
    const { answer, followUps } = await this.answerFromSources(
      question,
      sources,
      history,
    );
    return {
      answer,
      sources,
      topScore: sources[0]?.score ?? 0,
      followUps,
      searchedBases: [namespace],
      searchedSlugs: [namespace],
      routeMode: 'broadcast',
      availableBases: [namespace],
    };
  }

  async answerAcrossNamespaces(
    question: string,
    namespaces: Array<{ namespace: string; name: string }>,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<AnswerResult> {
    const {
      sources,
      topScore,
      searchedBases,
      searchedSlugs,
      routeMode,
      availableBases,
    } = await this.searchAcrossNamespaces(question, namespaces);

    if (!sources.length) {
      return {
        answer: this.noDataAnswer(),
        sources: [],
        topScore: 0,
        followUps: [],
        searchedBases,
        searchedSlugs,
        routeMode,
        availableBases,
      };
    }

    const { answer, followUps } = await this.answerFromSources(
      question,
      sources,
      history,
    );
    return {
      answer,
      sources,
      topScore,
      followUps,
      searchedBases,
      searchedSlugs,
      routeMode,
      availableBases,
    };
  }

  private noDataAnswer(): string {
    return 'No information in the knowledge base for this question yet — try rephrasing or ask something else.';
  }

  /** LLM-generated sample questions from KB snippets — welcome screen, "more examples". */
  async generateSampleQuestions(
    namespaces: NamespaceTarget[],
    opts?: { seed?: string; count?: number; avoid?: string[] },
  ): Promise<string[]> {
    const count = opts?.count ?? 3;
    if (!namespaces.length) return [];

    const seed =
      opts?.seed ??
      'company policies onboarding benefits compensation leave deployment procedures';
    const { sources } = await this.searchInNamespaces(seed, namespaces);
    if (!sources.length) return [];

    const contextText = sources
      .slice(0, 6)
      .map((c, i) => `[${i + 1}] (${c.filename})\n${c.text.slice(0, 450)}`)
      .join('\n\n---\n\n');

    const avoidLine = opts?.avoid?.length
      ? `\nDo not repeat or rephrase: ${opts.avoid.join('; ')}`
      : '';

    try {
      const response = await this.openai.chat.completions.create({
        model: ROUTER_MODEL,
        max_completion_tokens: 180,
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content: [
              'Suggest short questions a coworker could ask about the knowledge base snippets below.',
              `Output exactly ${count} lines, each starting with "• ".`,
              'English, max 70 chars each, specific, answerable from snippets only.',
              'Pick different topics when possible. No intro, no numbering.',
              avoidLine,
              `\nSnippets:\n${contextText}`,
            ].join('\n'),
          },
          { role: 'user', content: 'Suggest questions.' },
        ],
      });

      return parseBulletQuestions(
        response.choices[0]?.message?.content?.trim() ?? '',
        count,
      );
    } catch (err) {
      this.logger.warn('generateSampleQuestions failed', err);
      return [];
    }
  }
}
