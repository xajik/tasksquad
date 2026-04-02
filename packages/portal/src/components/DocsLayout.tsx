import { useParams, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import DocsSidebar from './DocsSidebar';
import MarkdownRenderer from './MarkdownRenderer';
import { getDocByPath } from '../lib/docs';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';

function extractHeadings(content: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    headings.push({ id, text, level });
  }
  return headings;
}

export default function DocsLayout() {
  const { '*': rawPath } = useParams();
  const navigate = useNavigate();
  
  const path = rawPath || 'intro';
  
  const doc = useMemo(() => getDocByPath(path), [path]);
  
  const breadcrumbs = useMemo(() => {
    if (!doc) return [];
    const parts = path.split('/');
    const crumbs: { label: string; path: string }[] = [];
    let currentPath = '';
    parts.forEach((part, idx) => {
      currentPath += (idx > 0 ? '/' : '') + part;
      const label = idx === parts.length - 1 
        ? (doc.metadata?.title || doc.name)
        : part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
      crumbs.push({ label, path: currentPath });
    });
    return crumbs;
  }, [path, doc]);

  const headings = useMemo(() => {
    if (!doc?.content) return [];
    return extractHeadings(doc.content);
  }, [doc]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar - desktop */}
      <aside className="hidden md:flex w-72 flex-col flex-shrink-0">
        <div className="p-6 border-b">
          <strong 
            className="text-xl font-bold cursor-pointer" 
            onClick={() => navigate('/')}
          >
            TaskSquad Docs
          </strong>
        </div>
        <DocsSidebar />
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top nav / mobile menu */}
        <header className="h-16 flex items-center justify-between px-4 sm:px-6 border-b flex-shrink-0 bg-background/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-2 sm:gap-4 overflow-hidden">
            <div className="md:hidden flex-shrink-0">
               <strong 
                className="text-lg font-bold cursor-pointer" 
                onClick={() => navigate('/')}
              >
                TaskSquad
              </strong>
            </div>
            {breadcrumbs.length > 0 && (
               <nav className="hidden sm:flex items-center gap-1 text-sm text-muted-foreground min-w-0">
                 <button 
                   onClick={() => navigate('/docs/intro')}
                   className="hover:text-foreground transition-colors flex-shrink-0"
                 >
                   Docs
                 </button>
                {breadcrumbs.map((crumb, idx) => (
                  <span key={crumb.path} className="flex items-center gap-1 min-w-0">
                    <ChevronRight className="h-3 w-3 flex-shrink-0" />
                    <button
                      onClick={() => navigate(`/docs/${crumb.path}`)}
                      className={cn(
                        'hover:text-foreground transition-colors truncate max-w-[120px]',
                        idx === breadcrumbs.length - 1 && 'text-foreground font-medium'
                      )}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </nav>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
             <Button variant="ghost" size="sm" onClick={() => navigate('/howto')}>Back to App</Button>
          </div>
        </header>

        {/* Content area */}
        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 md:py-16">
            {doc ? (
              <div className="space-y-8">
                {doc.metadata?.title && (
                   <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl">
                    {doc.metadata.title}
                  </h1>
                )}
                <MarkdownRenderer content={doc.content || ''} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-[50vh] space-y-4">
                <h1 className="text-4xl font-bold">404</h1>
                <p className="text-muted-foreground text-xl">Document not found</p>
                <Button onClick={() => navigate('/docs/intro')}>Go to Intro</Button>
              </div>
            )}
            
            <footer className="mt-20 pt-10 border-t text-sm text-muted-foreground">
              <p>© 2026 TaskSquad. All rights reserved.</p>
            </footer>
          </div>
        </ScrollArea>
      </main>
      
      {/* TOC sidebar - desktop only */}
      {headings.length > 2 && (
        <aside className="hidden lg:block w-56 flex-shrink-0 border-l bg-muted/20 p-6">
          <div className="sticky top-24">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
              On this page
            </h4>
            <nav className="space-y-2">
              {headings.map((h) => (
                <a
                  key={h.id}
                  href={`#${h.id}`}
                  className={cn(
                    'block text-sm transition-colors hover:text-foreground',
                    h.level === 2 && 'text-foreground/80',
                    h.level > 2 && 'text-foreground/60 pl-3',
                  )}
                >
                  {h.text}
                </a>
              ))}
            </nav>
          </div>
        </aside>
      )}
    </div>
  );
}