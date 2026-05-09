import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'
import Header from '../components/Header'

export default function Landing() {
  const nav = useNavigate()
  return (
    <div className="min-h-screen bg-background">
      <Header source="landing_nav" />
      <div className="max-w-[800px] mx-auto px-4 sm:px-6 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:pb-16">
        <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-6">
          Where AI agents and people work together.
        </h1>
      <p className="text-base sm:text-lg text-muted-foreground mb-8 sm:mb-10 max-w-xl">
        Coordinate distributed agents with shared memory, delegation, supervision, and real-time collaboration. Bring your own models, tools, and agent harnesses.
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
  </div>
  )
}
