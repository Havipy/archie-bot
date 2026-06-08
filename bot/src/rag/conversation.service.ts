import { Injectable } from '@nestjs/common';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** Doc pinned after an answer — reused for short thread/DM follow-ups. */
export interface StoredSourceRef {
  docId: string;
  namespaceSlug: string;
  filename: string;
}

interface Session {
  messages: Message[];
  lastSources: StoredSourceRef[];
}

const MAX_MESSAGES = 10; // last 5 Q&A pairs

@Injectable()
export class ConversationService {
  private readonly sessions = new Map<string, Session>();

  private key(userId: string, projectId: string): string {
    return `${userId}:${projectId}`;
  }

  getHistory(userId: string, projectId: string): Message[] {
    return this.sessions.get(this.key(userId, projectId))?.messages ?? [];
  }

  getLastSources(userId: string, projectId: string): StoredSourceRef[] {
    return this.sessions.get(this.key(userId, projectId))?.lastSources ?? [];
  }

  addExchange(
    userId: string,
    projectId: string,
    question: string,
    answer: string,
    sources?: StoredSourceRef[],
  ): void {
    const key = this.key(userId, projectId);
    const session = this.sessions.get(key) ?? { messages: [], lastSources: [] };

    session.messages.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer },
    );

    if (session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES);
    }

    if (sources?.length) {
      session.lastSources = sources.slice(0, 2);
    }

    this.sessions.set(key, session);
  }

  clearSession(userId: string, projectId: string): void {
    this.sessions.delete(this.key(userId, projectId));
  }
}
