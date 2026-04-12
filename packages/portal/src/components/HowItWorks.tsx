import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { HelpCircle, ChevronUp, ChevronDown, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HowItWorksProps {
  title: string
  icon: React.ElementType
  children: ReactNode
  text?: ReactNode
  docsLink?: string
  docsLabel?: string
  className?: string
}

export function HowItWorks({
  title,
  icon: Icon,
  children,
  text,
  docsLink = '/docs',
  docsLabel = 'Documentation',
  className,
}: HowItWorksProps) {
  return (
    <div className={cn('p-3 rounded-xl border bg-muted/30', className)}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </h3>
        {docsLink && (
          <Link
            to={docsLink}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            {docsLabel} <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="-my-1">{children}</div>
      {text && (
        <div className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {text}
        </div>
      )}
    </div>
  )
}

interface HowItWorksToggleProps {
  show: boolean
  onToggle: () => void
  className?: string
}

export function HowItWorksToggle({ show, onToggle, className }: HowItWorksToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center h-7 px-2 text-xs gap-1.5 transition-colors',
        show ? 'bg-primary/5 text-primary' : 'text-muted-foreground',
        'hover:text-foreground',
        className
      )}
    >
      <HelpCircle className="h-3.5 w-3.5" />
      How it works
      {show ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
    </button>
  )
}