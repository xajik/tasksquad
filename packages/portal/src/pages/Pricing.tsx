import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { buttonVariants } from '@/components/ui/button'
import { trackEvent } from '../lib/analytics'
import Header from '../components/Header'
import { useRouteMeta } from '../lib/useRouteMeta'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Check } from 'lucide-react'

const FREE_FEATURES = [
  'Up to 3 projects',
  'Up to 5 members per project',
  'Up to 3 agents per project',
  '60 sec polling',
  'Integrate with Gemini, Claude, OpenCode, Codex',
  'Support for Mac, Windows, Linux',
  'PWA push notifications',
]

const PRO_FEATURES = [
  'Up to 10 projects',
  'Up to 10 members per project',
  'Up to 10 agents per project',
  '5-second task polling',
  'Live terminal Portals (up to 3 concurrent)'
]

export default function Pricing() {
  const meta = useRouteMeta('/pricing')

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href="https://tasksquad.ai/pricing" />
      </Helmet>
      <Header source="pricing_nav" />

      <main className="max-w-[800px] mx-auto px-4 sm:px-6 pb-10 sm:pb-16 text-center">
        <h1 className="text-4xl font-bold mb-4">Simple, honest pricing</h1>
        <p className="text-muted-foreground text-lg mb-10">Start free. Upgrade when you need more.</p>
        <h2 className="text-2xl font-semibold mb-6">Choose your plan</h2>

        <div className="grid md:grid-cols-2 gap-6 text-left">
          <Card className="border-2 border-primary/20">
            <CardHeader className="pb-4">
              <CardTitle className="text-2xl">Free</CardTitle>
              <div className="text-4xl font-bold mt-2">
                $0<span className="text-base font-normal text-muted-foreground">/mo</span>
              </div>
              <CardDescription>Everything you need to get started</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {FREE_FEATURES.map(f => (
                <div key={f} className="flex items-center gap-2 text-sm">
                  <Check className="h-4 w-4 text-green-500 shrink-0" />
                  {f}
                </div>
              ))}
            </CardContent>
            <CardFooter>
              <Link
                to="/auth"
                onClick={() => trackEvent('pricing_plan_selected', { plan: 'free' })}
                className={`${buttonVariants()} w-full`}
              >
                Get started free
              </Link>
            </CardFooter>
          </Card>

          <Card className="border-2 border-primary relative">
            <div className="absolute top-4 right-4">
              <Badge>Pro</Badge>
            </div>
            <CardHeader className="pb-4">
              <CardTitle className="text-2xl">Pro</CardTitle>
              <div className="text-4xl font-bold mt-2">
                $29<span className="text-base font-normal text-muted-foreground">/mo</span>
              </div>
              <CardDescription>For teams that move fast</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {PRO_FEATURES.map(f => (
                <div key={f} className="flex items-center gap-2 text-sm">
                  <Check className="h-4 w-4 text-green-500 shrink-0" />
                  {f}
                </div>
              ))}
            </CardContent>
            
            <CardFooter className="flex-col gap-2 items-start">
              <p className="text-xs text-muted-foreground text-center w-full">
                Contact us at{' '}
                <a href="mailto:contact@tasksquad.ai" onClick={() => trackEvent('contact_email_clicked', { source: 'pricing_pro' })} className="underline">contact@tasksquad.ai</a>
                {' '} to activate
              </p>
            </CardFooter>
          </Card>
        </div>
      </main>

      <footer className="max-w-[800px] mx-auto px-4 sm:px-6 pb-[calc(3rem+env(safe-area-inset-bottom,0px))] border-t pt-10 text-muted-foreground text-sm sm:pb-12 flex flex-wrap gap-x-4 gap-y-2">
      <a href="mailto:contact@tasksquad.ai" className="underline">contact@tasksquad.ai</a>
      <span>© 2026 TaskSquad</span>
      <Link to="/policy" className="underline">Privacy Policy</Link>
      <Link to="/terms" className="underline">Terms of Service</Link>
      </footer>
    </div>
  )
}
