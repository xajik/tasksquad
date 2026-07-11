import routeMetadata from '../generated/route-metadata.json';

interface RouteMeta {
  path: string;
  title: string;
  description: string;
  noindex?: boolean;
}

const SITE_URL = 'https://tasksquad.ai';
const DEFAULT_TITLE = 'TaskSquad';
const DEFAULT_DESCRIPTION = 'Teams of humans + AI agents collaborating via task threads';

const routesByPath = new Map<string, RouteMeta>(
  (routeMetadata as RouteMeta[]).map((route) => [route.path, route])
);

// Auth/dashboard paths are legitimate client-only routes the edge can't fully validate
// (dashboard sub-routes and doc leaves aren't statically enumerable the same way), so they're
// always served as 200/noindex rather than 404.
function isAppPath(pathname: string): boolean {
  return (
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/')
  );
}

function resolve(pathname: string): { meta: RouteMeta; status: number } {
  const exact = routesByPath.get(pathname);
  if (exact) return { meta: exact, status: 200 };

  if (isAppPath(pathname)) {
    return {
      meta: { path: pathname, title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, noindex: true },
      status: 200,
    };
  }

  return {
    meta: { path: pathname, title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, noindex: true },
    status: 404,
  };
}

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const { pathname } = new URL(context.request.url);
  const { meta, status } = resolve(pathname);
  const canonical = `${SITE_URL}${meta.path}`;
  const robots = meta.noindex ? 'noindex, nofollow' : 'index, follow';

  const rewritten = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', meta.description);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute('content', meta.title);
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        el.setAttribute('content', meta.description);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute('content', canonical);
      },
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', canonical);
      },
    })
    .on('meta[name="twitter:title"]', {
      element(el) {
        el.setAttribute('content', meta.title);
      },
    })
    .on('meta[name="twitter:description"]', {
      element(el) {
        el.setAttribute('content', meta.description);
      },
    })
    .on('meta[name="robots"]', {
      element(el) {
        el.setAttribute('content', robots);
      },
    })
    .transform(response);

  if (status === 200) return rewritten;

  return new Response(rewritten.body, {
    status,
    statusText: 'Not Found',
    headers: rewritten.headers,
  });
};
