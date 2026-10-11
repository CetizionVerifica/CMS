import type { ComponentType } from 'react';

import { Link } from '../src';
import { ButtonsPage } from './pages/ButtonsPage';
import { ContextPage } from './pages/ContextPage';
import { DataTablePage } from './pages/DataTablePage';
import { DisplayPage } from './pages/DisplayPage';
import { EvidencePage } from './pages/EvidencePage';
import { FeedbackPage } from './pages/FeedbackPage';
import { FieldsPage } from './pages/FieldsPage';
import { ListsPage } from './pages/ListsPage';
import { MetricsPage } from './pages/MetricsPage';
import { OverlaysPage } from './pages/OverlaysPage';
import { ShellFrame, ShellPage } from './pages/ShellPage';
import { StatusPage } from './pages/StatusPage';
import { TokensPage } from './pages/TokensPage';
import { galleryRoutes, type GalleryPath } from './routes';
import { useRoute } from './router';

const components: Record<GalleryPath, ComponentType> = {
  '/tokens': TokensPage,
  '/button': ButtonsPage,
  '/fields': FieldsPage,
  '/overlays': OverlaysPage,
  '/display': DisplayPage,
  '/app-shell': ShellPage,
  '/context': ContextPage,
  '/metrics': MetricsPage,
  '/status': StatusPage,
  '/feedback': FeedbackPage,
  '/data-table': DataTablePage,
  '/lists': ListsPage,
  '/evidence': EvidencePage,
};

function Home() {
  return (
    <div className="min-h-screen bg-mist">
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-5.5">
        <h1 className="text-page text-ink">Canopy components</h1>
        <p className="mt-1 text-body text-muted">
          Demo pages for packages/ui, one per component in spec order.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {galleryRoutes.map((p) => (
            <li
              key={p.path}
              className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
            >
              <span className="w-24 shrink-0 text-meta text-muted">Spec {p.spec}</span>
              <Link href={`#${p.path}`}>{p.title}</Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

export function App() {
  const { path } = useRoute();
  if (path === '/shell' || path.startsWith('/shell/')) return <ShellFrame />;
  const page = galleryRoutes.find((p) => p.path === path);
  if (!page) return <Home />;
  document.title = `${page.title} · Canopy components`;
  const Component = components[page.path];
  return <Component />;
}
