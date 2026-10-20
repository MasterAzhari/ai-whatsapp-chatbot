import { redirect } from 'next/navigation';
import { getDashboard } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';
import { PlaygroundForm } from './form';

export const dynamic = 'force-dynamic';

export default async function Playground({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') redirect(`/w/${slug}`);
  const { channels } = await getDashboard(db(), ctx);
  return (
    <>
      <h1>Playground</h1>
      <p className="small muted">
        See what the bot will do with one message: stop, ask for a human, keyword or AI. This test does not store the message or send anything.
        Automation switches are treated as on so rules can be tested before they are switched on.
      </p>
      <PlaygroundForm slug={slug} channels={channels} />
    </>
  );
}
