import Fuse from 'fuse.js';

function parseFrontmatter(raw: string): { data: Record<string, any>; content: string } {
  if (!raw.startsWith('---')) return { data: {}, content: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { data: {}, content: raw };
  const yamlBlock = raw.slice(4, end);
  const body = raw.slice(end + 4).trimStart();
  const data: Record<string, any> = {};
  for (const line of yamlBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
    } else if (val === 'true' || val === 'false') {
      data[key] = val === 'true';
    } else if (val !== '' && !isNaN(Number(val))) {
      data[key] = Number(val);
    } else {
      data[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return { data, content: body };
}

export interface DocMetadata {
  title: string;
  order?: number;
  [key: string]: any;
}

export interface DocNode {
  name: string;
  path: string;
  isFolder: boolean;
  metadata?: DocMetadata;
  content?: string;
  children?: DocNode[];
}

export interface SearchDoc {
  title: string;
  path: string;
  content: string;
}

// 1. Discover all .md files in src/docs
const rawDocs = import.meta.glob('../docs/**/*.md', { query: '?raw', eager: true });

export function parseDocsTree(): DocNode[] {
  const root: DocNode[] = [];

  for (const [filePath, module] of Object.entries(rawDocs)) {
    const content = (module as any).default as string;
    const { data, content: body } = parseFrontmatter(content);
    
    // Convert path: ../docs/concepts/architecture.md -> concepts/architecture
    const cleanPath = filePath
      .replace('../docs/', '')
      .replace('.md', '');
    
    const parts = cleanPath.split('/');
    let currentLevel = root;

    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1;
      let node = currentLevel.find(n => n.name === part);

      if (!node) {
        node = {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          isFolder: !isLast,
          children: isLast ? undefined : [],
          metadata: isLast ? (data as DocMetadata) : undefined,
          content: isLast ? body : undefined,
        };
        currentLevel.push(node);
      }

      if (!isLast && node.children) {
        currentLevel = node.children;
      }
    });
  }

  // Sort nodes by order metadata or name
  const sortNodes = (nodes: DocNode[]) => {
    nodes.sort((a, b) => {
      const orderA = a.metadata?.order ?? 999;
      const orderB = b.metadata?.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => {
      if (n.children) sortNodes(n.children);
    });
  };

  sortNodes(root);
  return root;
}

export function getFlatDocs(): SearchDoc[] {
  const flat: SearchDoc[] = [];
  const tree = parseDocsTree();

  const traverse = (nodes: DocNode[]) => {
    nodes.forEach(node => {
      if (!node.isFolder) {
        flat.push({
          title: node.metadata?.title || node.name,
          path: node.path,
          content: node.content || '',
        });
      }
      if (node.children) {
        traverse(node.children);
      }
    });
  };

  traverse(tree);
  return flat;
}

const fuseOptions = {
  keys: ['title', 'content'],
  threshold: 0.3,
  ignoreLocation: true,
};

let fuseInstance: Fuse<SearchDoc> | null = null;

export function searchDocs(query: string): SearchDoc[] {
  if (!fuseInstance) {
    fuseInstance = new Fuse(getFlatDocs(), fuseOptions);
  }
  return fuseInstance.search(query).map(result => result.item);
}

export function getDocByPath(path: string): DocNode | null {
  const tree = parseDocsTree();
  let found: DocNode | null = null;

  const traverse = (nodes: DocNode[]) => {
    for (const node of nodes) {
      if (node.path === path) {
        found = node;
        return;
      }
      if (node.children) {
        traverse(node.children);
      }
    }
  };

  traverse(tree);
  return found;
}
