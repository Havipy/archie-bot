/**
 * RAG relevance eval — retrieval + optional answer generation.
 *
 * Usage:
 *   npm run rag:eval                    # retrieval only (fast)
 *   npm run rag:eval -- --full            # + LLM + NO_DATA
 *   npm run rag:eval -- --id=ru-leave
 *   npm run rag:eval -- --hard            # medium+ only
 *   npm run rag:eval -- --verbose         # show top-3 chunks
 */
import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { NestFactory } from '@nestjs/core';
import { RagModule } from '../src/rag/rag.module';
import { RagService, SearchResult } from '../src/rag/rag.service';
import { RouteMode } from '../src/rag/rag.service';
import { extractCitedIndices } from '../src/slack/slack-format.util';

type Difficulty = 'easy' | 'medium' | 'hard' | 'adversarial';

interface EvalCase {
  id: string;
  question: string;
  difficulty: Difficulty;
  expectNamespaces: string[];
  expectKeywords: string[];
  forbiddenKeywords?: string[];
  expectRoute?: RouteMode;
  /** Top-1 source must NOT come from these namespace slugs. */
  excludeFromTop?: string[];
  minTopScore?: number;
  maxTopScore?: number;
  expectNoData?: boolean;
  /** Run retrieval checks even when expectNoData; NO_DATA asserted only with --full. */
  noDataWithRetrieval?: boolean;
  notes?: string;
}

