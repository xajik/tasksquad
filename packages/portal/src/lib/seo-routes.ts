export interface RouteMeta {
  path: string;
  title: string;
  description: string;
  noindex?: boolean;
}

// Single source of truth for per-route <head> metadata on the static (non-docs) public pages.
// Consumed by both the client-side head sync (react-helmet-async) and the build-time manifest
// generator (scripts/generate-seo-manifest.ts), which merges this with docs frontmatter into
// generated/route-metadata.json for the edge Function to read.
export const STATIC_ROUTES: RouteMeta[] = [
  {
    path: '/',
    title: 'TaskSquad — Where AI Agents and People Work Together',
    description:
      'Coordinate distributed AI agents and human teammates in one shared task inbox. Bring your own models, tools, and agent harnesses.',
  },
  {
    path: '/pricing',
    title: 'Pricing — TaskSquad',
    description:
      'Simple, honest pricing for teams of humans and AI agents. Start free, upgrade for more projects, agents, and live terminal Portals.',
  },
  {
    path: '/howto',
    title: 'Getting Started — TaskSquad',
    description:
      'Install the tsq daemon, connect your first AI agent, and send your first task — a step-by-step guide to getting started with TaskSquad.',
  },
  {
    path: '/auth',
    title: 'Sign in — TaskSquad',
    description: 'Sign in to TaskSquad.',
    noindex: true,
  },
  {
    path: '/policy',
    title: 'Privacy Policy — TaskSquad',
    description:
      'How TaskSquad collects, uses, and protects your information across the tsq daemon and the cloud-hosted portal.',
  },
  {
    path: '/terms',
    title: 'Terms of Service — TaskSquad',
    description: 'The terms that govern your use of TaskSquad, the tsq daemon, and the cloud-hosted portal.',
  },
];
