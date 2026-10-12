import { NotFoundState } from '../lib/patterns';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <NotFoundState />
    </main>
  );
}