const CASES: EvalCase[] = [
  // ── easy: direct, same language ──────────────────────────────────────────
  {
    id: 'ru-leave',
    difficulty: 'easy',
    question: 'How do I request time off?',
    expectNamespaces: ['general'],
    expectKeywords: ['leave', 'annual', '28'],
    expectRoute: 'routed',
    minTopScore: 0.28,
  },
  {
    id: 'en-leave',
    difficulty: 'easy',
    question: 'How many days of annual leave do employees get?',
    expectNamespaces: ['general'],
    expectKeywords: ['28', 'annual leave'],
    minTopScore: 0.35,
  },
  {
    id: 'benefits',
    difficulty: 'easy',
    question: 'What employee benefits are available?',
    expectNamespaces: ['general'],
    expectKeywords: ['health', 'insurance'],
    minTopScore: 0.28,
  },
  {
    id: 'deploy',
    difficulty: 'easy',
    question: 'How to deploy project alpha?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['helm', 'deploy', 'staging'],
    expectRoute: 'routed',
    minTopScore: 0.35,
  },

  // ── medium: cross-lingual, specific facts ────────────────────────────────
  {
    id: 'deploy-ru',
    difficulty: 'medium',
    question: 'How to deploy alpha to staging?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['helm', 'staging', 'alpha'],
    minTopScore: 0.28,
  },
  {
    id: 'remote-ru',
    difficulty: 'medium',
    question: 'Can I work remotely from home?',
    expectNamespaces: ['general'],
    expectKeywords: ['remote', '3 days', 'week'],
    minTopScore: 0.28,
  },
  {
    id: 'sick-leave',
    difficulty: 'medium',
    question: 'How long is sick leave covered and do I need a certificate?',
    expectNamespaces: ['general'],
    expectKeywords: ['sick', '30', 'medical', 'certificate'],
    minTopScore: 0.30,
  },
  {
    id: 'gym-budget',
    difficulty: 'medium',
    question: 'How much does the company reimburse for gym?',
    expectNamespaces: ['general'],
    expectKeywords: ['600', 'gym', 'wellness'],
    minTopScore: 0.28,
  },
  {
    id: 'prod-url',
    difficulty: 'medium',
    question: 'What is the production URL for Project Alpha?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['alpha.company.com', 'production', 'prod'],
    minTopScore: 0.30,
  },
  {
    id: 'smoke-test',
    difficulty: 'medium',
    question: 'How to run smoke tests after deploy?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['smoke', 'kubectl', 'alpha-staging'],
    minTopScore: 0.28,
  },
  {
    id: 'rollback-prod',
    difficulty: 'medium',
    question: 'How to rollback project alpha in production?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['rollback', 'helm', 'alpha-prod'],
    minTopScore: 0.28,
    notes: 'Rollback section exists in deploy-guide.md',
  },
  {
    id: 'learning-budget',
    difficulty: 'medium',
    question: 'Learning budget for courses and conferences?',
    expectNamespaces: ['general'],
    expectKeywords: ['1,500', 'learning', 'budget'],
    minTopScore: 0.30,
  },

  // ── hard: vague, compound, routing stress ────────────────────────────────
  {
    id: 'informal-leave-clear',
    difficulty: 'hard',
    question: 'How many vacation days do employees get?',
    expectNamespaces: ['general'],
    expectKeywords: ['28', 'leave', 'annual'],
    minTopScore: 0.28,
  },
  {
    id: 'vague-deploy',
    difficulty: 'hard',
    question: 'How do I deploy?',
    expectNamespaces: ['project-alpha', 'general'],
    expectKeywords: ['deploy', 'helm', 'docker'],
    notes: 'Ambiguous — may route alpha or broadcast',
  },
  {
    id: 'parental-leave-negative',
    difficulty: 'adversarial',
    question: 'How many weeks of paternity leave for new fathers?',
    expectNamespaces: [],
    expectKeywords: [],
    expectNoData: true,
    notes: 'Not in KB — must NO_DATA',
  },
  {
    id: 'prereq-soup',
    difficulty: 'hard',
    question: 'kubectl helm docker registry prerequisites',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['kubectl', 'helm', 'docker', 'registry'],
    minTopScore: 0.28,
  },
  {
    id: 'monitoring',
    difficulty: 'hard',
    question: 'Where are Grafana dashboards and PagerDuty alerts for alpha?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['grafana', 'pagerduty', 'monitoring'],
    minTopScore: 0.28,
  },
  {
    id: 'onboarding-hr',
    difficulty: 'hard',
    question: 'What happens during employee onboarding?',
    expectNamespaces: ['general'],
    expectKeywords: ['onboarding', '2-week', 'week'],
    excludeFromTop: ['project-alpha'],
    minTopScore: 0.28,
  },
  {
    id: 'esop-vesting',
    difficulty: 'hard',
    question: 'Stock options vesting schedule and cliff period?',
    expectNamespaces: ['general'],
    expectKeywords: ['stock', 'vesting', 'cliff', '4 years'],
    minTopScore: 0.28,
  },
  {
    id: 'cross-topic-trap',
    difficulty: 'hard',
    question: 'Can I take study leave while on a deployment rotation?',
    expectNamespaces: ['general'],
    expectKeywords: ['study leave', 'leave'],
    expectNoData: true,
    noDataWithRetrieval: true,
    minTopScore: 0.28,
    notes: 'Compound HR+deploy — retrieval may hit HR; LLM must NO_DATA (no combined policy)',
  },

  // ── adversarial: should NOT answer / wrong namespace trap ────────────────
  {
    id: 'hr-contact-negative',
    difficulty: 'adversarial',
    question: 'How do I contact HR?',
    expectNamespaces: ['general'],
    expectKeywords: [],
    expectNoData: true,
    noDataWithRetrieval: true,
    notes: 'HR doc has no contact info — must NO_DATA, not cite code of conduct',
  },
  {
    id: 'salary-negative',
    difficulty: 'adversarial',
    question: 'What is the salary for senior engineers?',
    expectNamespaces: [],
    expectKeywords: [],
    expectNoData: true,
  },
  {
    id: 'offtopic-negative',
    difficulty: 'adversarial',
    question: 'How to configure Terraform for GCP?',
    expectNamespaces: [],
    expectKeywords: [],
    expectNoData: true,
  },
  {
    id: 'wrong-ns-trap',
    difficulty: 'adversarial',
    question: 'What is the meal allowance amount?',
    expectNamespaces: ['general'],
    expectKeywords: ['100', 'meal'],
    excludeFromTop: ['project-alpha'],
    forbiddenKeywords: ['helm', 'kubernetes', 'docker push'],
    minTopScore: 0.28,
    notes: 'Benefits question must not surface deploy chunks',
  },
  {
    id: 'platform-slack',
    difficulty: 'adversarial',
    question: 'Who do I contact for deployment issues in Slack?',
    expectNamespaces: ['project-alpha'],
    expectKeywords: ['platform', 'slack', '#platform-eng'],
    minTopScore: 0.28,
    notes: 'Contact section at end of deploy-guide — easy to miss in chunking',
  },
];

