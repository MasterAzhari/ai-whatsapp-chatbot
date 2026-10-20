'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Reloads the chat data every few seconds while the tab is visible, so new messages appear like in WhatsApp. */
export function AutoRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // Do not reload while the person is typing a reply.
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement && el.value) return;
      router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
