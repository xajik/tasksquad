import { ArrowRight, User, Bot, Loader2, Lightbulb, Upload, Share2 } from 'lucide-react'

export function SkillWorkflow() {
  const stages = [
    { icon: User, label: 'User task', color: 'bg-blue-500/10 text-blue-500' },
    { icon: Bot, label: 'Agent', color: 'bg-purple-500/10 text-purple-500' },
    { icon: Loader2, label: 'Grinding', color: 'bg-orange-500/10 text-orange-500', animate: 'animate-spin' },
    { icon: Lightbulb, label: 'Learning', color: 'bg-yellow-500/10 text-yellow-500' },
    { icon: Upload, label: 'Upload skills', color: 'bg-green-500/10 text-green-500' },
    { icon: Share2, label: 'User share', color: 'bg-pink-500/10 text-pink-500' },
  ]

  return (
    <div className="w-full py-8 overflow-x-auto no-scrollbar">
      <div className="flex items-center justify-between min-w-[700px] px-4 md:min-w-0 md:justify-around">
        {stages.map((stage, idx) => (
          <div key={idx} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-3 relative group">
              <div className={`p-4 rounded-xl ${stage.color} border border-current/20 transition-all group-hover:scale-110 group-hover:shadow-md`}>
                <stage.icon className={`h-6 w-6 ${stage.animate || ''}`} />
              </div>
              <span className="text-[10px] font-bold whitespace-nowrap text-muted-foreground uppercase tracking-tighter">
                {stage.label}
              </span>
            </div>
            {idx < stages.length - 1 && (
              <div className="flex-1 flex justify-center px-2">
                <ArrowRight className="h-4 w-4 text-muted-foreground/30" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
