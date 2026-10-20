import type { MetadataRoute } from 'next';

/** Lets the admin add MasterBot to a phone's home screen and open it full screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MasterBot',
    short_name: 'MasterBot',
    description: 'Inbox dan tetapan bot WhatsApp',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#127c56',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
