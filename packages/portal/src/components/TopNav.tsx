import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'

interface TopNavProps {
  source: string
}

export default function TopNav({ source }: TopNavProps) {
  const nav = useNavigate()
  return (
    <nav className="flex justify-between items-center mb-10 sm:mb-20">
      <strong className="text-xl cursor-pointer" onClick={() => nav('/')}>TaskSquad</strong>
      <div className="flex gap-4 sm:gap-6 items-center">
        <button onClick={() => { trackEvent('howto_clicked', { source }); nav('/howto') }} className="text-foreground hover:underline">How To</button>
        <button onClick={() => { trackEvent('pricing_clicked', { source }); nav('/pricing') }} className="text-foreground hover:underline">Pricing</button>
        <button onClick={() => { trackEvent('docs_clicked', { source }); nav('/docs') }} className="text-foreground hover:underline">Docs</button>
        <Button onClick={() => { trackEvent('sign_in_clicked', { source }); nav('/auth') }}>Sign in</Button>
      </div>
    </nav>
  )
}
