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
        Lihat apa bot akan buat dengan satu mesej: berhenti, minta manusia, keyword atau AI. Ujian ini tidak menyimpan mesej dan tidak menghantar apa-apa.
        Suis automasi dianggap hidup supaya peraturan boleh diuji sebelum dihidupkan.
      </p>
      <PlaygroundForm slug={slug} channels={channels} />
    </>
  );
}
