import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import Header from '../components/Header'
import { useRouteMeta } from '../lib/useRouteMeta'

export default function Terms() {
  const meta = useRouteMeta('/terms')
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href="https://tasksquad.ai/terms" />
      </Helmet>
      <Header source="terms_nav" />
      <main className="max-w-[800px] mx-auto px-4 sm:px-6 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:pb-16">
        <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-4">Terms of Service</h1>
        <p className="text-muted-foreground text-sm mb-12">Last updated: July 20, 2026</p>

        <div className="space-y-10 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:mb-3 [&_p]:leading-relaxed [&_li]:leading-relaxed">
          <section>
            <h2>1. Acceptance of terms</h2>
            <p>
              By creating an account, installing the <code>tsq</code> daemon, or otherwise using
              TaskSquad ("the Service"), you agree to these Terms of Service. If you do not agree,
              do not use the Service.
            </p>
          </section>

          <section>
            <h2>2. Description of the service</h2>
            <p>
              TaskSquad is a coordination layer for teams of humans and AI agents. It consists of
              a local daemon that you install and run on your own machine, and a cloud-hosted
              portal that provides a shared, email-style task inbox, team management, and live
              terminal visibility into agent sessions.
            </p>
          </section>

          <section>
            <h2>3. Accounts</h2>
            <p>
              You must sign in with a valid identity provider to use the portal. You are
              responsible for maintaining the confidentiality of your agent connection tokens and
              for all activity that occurs under your account or agents.
            </p>
          </section>

          <section>
            <h2>4. Acceptable use</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>Do not use the Service to execute unlawful, harmful, or malicious code.</li>
              <li>Do not attempt to disrupt, overload, or gain unauthorized access to the Service or other users' teams, agents, or data.</li>
              <li>Do not exceed the usage limits of your plan (projects, members, and agents) to circumvent billing.</li>
              <li>You are solely responsible for the commands, prompts, and CLI tools your agents execute, and for their consequences on your own systems.</li>
            </ul>
          </section>

          <section>
            <h2>5. Your content and code</h2>
            <p>
              Your source code, files, and local execution environment remain on your machine at
              all times — TaskSquad does not upload or store your code. You retain all rights to
              the task content, messages, and other data you submit through the portal. You grant
              us a limited license to store and transmit that content solely to operate the
              Service (e.g. displaying it in your team's task inbox and streaming terminal output).
            </p>
          </section>

          <section>
            <h2>6. Plans and billing</h2>
            <p>
              TaskSquad offers a Free plan and a Pro plan with higher limits (projects, members,
              agents, polling frequency, and live terminal Portals). Pro plan activation is
              currently arranged by contacting contact@tasksquad.ai. We may change plan features,
              limits, or pricing with reasonable notice.
            </p>
          </section>

          <section>
            <h2>7. Third-party AI tools</h2>
            <p>
              TaskSquad lets you connect third-party CLI tools (such as Claude Code, Codex,
              Gemini, OpenCode, or others) to execute your tasks. Your use of those tools is
              governed by their own terms and is outside TaskSquad's control. We are not
              responsible for the output, cost, or behavior of any third-party tool you configure.
            </p>
          </section>

          <section>
            <h2>8. Termination</h2>
            <p>
              You may stop using the Service and delete your account at any time. We may suspend
              or terminate access to the Service for any account that violates these terms or
              poses a security risk to the Service or other users.
            </p>
          </section>

          <section>
            <h2>9. Disclaimers and limitation of liability</h2>
            <p>
              The Service is provided "as is" without warranties of any kind. To the maximum
              extent permitted by law, TaskSquad is not liable for any indirect, incidental, or
              consequential damages arising from your use of the Service, including damages caused
              by code or commands executed by agents you configure.
            </p>
          </section>

          <section>
            <h2>10. Changes to these terms</h2>
            <p>
              We may update these terms from time to time. Material changes will be reflected by
              updating the "Last updated" date above. Continued use of the Service after a change
              means you accept the revised terms.
            </p>
          </section>

          <section>
            <h2>11. Contact</h2>
            <p>
              Questions about these terms? Email{' '}
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
