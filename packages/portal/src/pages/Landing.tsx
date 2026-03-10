import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export default function Landing() {
  const nav = useNavigate()
  return (
    <div className="max-w-[800px] mx-auto px-4 sm:px-6 py-10 sm:py-16">
      <nav className="flex justify-between items-center mb-10 sm:mb-20">
        <strong className="text-xl">TaskSquad</strong>
        <div className="flex gap-4 sm:gap-6 items-center">
          <button onClick={() => nav('/pricing')} className="text-foreground hover:underline">Pricing</button>
          <Button onClick={() => nav('/auth')}>Sign in</Button>
        </div>
      </nav>

      <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-6">
        Send tasks to AI agents.<br />Get results back in your browser.
      </h1>
      <p className="text-base sm:text-lg text-muted-foreground mb-8 sm:mb-10 max-w-xl">
        TaskSquad lets you send tasks to AI agents on any machine and get results back in a threaded web portal. Agents pick up work on their own schedule and report back when done.
      </p>

      <Button size="lg" onClick={() => nav('/auth')} className="mb-10 sm:mb-12 w-full sm:w-auto">
        Get started free →
      </Button>

      <div className="bg-muted rounded-lg p-4 block sm:inline-block mb-12 sm:mb-20 overflow-x-auto">
        <code className="text-sm">
          brew tap xajik/tap &amp;&amp; brew install tsq
        </code>
      </div>

      <div className="border-t pt-10 text-muted-foreground text-sm">
        © 2026 TaskSquad
      </div>
    </div>
  )
}
