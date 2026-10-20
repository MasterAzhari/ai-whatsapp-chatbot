/**
 * AI provider contract. Gemini is the first real implementation (Phase 2); model id,
 * prompt and limits come from per-tenant settings, never from source code.
 */

export interface ChatTurn {
  role: 'customer' | 'assistant';
  text: string;
}

export interface GenerateReplyInput {
  model: string;
  systemInstruction: string;
  history: ChatTurn[];
  knowledge: string[]; // only snippets relevant to this question
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  signal?: AbortSignal; // aborted when a human takes over mid-generation
}

export interface UsageReport {
  inputTokens: number | null; // null = provider did not report it
  outputTokens: number | null;
}

export type GenerateReplyResult =
  | { ok: true; text: string; usage: UsageReport; model: string; latencyMs: number }
  | { ok: false; reason: 'timeout' | 'quota' | 'invalid_model' | 'blocked' | 'error' | 'aborted'; detail: string };

export interface AIProvider {
  readonly name: string;
  generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult>;
  listModels?(): Promise<string[]>;
}

/** MOCK provider for tests and the synthetic demo. Never calls a network service. */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  calls = 0;
  constructor(private readonly reply = (input: GenerateReplyInput) => `[mock AI] ${input.history.at(-1)?.text ?? ''}`) {}

  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    this.calls++;
    if (input.signal?.aborted) return { ok: false, reason: 'aborted', detail: 'aborted before start' };
    return { ok: true, text: this.reply(input), usage: { inputTokens: null, outputTokens: null }, model: input.model, latencyMs: 0 };
  }
}
