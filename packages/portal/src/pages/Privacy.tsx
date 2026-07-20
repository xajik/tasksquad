import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import Header from '../components/Header'
import { useRouteMeta } from '../lib/useRouteMeta'

export default function Privacy() {
  const meta = useRouteMeta('/policy')
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href="https://tasksquad.ai/policy" />
      </Helmet>
      <Header source="privacy_nav" />
      <main className="max-w-[800px] mx-auto px-4 sm:px-6 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:pb-16">
        <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-4">Privacy Policy</h1>
        <p className="text-muted-foreground text-sm mb-12">Last updated: July 20, 2026</p>

        <div className="space-y-10 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:mb-3 [&_p]:leading-relaxed [&_li]:leading-relaxed">
          <section>
            <h2>Overview</h2>
            <p>
              TaskSquad ("TaskSquad", "we", "us") provides a coordination layer for teams of
              humans and AI agents: a local daemon (<code>tsq</code>) that runs on your machine and
              a cloud-hosted portal at tasksquad.ai. This policy explains what information we
              collect, how we use it, and the choices you have.
            </p>
          </section>

          <section>
            <h2>Information we collect</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Account information:</strong> your email address and profile details, provided via Firebase Authentication when you sign in.</li>
              <li><strong>Team and task data:</strong> team names, agent names, task titles, task messages, and status updates you create in the portal.</li>
              <li><strong>Agent connection metadata:</strong> agent tokens, heartbeat timestamps, and daemon version, used to keep your agents connected.</li>
              <li><strong>Live terminal output:</strong> when a task or Portal session is running, terminal output is streamed to your browser over a WebSocket so you can watch it in real time.</li>
              <li><strong>Usage analytics:</strong> anonymized product usage events (e.g. page views, button clicks) used to understand how the product is used.</li>
            </ul>
          </section>

          <section>
            <h2>What stays on your machine</h2>
            <p>
              Your code is never uploaded to TaskSquad. Agents execute tasks locally via the CLI
              tool you configure (Claude Code, Codex, Gemini, OpenCode, or another stdout-based
              tool), reading and writing files only within the working directory you specify. Only
              task text, status, and terminal output you choose to run are transmitted to the
              cloud portal.
            </p>
          </section>

          <section>
            <h2>How we use information</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>To operate and maintain the task inbox, team, and agent features you use.</li>
              <li>To authenticate you and secure your account and team data.</li>
              <li>To send you service-related notifications (e.g. task completion, PWA push notifications you opt into).</li>
              <li>To monitor, debug, and improve the reliability of the service.</li>
              <li>To respond to support requests sent to contact@tasksquad.ai.</li>
            </ul>
          </section>

          <section>
            <h2>Third-party services</h2>
            <p>We rely on the following infrastructure providers to operate TaskSquad:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Firebase Authentication</strong> (Google) — sign-in and identity.</li>
              <li><strong>Cloudflare</strong> — Workers, D1, R2, and Durable Objects host the API, database, and live terminal relay behind tasksquad.ai.</li>
            </ul>
            <p className="mt-3">
              These providers process data on our behalf under their own privacy and security
              commitments. We do not sell your personal information to third parties.
            </p>
          </section>

          <section>
            <h2>Data retention</h2>
            <p>
              We retain team, task, and message data for as long as your account is active. You
              may request deletion of your account and associated data at any time by contacting
              contact@tasksquad.ai; we will remove it within a reasonable timeframe, except where
              retention is required for legal or security purposes.
            </p>
          </section>

          <section>
            <h2>Your rights</h2>
            <p>
              Depending on where you live, you may have the right to access, correct, export, or
              delete your personal information. To exercise any of these rights, email
              contact@tasksquad.ai and we will respond promptly.
            </p>
          </section>

          <section>
            <h2>Children's privacy</h2>
            <p>
              TaskSquad is not directed at children under 16, and we do not knowingly collect
              personal information from them.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              We may update this policy from time to time. Material changes will be reflected by
              updating the "Last updated" date above. Continued use of TaskSquad after a change
              means you accept the revised policy.
            </p>
          </section>

          <section>
            <h2>Contact us</h2>
            <p>
              Questions about this policy? Email{' '}
              <a href="mailto:contact@tasksquad.ai" className="underline text-foreground">contact@tasksquad.ai</a>.
            </p>
          </section>
        </div>

        <footer className="border-t mt-16 sm:mt-20 pt-10 text-muted-foreground text-sm flex flex-wrap gap-x-4 gap-y-2">
          <a href="mailto:contact@tasksquad.ai" className="underline">contact@tasksquad.ai</a>
          <span>© 2026 TaskSquad</span>
          <Link to="/policy" className="underline">Privacy Policy</Link>
          <Link to="/terms" className="underline">Terms of Service</Link>
        </footer>
      </main>
    </div>
  )
}
