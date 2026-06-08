import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { NamespaceProfileService } from './namespace-profile.service';

export interface NamespaceTarget {
  namespace: string;
  name: string;
}

export interface RouteResult {
  targets: NamespaceTarget[];
  mode: 'routed' | 'broadcast';
  scores: Array<{ name: string; score: number }>;
}

@Injectable()
export class NamespaceRouterService {
  private readonly logger = new Logger(NamespaceRouterService.name);
  private readonly openai: OpenAI;

  constructor(private readonly profiles: NamespaceProfileService) {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  }

  async route(
    question: string,
    namespaces: NamespaceTarget[],
    questionVec?: number[],
  ): Promise<RouteResult> {
    if (namespaces.length <= 1) {
      return {
        targets: namespaces,
        mode: 'broadcast',
        scores: namespaces.map((n) => ({ name: n.name, score: 1 })),
      };
    }

    const questionVector = questionVec ?? (await this.embed(question));
    const scored = await Promise.all(
      namespaces.map(async (ns) => ({
        ns,
        score: this.cosine(questionVector, await this.profiles.profileVector(ns.namespace, ns.name)),
      })),
    );
    scored.sort((a, b) => b.score - a.score);

    const scores = scored.map(({ ns, score }) => ({ name: ns.name, score }));
    const top = scored[0];

    if (top.score < 0.22) {
      this.logger.log(`Router broadcast (low confidence ${top.score.toFixed(2)}): ${question.slice(0, 60)}`);
      return { targets: namespaces, mode: 'broadcast', scores };
    }

    const margin = 0.07;
    const selected = scored.filter((s) => s.score >= top.score - margin).slice(0, 2).map((s) => s.ns);

    this.logger.log(
      `Router → ${selected.map((n) => n.name).join(', ')} (top ${top.score.toFixed(2)}): ${question.slice(0, 60)}`,
    );

    return { targets: selected, mode: 'routed', scores };
  }

  private async embed(text: string): Promise<number[]> {
    const res = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return res.data[0].embedding;
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}
