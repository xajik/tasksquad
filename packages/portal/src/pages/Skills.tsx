import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type Skill, type SubAgent, type Member } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Loader2, Plus, BookOpen, Zap, RefreshCw, Bot } from 'lucide-react'
import { SkillWorkflow } from '../components/SkillWorkflow'
import { SubAgentWorkflow } from '../components/SubAgentWorkflow'
import { HowItWorks, HowItWorksToggle } from '../components/HowItWorks'
import { SkillCard, SkillDetail } from '../components/SkillPanel'
import { SubAgentCard, SubAgentDetail } from '../components/SubAgentPanel'
import { SkillCreateForm } from '../components/SkillCreateForm'
import { SubAgentCreateForm } from '../components/SubAgentCreateForm'

type Tab = 'skills' | 'sub-agents'

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
}

function EmptyState({ icon: Icon, primary, secondary }: { icon: React.ElementType; primary: string; secondary: string }) {
  return (
    <div className="text-center text-muted-foreground py-12">
      <Icon className="h-8 w-8 mx-auto mb-3 opacity-40" />
      <p className="text-sm">{primary}</p>
      <p className="text-xs mt-1">{secondary}</p>
    </div>
  )
}

export function Skills({ teamId }: { teamId: string }) {
  const [tab, setTab] = useState<Tab>('skills')
  const [skills, setSkills] = useState<Skill[]>([])
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [members, setMembers] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<SubAgent | null>(null)
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [autoInstallFilter, setAutoInstallFilter] = useState<boolean | null>(null)
  const [showCreateSkill, setShowCreateSkill] = useState(false)
  const [showCreateAgent, setShowCreateAgent] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [skillsData, agentsData, membersData] = await Promise.all([
        api.skills.list(teamId),
        api.subAgents.list(teamId).catch(() => ({ sub_agents: [] as SubAgent[] })),
        api.members.list(teamId).catch(() => ({ members: [] as Member[] })),
      ])
      setSkills(skillsData.skills ?? [])
      setSubAgents(agentsData.sub_agents ?? [])
      const map = new Map<string, string>()
      for (const m of membersData.members ?? []) map.set(m.id, m.email)
      setMembers(map)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  function switchTab(t: Tab) {
    setTab(t)
    setSelectedSkill(null)
    setSelectedAgent(null)
    setShowCreateSkill(false)
    setShowCreateAgent(false)
    setAutoInstallFilter(null)
  }

  async function handleDeleteSkill(skill: Skill) {
    await api.skills.delete(teamId, skill.id)
    if (selectedSkill?.id === skill.id) setSelectedSkill(null)
    load()
  }

  async function handleDeleteAgent(agent: SubAgent) {
    await api.subAgents.delete(teamId, agent.id)
    if (selectedAgent?.id === agent.id) setSelectedAgent(null)
    load()
  }

  async function handleCreateSkill(fields: { name: string; desc: string; content: string; autoInstall: boolean }) {
    setSkillError(null)
    try {
      await api.skills.create(teamId, { name: fields.name, description: fields.desc, content: fields.content, auto_install: fields.autoInstall })
      setShowCreateSkill(false)
      load()
    } catch (err: unknown) {
      setSkillError(err && typeof err === 'object' && 'error' in err ? String((err as { error: unknown }).error) : 'Failed to create skill')
      throw err
    }
  }

  async function handleCreateAgent(fields: { name: string; desc: string; content: string; autoInstall: boolean }) {
    setAgentError(null)
    try {
      await api.subAgents.create(teamId, { name: fields.name, description: fields.desc, content: fields.content, auto_install: fields.autoInstall })
      setShowCreateAgent(false)
      load()
    } catch (err: unknown) {
      setAgentError(err && typeof err === 'object' && 'error' in err ? String((err as { error: unknown }).error) : 'Failed to create sub-agent')
      throw err
    }
  }

  const filteredSkills = useMemo(() =>
    autoInstallFilter === null ? skills : skills.filter(s => !!s.auto_install === autoInstallFilter),
    [skills, autoInstallFilter]
  )
  const filteredAgents = useMemo(() =>
    autoInstallFilter === null ? subAgents : subAgents.filter(a => !!a.auto_install === autoInstallFilter),
    [subAgents, autoInstallFilter]
  )

  const hasDetail = selectedSkill !== null || selectedAgent !== null

  return (
    <div className="flex h-full">
      <div className={`flex flex-col ${hasDetail ? 'w-1/2 border-r' : 'w-full'} overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1.5">
            <h2 className="text-2xl font-semibold">Skills & Sub-agents</h2>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={load} disabled={loading} title="Refresh">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <Button size="sm" onClick={() => tab === 'skills' ? setShowCreateSkill(true) : setShowCreateAgent(true)}>
            <Plus className="h-4 w-4 mr-1" /> New {tab === 'skills' ? 'Skill' : 'Sub-agent'}
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 p-1 bg-muted rounded-lg w-fit">
          {([['skills', BookOpen, 'Skills', skills.length], ['sub-agents', Bot, 'Sub-agents', subAgents.length]] as const).map(([id, Icon, label, count]) => (
            <button key={id} onClick={() => switchTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>

        {/* How it works - skills */}
        {tab === 'skills' && (
          <div className="mb-4">
            <HowItWorksToggle show={showHowItWorks} onToggle={() => setShowHowItWorks(v => !v)} />
            {showHowItWorks && (
              <HowItWorks title="Autonomous Learning Loop" icon={Zap} docsLink="/docs/concepts/skills" docsLabel="Full Documentation" className="mt-2" text={
                <p>
                  TaskSquad agents automatically learn new skills by analyzing completed tasks.
                  Skills prefixed with <code className="text-primary font-mono font-bold px-1 py-0.5 bg-primary/5 rounded">tsq-</code> are
                  extracted and shared back to your team, where you can enable auto-install for all agents.
                </p>
              }>
                <SkillWorkflow />
              </HowItWorks>
            )}
          </div>
        )}

        {/* How it works - sub-agents */}
        {tab === 'sub-agents' && (
          <div className="mb-4">
            <HowItWorksToggle show={showHowItWorks} onToggle={() => setShowHowItWorks(v => !v)} />
            {showHowItWorks && (
              <HowItWorks title="Sub-agent Sync Flow" icon={Bot} docsLink="/docs" className="mt-2" text={
                <p>
                  Sub-agents are specialized AI agents synced to{' '}
                  <code className="text-primary font-mono font-bold px-1 py-0.5 bg-primary/5 rounded">.claude/agents/</code> on each machine.
                  They are invoked by name during tasks to handle specific workflows. Enable auto-install to share across all agents.
                </p>
              }>
                <SubAgentWorkflow />
              </HowItWorks>
            )}
          </div>
        )}

        {/* Filter */}
        <div className="flex items-center gap-1.5 mb-4 shrink-0">
          <Button variant={autoInstallFilter === null ? 'default' : 'outline'} size="sm" onClick={() => setAutoInstallFilter(null)} className="h-7 rounded-full px-3 text-xs">All</Button>
          <Button variant={autoInstallFilter === true ? 'default' : 'outline'} size="sm" onClick={() => setAutoInstallFilter(f => f === true ? null : true)} className="h-7 rounded-full px-3 text-xs">
            <Zap className="h-3 w-3 mr-1" /> Auto-install
          </Button>
        </div>

        {tab === 'skills' && showCreateSkill && <SkillCreateForm onSubmit={handleCreateSkill} onCancel={() => setShowCreateSkill(false)} error={skillError} />}
        {tab === 'sub-agents' && showCreateAgent && <SubAgentCreateForm onSubmit={handleCreateAgent} onCancel={() => setShowCreateAgent(false)} error={agentError} />}

        {/* Grid */}
        <div className="flex-1 overflow-auto p-6 pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : tab === 'skills' ? (
            filteredSkills.length === 0
              ? <EmptyState icon={BookOpen} primary={autoInstallFilter ? 'No auto-install skills.' : 'No skills yet.'} secondary="Agents automatically create skills as they learn." />
              : <Grid>{filteredSkills.map(s => (
                  <SkillCard key={s.id} skill={s} members={members}
                    onClick={() => { setSelectedSkill(s); setSelectedAgent(null) }}
                    onDelete={() => handleDeleteSkill(s)}
                    onToggleAutoInstall={async () => { await api.skills.update(teamId, s.id, { auto_install: !s.auto_install }); load() }}
                  />
                ))}</Grid>
          ) : (
            filteredAgents.length === 0
              ? <EmptyState icon={Bot} primary={autoInstallFilter ? 'No auto-install sub-agents.' : 'No sub-agents yet.'} secondary="Sub-agents are synced to .claude/agents/ on each machine." />
              : <Grid>{filteredAgents.map(a => (
                  <SubAgentCard key={a.id} agent={a} members={members}
                    onClick={() => { setSelectedAgent(a); setSelectedSkill(null) }}
                    onDelete={() => handleDeleteAgent(a)}
                    onToggleAutoInstall={async () => { await api.subAgents.update(teamId, a.id, { auto_install: !a.auto_install }); load() }}
                  />
                ))}</Grid>
          )}
        </div>
      </div>

      {selectedSkill && (
        <div className="flex-1 overflow-hidden">
          <SkillDetail key={selectedSkill.id} skill={selectedSkill} teamId={teamId} members={members}
            onClose={() => setSelectedSkill(null)} onSaved={load} onDeleted={() => handleDeleteSkill(selectedSkill)} />
        </div>
      )}
      {selectedAgent && (
        <div className="flex-1 overflow-hidden">
          <SubAgentDetail key={selectedAgent.id} agent={selectedAgent} teamId={teamId} members={members}
            onClose={() => setSelectedAgent(null)} onSaved={load} onDeleted={() => handleDeleteAgent(selectedAgent)} />
        </div>
      )}
    </div>
  )
}