const NAMESPACES = [
  { namespace: 'general', name: 'General' },
  { namespace: 'project-alpha', name: 'Project Alpha' },
];

const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'medium', 'hard', 'adversarial'];

function hasKeyword(text: string, keywords: string[]): boolean {
  if (!keywords.length) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function nsInSources(sources: { filename: string }[], slugs: string[]): boolean {
  if (!slugs.length) return true;
  const hay = sources.map((s) => s.filename.toLowerCase()).join(' ');
  return slugs.some(
    (slug) => hay.includes(slug) || hay.includes(slug.replace('-', ' ')),
  );
}

function nsOfTop(source: SearchResult | undefined): string {
  if (!source) return '';
  const m = source.filename.match(/^\[([^\]]+)\]/);
  return m?.[1]?.toLowerCase().replace(/\s+/g, '-') ?? '';
}

function fmtScore(score: number): string {
  return score.toFixed(3);
}

function passIcon(ok: boolean): string {
  return ok ? '✅' : '❌';
}

function stripNs(filename: string): string {
  return filename.replace(/^\[[^\]]+\]\s*/, '');
}

interface CaseResult {
  case: EvalCase;
  ok: boolean;
  skipped: boolean;
  top?: SearchResult;
  sources: SearchResult[];
  topScore: number;
  routeMode: RouteMode;
  searchedBases: string[];
  noData?: boolean;
  citedCount?: number;
  failures: string[];
}

