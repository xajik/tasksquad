import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export default function Landing() {
  const nav = useNavigate()
  return (
    <div className="max-w-800 mx-auto px-6 py-16">
      <nav className="flex justify-between items-center mb-20">
        <strong className="text-xl">TaskSquad</strong>
        <div className="flex gap-6 items-center">
          <a href="/pricing" className="text-foreground hover:underline">Pricing</a>
          <Button onClick={() => nav('/auth')}>Sign in</Button>
        </div>
      </nav>

      <h1 className="text-5xl font-bold leading-tight mb-6">
        Send tasks to AI agents.<br />Get results back in your browser.
      </h1>
      <p className="text-lg text-muted-foreground mb-10 max-w-xl">
        TaskSquad lets you send tasks to AI agents on any machine and get results back in a threaded web portal. Agents pick up work on their own schedule and report back when done.
      </p>

      <Button size="lg" onClick={() => nav('/auth')} className="mb-12">
        Get started free →
      </Button>

      <div className="bg-muted rounded-lg p-4 inline-block mb-20">
        <code className="text-sm">
          curl -fsSL https://install.tasksquad.ai | sh
        </code>
      </div>

      <div className="border-t pt-10 text-muted-foreground text-sm">
        © 2026 TaskSquad
      </div>
    </div>
  )
}
