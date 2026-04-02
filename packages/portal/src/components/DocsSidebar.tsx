import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  Search, 
  Folder, 
  FileText, 
  ChevronRight, 
  ChevronDown 
} from 'lucide-react';
import { Input } from './ui/input';
import { 
  parseDocsTree, 
  searchDocs, 
  DocNode 
} from '../lib/docs';
import { cn } from '../lib/utils';

interface NavItemProps {
  node: DocNode;
  level: number;
}

function NavItem({ node, level }: NavItemProps) {
  const [isOpen, setIsOpen] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const activePath = location.pathname.replace('/docs/', '');

  const isActive = activePath === node.path;

  if (node.isFolder) {
    return (
      <div className="space-y-1">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/50 rounded-md transition-colors"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <Folder className="w-4 h-4 text-primary/70" />
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children && (
          <div className="space-y-1">
            {node.children.map((child) => (
              <NavItem key={child.path} node={child} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => navigate(`/docs/${node.path}`)}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 text-sm font-medium rounded-md transition-colors",
        isActive 
          ? "bg-primary/10 text-primary" 
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
      style={{ paddingLeft: `${level * 12 + 28}px` }}
    >
      <FileText className="w-4 h-4 opacity-70" />
      <span className="truncate">{node.metadata?.title || node.name}</span>
    </button>
  );
}

export default function DocsSidebar() {
  const [query, setQuery] = useState('');
  const tree = useMemo(() => parseDocsTree(), []);
  const navigate = useNavigate();

  const searchResults = useMemo(() => {
    if (!query.trim()) return null;
    return searchDocs(query);
  }, [query]);

  return (
    <div className="w-full h-full flex flex-col bg-background border-r">
      <div className="p-4 space-y-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search docs..."
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {searchResults ? (
          <div className="space-y-1">
            <p className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Search Results
            </p>
            {searchResults.length > 0 ? (
              searchResults.map((result) => (
                <button
                  key={result.path}
                  onClick={() => {
                    navigate(`/docs/${result.path}`);
                    setQuery('');
                  }}
                  className="w-full flex flex-col gap-0.5 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground rounded-md transition-colors"
                >
                  <span className="font-medium text-foreground">{result.title}</span>
                  <span className="text-xs truncate opacity-70">{result.path}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-muted-foreground italic">No results found.</p>
            )}
          </div>
        ) : (
          <div className="space-y-1 mt-2">
            {tree.map((node) => (
              <NavItem key={node.path} node={node} level={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
