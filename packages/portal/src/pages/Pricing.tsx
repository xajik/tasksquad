import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
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
  'Task inbox with threaded replies',
  'Live session streaming',
  'Claude Code integration',
]

const PRO_FEATURES = [
  'Everything in Free',
  'Unlimited projects',
  'Unlimited members per project',
  'Unlimited agents',
  '2-second task polling (vs 5s on Free)',
  'Browser push notifications for task updates',
  'Priority support',
]

export default function Pricing() {
  const nav = useNavigate()

  return (
    <div className="min-h-screen bg-background">
      <nav className="max-w-[800px] mx-auto px-4 sm:px-6 py-5 flex justify-between items-center">
        <button onClick={() => nav('/')} className="font-bold text-xl">TaskSquad</button>
        <div className="flex gap-6 items-center">
          <Button variant="ghost" onClick={() => nav('/pricing')}>Pricing</Button>
          <Button onClick={() => nav('/auth')}>Sign in</Button>
        </div>
      </nav>

      <div className="max-w-[800px] mx-auto px-4 sm:px-6 py-10 sm:py-16 text-center">
        <h1 className="text-4xl font-bold mb-4">Simple, honest pricing</h1>
        <p className="text-muted-foreground text-lg mb-16">Start free. Upgrade when you need more.</p>

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
              <Button className="w-full" onClick={() => nav('/auth')}>Get started free</Button>
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
              <Button className="w-full" onClick={() => nav('/auth')}>Get started</Button>
              <p className="text-xs text-muted-foreground text-center w-full">
                Contact us at{' '}
                <a href="mailto:contact@tasksquad.ai" className="underline">hello@tasksquad.ai</a>
                {' '}to activate Pro
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>

      <div className="max-w-[800px] mx-auto px-4 sm:px-6 pb-12 border-t pt-10 text-muted-foreground text-sm">
        © 2026 TaskSquad
      </div>
    </div>
  )
}
