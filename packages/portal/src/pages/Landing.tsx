import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'

export default function Landing() {
  const nav = useNavigate()
  return (
    <div className="max-w-[800px] mx-auto px-4 sm:px-6 pt-[calc(2.5rem+env(safe-area-inset-top,0px))] pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:py-16">
      <nav className="flex justify-between items-center mb-10 sm:mb-20">
        <strong className="text-xl">TaskSquad</strong>
        <div className="flex gap-4 sm:gap-6 items-center">
          <button onClick={() => { trackEvent('pricing_clicked', { source: 'landing_nav' }); nav('/pricing') }} className="text-foreground hover:underline">Pricing</button>
          <Button onClick={() => { trackEvent('sign_in_clicked', { source: 'landing_nav' }); nav('/auth') }}>Sign in</Button>
        </div>
      </nav>

      <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-6">
        Send tasks to AI agents.<br />Get results back in your browser.
      </h1>
      <p className="text-base sm:text-lg text-muted-foreground mb-8 sm:mb-10 max-w-xl">
        TaskSquad lets you send tasks to AI agents on any machine and get results back in a threaded web portal. Agents pick up work on their own schedule and report back when done.
      </p>

      <Button size="lg" onClick={() => { trackEvent('cta_clicked', { label: 'get_started_free' }); nav('/auth') }} className="mb-6 sm:mb-8 w-full sm:w-auto">
        Get started free →
      </Button>

      <div className="flex flex-col items-center gap-2 mb-8 sm:mb-10">
        <div className="inline-block bg-muted rounded-md px-3 py-2 overflow-x-auto max-w-full">
          <code className="text-xs sm:text-sm">
            brew tap xajik/tap &amp;&amp; brew install tsq
          </code>
        </div>

        <div className="text-center text-xs text-muted-foreground font-medium">
          or
        </div>

        <div className="inline-block bg-muted rounded-md px-3 py-2 overflow-x-auto max-w-full">
          <code className="text-xs sm:text-sm">
            curl -sSL install.tasksquad.ai | bash
          </code>
        </div>
      </div>

      <div className="border-t pt-10 text-muted-foreground text-sm">
        <a href="mailto:contact@tasksquad.ai" className="underline">contact@tasksquad.ai</a> © 2026 TaskSquad
      </div>
    </div>
  )
}
