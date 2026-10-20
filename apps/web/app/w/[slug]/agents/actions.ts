'use server';

import { createAgentWorkspace, resetAgentPassword } from '@chatbot/core';
import { actionError, db, requireUser } from '@/lib/server';

export interface AgentFormState {
  error?: string;
  created?: { slug: string; email: string; tempPassword: string | null; rulesCopied: number | null };
}

/** Creates an agent's workspace and login; the one-time password is returned to this page only. */
export async function addAgent(_prev: AgentFormState, f: FormData): Promise<AgentFormState> {
  try {
    const owner = await requireUser();
    const copy = String(f.get('copyFrom') ?? '');
    const created = await createAgentWorkspace(db(), owner, {
      workspaceName: String(f.get('workspaceName') ?? ''),
      slug: String(f.get('slug') ?? ''),
      agentName: String(f.get('agentName') ?? ''),
      agentEmail: String(f.get('agentEmail') ?? ''),
      copyFromSlug: copy || null,
    });
    return { created };
  } catch (err) {
    return { error: actionError(err) };
  }
}

export interface ResetState {
  error?: string;
  email?: string;
  tempPassword?: string;
}

export async function resetPassword(_prev: ResetState, f: FormData): Promise<ResetState> {
  try {
    const owner = await requireUser();
    const pw = await resetAgentPassword(db(), owner, String(f.get('userId')));
    return { email: String(f.get('email')), tempPassword: pw };
  } catch (err) {
    return { error: actionError(err) };
  }
}
