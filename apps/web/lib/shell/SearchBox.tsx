'use client';
// Top-bar search. Full search is not in v1 yet, so for now it opens the register filtered by the text (the register's
// `q` filter matches title, reference, Act and comments), or the obligation library when no client is selected.
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { clientHref } from '../routes';

export function SearchBox({ clientId }: { clientId?: string }) {
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (q.length < 2) return;
    const base = clientId ? clientHref(clientId, 'register') : '/library/obligations';
    router.push(`${base}?${new URLSearchParams({ q }).toString()}`);
  }

  return (
    <form role="search" onSubmit={onSubmit} className="relative w-full">
      <label htmlFor={id} className="sr-only">
        {clientId ? 'Search this client’s register' : 'Search the obligation library'}
      </label>
      <Search
        aria-hidden
        size={16}
        strokeWidth={1.75}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        id={id}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={clientId ? 'Search obligations, Acts, comments' : 'Search the library'}
        enterKeyHint="search"
        className="h-control w-full rounded-control border border-line-strong bg-surface pl-9 pr-3 text-body text-ink placeholder:text-muted touch-target"
      />
    </form>
  );
}
