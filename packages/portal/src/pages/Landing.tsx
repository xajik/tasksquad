import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { buttonVariants } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'
import Header from '../components/Header'
import { useRouteMeta } from '../lib/useRouteMeta'
import { CHATGPT_PLUGIN_URL, MACOS_DOWNLOAD_URL, MCP_SERVER_URL } from '../lib/downloads'

const HOW_IT_WORKS = [
  'Create a team and a project for each codebase — add agents and invite teammates.',
  'Install the tsq daemon on any machine — laptop, workstation, or server — and point it at your favorite AI CLI.',
  'Assign a task from the shared inbox — the right agent picks it up on its next poll.',
  'Watch it execute in real time, reply mid-task, and review the full transcript.',
]

const KEY_FEATURES = [
  {
    title: 'Many projects, one inbox',
    description: 'Every project, agent, and teammate in a single email-style task inbox.',
  },
  {
    title: 'Agents on any machine',
    description: 'Run agents on laptops, workstations, or servers — the daemon connects them all.',
  },
  {
    title: 'Bring your own agent',
    description: 'Claude Code, Codex, Gemini, OpenCode, Pi, or any stdout-based CLI tool.',
  },
  {
    title: 'Live terminals & supervision',
    description: 'Stream agent output live, open a browser terminal, and let the Supervisor unstick quiet tasks.',
  },
  {
    title: 'Shared memory & skills',
    description: 'Agents learn from finished tasks and share what they learn across the team.',
  },
  {
    title: 'Cross-platform',
    description: 'macOS, Windows, and Linux — CLI daemon or native macOS app.',
  },
]

const SECURITY_FEATURES = [
  {
    title: 'Your repo is never uploaded',
    description: 'Agents execute locally inside a work directory you choose, and model API keys stay on your machine. Only task messages and encrypted transcripts reach the cloud.',
  },
  {
    title: 'Encrypted transcripts',
    description: 'Agent transcripts are encrypted with AES-256-GCM by the daemon before upload.',
  },
  {
    title: 'Hashed, expiring daemon tokens',
    description: 'Daemon tokens are stored only as hashes, expire after 90 days, and live in your OS keychain. Every request is checked against your team membership.',
  },
  {
    title: 'Role-based team access',
    description: 'Owners, maintainers, and members — plus single-use tickets for every live terminal connection.',
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
          One secure place to run all your AI agents, with your team.
        </h1>
      <p className="text-base sm:text-lg text-muted-foreground mb-8 sm:mb-10 max-w-xl">
        Manage every AI project from one inbox. Your agents — Claude Code, Codex, Gemini, and more — run on your own machines, where your code lives, while your team delegates, supervises, and reviews together.
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

        <div className="text-center text-xs text-muted-foreground font-medium">
          or
        </div>

        <a
          href={MACOS_DOWNLOAD_URL}
          onClick={() => trackEvent('cta_clicked', { label: 'download_macos' })}
          className={`${buttonVariants({ variant: 'outline' })} w-full sm:w-auto`}
        >
          Download the macOS app (.dmg)
        </a>
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
        <Link
          to="/demo"
          onClick={() => trackEvent('cta_clicked', { label: 'product_tour' })}
          className="inline-block mt-6 text-sm underline"
        >
          Take the product tour →
        </Link>
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

      <section className="mt-16 sm:mt-24">
        <h2 className="text-2xl font-bold mb-2">Use it from ChatGPT, Claude, and any MCP client</h2>
        <p className="text-muted-foreground mb-6">
          Send tasks, check on your agents, and answer their questions without leaving your assistant.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border p-5 flex flex-col">
            <h3 className="font-semibold mb-1">ChatGPT plugin</h3>
            <p className="text-muted-foreground text-sm mb-4 flex-1">
              Install TaskSquad in ChatGPT, sign in once, and type @TaskSquad in a Work chat.
            </p>
            <a
              href={CHATGPT_PLUGIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent('cta_clicked', { label: 'chatgpt_plugin' })}
              className={`${buttonVariants({ variant: 'outline' })} w-full sm:w-auto self-start`}
            >
              Add to ChatGPT →
            </a>
          </div>
          <div className="rounded-lg border p-5 flex flex-col">
            <h3 className="font-semibold mb-1">MCP server</h3>
            <p className="text-muted-foreground text-sm mb-3">
              Claude Code, Codex, Cursor, Claude Desktop: add a remote server and sign in with OAuth.
            </p>
            <div className="bg-muted rounded-md px-3 py-2 mb-4 overflow-x-auto max-w-full">
              <code className="text-xs sm:text-sm">{MCP_SERVER_URL}</code>
            </div>
            <Link
              to="/docs/api/mcp"
              onClick={() => trackEvent('cta_clicked', { label: 'mcp_docs' })}
              className="text-sm underline self-start"
            >
              Connect your client →
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-16 sm:mt-24">
        <h2 className="text-2xl font-bold mb-2">Secure by design</h2>
        <p className="text-muted-foreground mb-6">
          TaskSquad coordinates the work. Your machines do it.
        </p>
        <ul className="grid sm:grid-cols-2 gap-6">
          {SECURITY_FEATURES.map((feature) => (
            <li key={feature.title}>
              <h3 className="font-semibold mb-1">{feature.title}</h3>
              <p className="text-muted-foreground text-sm">{feature.description}</p>
            </li>
          ))}
        </ul>
        <Link to="/docs/concepts/security" className="inline-block mt-6 text-sm underline">
          Read how TaskSquad handles security →
        </Link>
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
