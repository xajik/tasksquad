import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative, extname } from 'path';
import matter from 'gray-matter';
import { STATIC_ROUTES, type RouteMeta } from '../src/lib/seo-routes';

const ROOT = join(import.meta.dir, '..');
const DOCS_DIR = join(ROOT, 'src/docs');
const SITE_URL = 'https://tasksquad.ai';

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (extname(full) === '.md') {
      files.push(full);
    }
  }
  return files;
}

function docRoutes(): RouteMeta[] {
  return walk(DOCS_DIR).map((filePath) => {
    const cleanPath = relative(DOCS_DIR, filePath).replace(/\.md$/, '').replace(/\\/g, '/');
    const { data } = matter(readFileSync(filePath, 'utf8'));
    return {
      path: `/docs/${cleanPath}`,
      title: data.title ? `${data.title} — TaskSquad Docs` : 'TaskSquad Docs',
      description: data.description || 'TaskSquad documentation.',
    };
  });
}

const routes: RouteMeta[] = [...STATIC_ROUTES, ...docRoutes()];

mkdirSync(join(ROOT, 'generated'), { recursive: true });
writeFileSync(
  join(ROOT, 'generated/route-metadata.json'),
  JSON.stringify(routes, null, 2) + '\n'
);

const sitemapUrls = routes
  .filter((r) => !r.noindex)
  .map((r) => `  <url><loc>${SITE_URL}${r.path === '/' ? '' : r.path}</loc></url>`)
  .join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls}
</urlset>
`;

writeFileSync(join(ROOT, 'public/sitemap.xml'), sitemap);

console.log(`Generated route-metadata.json and sitemap.xml for ${routes.length} routes.`);
