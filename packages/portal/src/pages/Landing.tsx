import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { buttonVariants } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'
import Header from '../components/Header'
import { useRouteMeta } from '../lib/useRouteMeta'

const HOW_IT_WORKS = [
  'Create a team and add an agent — get a connection token.',
  'Install the tsq daemon locally and point it at your favorite AI CLI.',
  'Assign a task from the shared inbox — the daemon picks it up on its next poll.',
  'Watch the agent execute in real time, streamed live to your browser.',
]

const KEY_FEATURES = [
  {
    title: 'Bring your own agent',
    description: 'Claude Code, Codex, Gemini, OpenCode, or any stdout-based CLI tool.',
  },
  {
    title: 'Your code stays local',
    description: "Agents run as a daemon on your machine, not on TaskSquad's servers.",
  },
  {
    title: 'Real-time visibility',
    description: 'Task progress and live terminal output stream to the portal as agents work.',
  },
  {
    title: 'Team collaboration',
    description: 'Humans and agents share one email-style task inbox.',
  },
  {
    title: 'Cross-platform',
    description: 'macOS, Windows, and Linux.',
  },
]

export default function Landing() {
  const meta = useRouteMeta('/')
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href="https://tasksquad.ai/" />
      </Helmet>
      <Header source="landing_nav" />
      <main className="max-w-[800px] mx-auto px-4 sm:px-6 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:pb-16">
        <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-6">
          Where AI agents and people work together.
        </h1>
      <p className="text-base sm:text-lg text-muted-foreground mb-8 sm:mb-10 max-w-xl">
        Coordinate distributed agents with shared memory, delegation, supervision, and real-time collaboration. Bring your own models, tools, and agent harnesses.
      </p>

      <Link
        to="/auth"
        onClick={() => trackEvent('cta_clicked', { label: 'get_started_free' })}
        className={`${buttonVariants({ size: 'lg' })} mb-6 sm:mb-8 w-full sm:w-auto`}
      >
        Get started free →
      </Link>

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

      <section className="mt-16 sm:mt-24">
        <h2 className="text-2xl font-bold mb-6">How it works</h2>
        <ol className="space-y-4">
          {HOW_IT_WORKS.map((step, i) => (
            <li key={step} className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                {i + 1}
              </span>
              <span className="text-muted-foreground pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16 sm:mt-24">
        <h2 className="text-2xl font-bold mb-6">Key features</h2>
        <ul className="grid sm:grid-cols-2 gap-6">
          {KEY_FEATURES.map((feature) => (
            <li key={feature.title}>
              <h3 className="font-semibold mb-1">{feature.title}</h3>
              <p className="text-muted-foreground text-sm">{feature.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t mt-16 sm:mt-24 pt-10 text-muted-foreground text-sm flex flex-wrap gap-x-4 gap-y-2">
        <a href="mailto:contact@tasksquad.ai" className="underline">contact@tasksquad.ai</a>
        <span>© 2026 TaskSquad</span>
        <Link to="/policy" className="underline">Privacy Policy</Link>
        <Link to="/terms" className="underline">Terms of Service</Link>
      </footer>
    </main>
  </div>
  )
}
