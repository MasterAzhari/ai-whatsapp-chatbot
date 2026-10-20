import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { withTenant } from './db.js';
import { ingestEvent } from './inbound.js';
import { enqueueReply } from './outbox.js';
import { addMembership, createChannel, createTenant, createUser, findTenantBySlug } from './repos/platform.js';

/**
 * SYNTHETIC demo data, clearly labelled. Creates two isolated tenants so tenant
 * separation can be checked in the UI. No real customers, numbers or prices.
 */
export async function seedDemo(db: Db, opts: { adminEmail: string; adminPassword: string }): Promise<{ created: boolean }> {
  if (await findTenantBySlug(db, 'demo-khind')) return { created: false };

  const tA = await createTenant(db, { slug: 'demo-khind', name: 'Demo KHIND (data sintetik)' });
  const tB = await createTenant(db, { slug: 'demo-tenant-b', name: 'Tenant Ujian B (data sintetik)' });
  const owner = await createUser(db, { email: opts.adminEmail, name: 'Platform Owner', password: opts.adminPassword, platformOwner: true });
  await addMembership(db, tA, owner, 'admin');
  await addMembership(db, tB, owner, 'admin');

  for (const [tenantId, label, customers] of [
    [tA, 'Demo', [
      ['Cik Aminah (sintetik)', 'Salam, nak tanya pasal sewa aircond'],
      ['Cik Farah (sintetik)', 'Kawasan saya Shah Alam, boleh pasang?'],
      ['Encik Rahman (sintetik)', 'Berapa lama proses semakan?'],
    ]],
    [tB, 'Tenant B', [['Pelanggan B1 (sintetik)', 'Hello, ada stok?']]],
  ] as const) {
    const channelId = await createChannel(db, tenantId, { name: `${label} mock channel`, provider: 'mock', status: 'connected' });
    let i = 0;
    for (const [name, text] of customers) {
      i++;
      await withTenant(db, tenantId, async (tx) => {
        const r = await ingestEvent(tx, tenantId, channelId, {
          type: 'message',
          providerMessageId: `seed-${randomUUID()}`,
          providerIdentity: `synthetic-${label}-${i}`,
          profileName: name,
          text,
          timestamp: new Date(Date.now() - (customers.length - i) * 600_000),
        });
        if (r.kind === 'stored' && i === 1) {
          await enqueueReply(tx, {
            tenantId,
            conversationId: r.conversationId,
            text: 'Terima kasih Cik, saya semak dahulu ya. (balasan sintetik)',
            origin: 'keyword',
            idempotencyKey: `seed:${r.messageId}`,
          });
        }
      });
    }
  }
  return { created: true };
}
