import { Link } from 'react-router-dom'
import { buttonVariants } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'

interface TopNavProps {
  source: string
}

export default function TopNav({ source }: TopNavProps) {
  return (
    <nav className="flex justify-between items-center mb-10 sm:mb-20">
      <Link to="/" className="text-xl font-bold no-underline text-foreground">TaskSquad</Link>
      <div className="flex gap-4 sm:gap-6 items-center">
        <Link to="/howto" onClick={() => trackEvent('howto_clicked', { source })} className="text-foreground hover:underline">How To</Link>
        <Link to="/pricing" onClick={() => trackEvent('pricing_clicked', { source })} className="text-foreground hover:underline">Pricing</Link>
        <Link to="/docs" onClick={() => trackEvent('docs_clicked', { source })} className="text-foreground hover:underline">Docs</Link>
        <Link to="/auth" onClick={() => trackEvent('sign_in_clicked', { source })} className={buttonVariants()}>Sign in</Link>
      </div>
    </nav>
  )
}
