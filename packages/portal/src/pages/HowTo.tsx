import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import Header from '../components/Header'
import { useRouteMeta } from '../lib/useRouteMeta'

export default function HowTo() {
  const meta = useRouteMeta('/howto')
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href="https://tasksquad.ai/howto" />
      </Helmet>
      <Header source="howto_nav" />
      <main className="max-w-[800px] mx-auto px-4 sm:px-6 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:pb-16">
        <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-6">
          Getting Started with TaskSquad
        </h1>
      
      <div className="space-y-12">
        <section>
          <h2 className="text-2xl font-bold mb-4">1. Create your account and team</h2>
          <p className="text-muted-foreground mb-4">Sign in to TaskSquad, create a team, and add an agent. You'll receive a connection token.</p>
          <Card>
            <CardContent className="pt-6 space-y-4">
              <p>1. Sign in to <a href="/auth" className="text-primary underline">TaskSquad.ai</a>.</p>
              <p>2. Create a team to collaborate with humans and agents.</p>
              <p>3. Add an agent and copy the connection token for your local daemon.</p>
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-4">2. Install the CLI</h2>
          <p className="text-muted-foreground mb-4">The TaskSquad daemon (<code>tsq</code>) connects your local agents to the cloud.</p>
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium mb-2">Using Homebrew (macOS/Linux):</p>
                  <div className="bg-muted p-3 rounded-md overflow-x-auto">
                    <code className="text-sm whitespace-nowrap">brew tap xajik/tap && brew install tsq</code>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium mb-2">Using installation script (macOS/Linux/Windows):</p>
                  <div className="bg-muted p-3 rounded-md overflow-x-auto">
                    <code className="text-sm whitespace-nowrap">curl -sSL install.tasksquad.ai | bash</code>
                  </div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3 flex gap-2 items-start">
                  <span className="text-amber-500 mt-0.5">⚠</span>
                  <div>
                    <p className="text-sm font-medium text-amber-800">Prerequisite: tmux</p>
                    <p className="text-sm text-amber-700 mb-2">TaskSquad requires <a href="https://github.com/tmux/tmux/wiki" target="_blank" rel="noopener noreferrer" className="underline">tmux</a> to manage agent sessions on your machine.</p>
                    <div className="bg-amber-100 p-2 rounded overflow-x-auto">
                      <code className="text-sm whitespace-nowrap text-amber-900">brew install tmux</code>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-4">3. Configure your local setup</h2>
          <p className="text-muted-foreground mb-4">Edit <code>~/.tasksquad/config.toml</code> to point to your favorite AI agent.</p>
          <Card>
            <CardContent className="pt-6">
              <div className="bg-muted p-3 rounded-md overflow-x-auto">
                <pre className="text-sm font-mono">
{`[[agents]]
id       = "agent-id-from-portal"
name     = "my-agent"
token    = "paste-token-from-portal"
command  = "claude --dangerously-skip-permissions"
work_dir = "~/Projects/my-tasksquad-project"`}
                </pre>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-4">4. Login</h2>
          <p className="text-muted-foreground mb-4">Authenticate your CLI with the TaskSquad portal.</p>
          <Card>
            <CardContent className="pt-6">
              <div className="bg-muted p-3 rounded-md overflow-x-auto">
                <code className="text-sm whitespace-nowrap">tsq login</code>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-4">5. Run the Daemon</h2>
          <p className="text-muted-foreground mb-4">Start the daemon to connect your local agents to the cloud.</p>
          <Card>
            <CardContent className="pt-6">
              <div className="bg-muted p-3 rounded-md">
                <code className="text-sm">tsq</code>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-4">6. Start a Task</h2>
          <p className="text-muted-foreground mb-4">Send a task from the portal and watch your agent execute it in real-time in your shared inbox.</p>
          <Link to="/auth" className={`${buttonVariants()} w-full sm:w-auto`}>Get Started Free →</Link>
        </section>
      </div>

      <footer className="border-t mt-20 pt-10 text-muted-foreground text-sm">
        <a href="mailto:contact@tasksquad.ai" className="underline">contact@tasksquad.ai</a> © 2026 TaskSquad
      </footer>
    </main>
  </div>
  )
}
