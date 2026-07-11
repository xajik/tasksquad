import { STATIC_ROUTES, type RouteMeta } from './seo-routes';

const FALLBACK: RouteMeta = {
  path: '/',
  title: 'TaskSquad',
  description: 'Teams of humans + AI agents collaborating via task threads',
};

export function useRouteMeta(path: string): RouteMeta {
  return STATIC_ROUTES.find((route) => route.path === path) || FALLBACK;
}
