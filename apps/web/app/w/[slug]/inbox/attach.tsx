'use client';

import { useRef, useState } from 'react';

const ACCEPT = [
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/3gpp', 'application/pdf', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
].join(',');
const MAX_BYTES = 10 * 1024 * 1024;

/** Paperclip button in the Inbox composer: pick one picture, video or document to send with the message. */
export function AttachButton() {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const clear = () => {
    if (input.current) input.current.value = '';
    setName('');
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        name="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f && f.size > MAX_BYTES) {
            alert('File must be 10 MB or less.');
            clear();
            return;
          }
          if (f && !ACCEPT.split(',').includes(f.type)) {
            alert('Send a picture (JPG, PNG, WebP), a video (MP4) or a document (PDF, Word, Excel, PowerPoint, text).');
            clear();
            return;
          }
          setName(f?.name ?? '');
        }}
      />
      {name && (
        <span className="wa-file-chip" title={name}>
          📎 <span className="wa-file-name">{name}</span>
          <button type="button" onClick={clear} aria-label="Remove file">✕</button>
        </span>
      )}
      <button type="button" className="wa-note-btn" onClick={() => input.current?.click()} aria-label="Attach a picture, video or document" title="Attach a picture, video or document">📎</button>
    </>
  );
}
