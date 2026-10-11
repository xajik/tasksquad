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

// Firebase's sign-in helper, served first-party. Browsers that partition third-party storage (Safari,
// and the iOS app's ASWebAuthenticationSession sheet) lose a redirect sign-in whose handler runs on
// <project>.firebaseapp.com: the page comes back signed out. Pages that sign in with
// authDomain = tasksquad.ai use these paths instead (see mobileAuth in src/lib/firebase.ts).
const FIREBASE_AUTH_HOST = 'tasksquad-e1442.firebaseapp.com';

function proxyFirebaseAuth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.hostname = FIREBASE_AUTH_HOST;
  url.port = '';
  url.protocol = 'https:';
  return fetch(new Request(url.toString(), request));
}

// tasksquad.ai/mcp is an alias of the MCP server (packages/mcp). Its OAuth
// endpoints and metadata are proxied too, so clients see one origin. The MCP
// worker trusts X-TSQ-Public-Host only for origins in its ALIAS_ORIGINS.
const MCP_ORIGIN = 'https://tasksquad-mcp.xajik0.workers.dev';

function isMcpPath(pathname: string): boolean {
  return (
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/.well-known/oauth-')
  );
}

function proxyMcp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('X-TSQ-Public-Host', url.host);
  return fetch(new URL(url.pathname + url.search, MCP_ORIGIN).toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });
}

export const onRequest: PagesFunction = async (context) => {
  const { pathname: requestPath } = new URL(context.request.url);
  if (requestPath.startsWith('/__/auth/')) {
    return proxyFirebaseAuth(context.request);
  }
  if (isMcpPath(requestPath)) {
    return proxyMcp(context.request);
  }

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