function evaluate(c: EvalCase, r: CaseResult, full: boolean): boolean {
  const failures: string[] = [];
  const { sources, top, topScore, routeMode } = r;
  const hasSources = sources.length > 0;
  const checkNoData = !!c.expectNoData;
  const checkRetrieval = !checkNoData || !!c.noDataWithRetrieval;

  if (checkNoData && !checkRetrieval && !full) {
    r.skipped = true;
    return true;
  }

  if (checkRetrieval) {
    if (!hasSources) failures.push('no sources above minScore');
    if (c.expectNamespaces.length && !nsInSources(sources.slice(0, 3), c.expectNamespaces)) {
      failures.push(`namespace miss (want: ${c.expectNamespaces.join(', ')})`);
    }
    if (top && c.expectKeywords.length && !hasKeyword(top.text, c.expectKeywords)) {
      failures.push(`keywords miss (want: ${c.expectKeywords.join(', ')})`);
    }
    if (top && c.forbiddenKeywords?.some((k) => top.text.toLowerCase().includes(k.toLowerCase()))) {
      failures.push(`forbidden keyword in top chunk: ${c.forbiddenKeywords.join(', ')}`);
    }
    if (c.excludeFromTop?.length && top) {
      const topNs = nsOfTop(top);
      if (c.excludeFromTop.some((s) => topNs.includes(s.replace('-', ' ')) || top.filename.toLowerCase().includes(s))) {
        failures.push(`wrong namespace on top (exclude: ${c.excludeFromTop.join(', ')})`);
      }
    }
    if (topScore < (c.minTopScore ?? 0.28)) {
      failures.push(`topScore ${fmtScore(topScore)} < ${c.minTopScore ?? 0.28}`);
    }
    if (c.maxTopScore !== undefined && topScore > c.maxTopScore) {
      failures.push(`topScore ${fmtScore(topScore)} > ${c.maxTopScore} (too confident for weak match)`);
    }
    if (c.expectRoute && routeMode !== c.expectRoute) {
      failures.push(`route=${routeMode}, want ${c.expectRoute}`);
    }
    if (full && hasSources && !checkNoData && r.noData) {
      failures.push('unexpected NO_DATA');
    }
  }

  if (checkNoData && full) {
    if (hasSources && !r.noData) failures.push('expected NO_DATA, got answer');
  } else if (checkNoData && !full && !c.noDataWithRetrieval) {
    r.skipped = true;
  }

  r.failures = failures;
  return failures.length === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const verbose = args.includes('--verbose');
  const hardOnly = args.includes('--hard');
  const idFilter = args.find((a) => a.startsWith('--id='))?.slice(5);

  let cases = CASES;
  if (idFilter) cases = cases.filter((c) => c.id === idFilter);
  if (hardOnly) cases = cases.filter((c) => c.difficulty !== 'easy');

  if (!cases.length) {
    console.error('No cases matched filter');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(RagModule, { logger: ['error', 'warn'] });
  const rag = app.get(RagService);

  console.log(`\nRAG eval — ${cases.length} case(s)${full ? ' (+ LLM)' : ''}${hardOnly ? ' [hard+]' : ''}\n`);

  const results: CaseResult[] = [];

  for (const c of cases) {
    const search = await rag.searchAcrossNamespaces(c.question, NAMESPACES);
    const { sources, topScore, routeMode, searchedBases } = search;
    const top = sources[0];

    const r: CaseResult = {
      case: c,
      ok: false,
      skipped: false,
      top,
      sources,
      topScore,
      routeMode,
      searchedBases,
      failures: [],
    };

    if (full && sources.length) {
      const gen = await rag.answerFromSources(c.question, sources);
      r.noData = gen.noData;
      r.citedCount = extractCitedIndices(gen.answer).length;
    }

    if (c.expectNoData && !c.noDataWithRetrieval && !full) {
      r.skipped = true;
      results.push(r);
      continue;
    }

    r.ok = evaluate(c, r, full);
    results.push(r);
  }

  // Print failures first
  for (const r of results.filter((x) => !x.ok && !x.skipped)) {
    const c = r.case;
    console.log(`\n${passIcon(false)} [${c.difficulty}] ${c.id}: "${c.question}"`);
    for (const f of r.failures) console.log(`   → ${f}`);
    if (r.top) {
      console.log(`   → top: ${stripNs(r.top.filename)} (${fmtScore(r.top.score)})`);
      console.log(`   → snippet: "${r.top.text.replace(/\s+/g, ' ').slice(0, 140)}…"`);
    }
    if (verbose && r.sources.length > 1) {
      for (const [i, s] of r.sources.slice(1, 3).entries()) {
        console.log(`   → #${i + 2}: ${stripNs(s.filename)} (${fmtScore(s.score)})`);
      }
    }
    if (c.notes) console.log(`   ℹ ${c.notes}`);
  }

  console.log('\n' + '─'.repeat(72));
  for (const r of results) {
    const c = r.case;
    if (r.skipped) {
      console.log(`⚠️  [${c.difficulty}] ${c.id} | skip (--full for NO_DATA) | score=${fmtScore(r.topScore)}`);
      continue;
    }
    const topFile = r.top ? stripNs(r.top.filename).slice(0, 35) : '—';
    const llm = full ? (r.noData ? 'NO_DATA' : `cited=${r.citedCount ?? 0}`) : '';
    console.log(
      `${passIcon(r.ok)} [${c.difficulty.padEnd(11)}] ${c.id.padEnd(22)} | ${fmtScore(r.topScore)} ${r.routeMode.padEnd(18)} | ${topFile}${llm ? ` | ${llm}` : ''}`,
    );
  }
  console.log('─'.repeat(72));

  const scored = results.filter((r) => !r.skipped);
  const passed = scored.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;

  console.log(`\n${passed}/${scored.length} passed${skipped ? ` · ${skipped} skipped (use --full)` : ''}`);

  for (const diff of DIFFICULTY_ORDER) {
    const group = scored.filter((r) => r.case.difficulty === diff);
    if (!group.length) continue;
    const gPass = group.filter((r) => r.ok).length;
    console.log(`  ${diff.padEnd(12)} ${gPass}/${group.length}`);
  }
  console.log();

  await app.close();
  process.exit(passed === scored.length && scored.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
