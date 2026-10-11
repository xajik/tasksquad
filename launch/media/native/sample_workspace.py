"""Writes sample-workspace.json: the "orbit-web" sample workspace from the web launch shots, as Worker
API records. The iOS contract fixture (`workspace_fixture.py --seed`) and the macOS promo render test
(`TSQ_PROMO_SEED`) serve it so the native apps render the same project as the web screenshots.
Timestamps are relative to now, so regenerate right before capturing: launch/media/native/capture.sh."""
import json, sys, time
from pathlib import Path

NOW = int(time.time() * 1000)
MIN = 60_000
def ago(minutes): return NOW - minutes * MIN

AGENTS = [
    dict(id='claude', name='claude-code', status='online', description='Full-stack engineer — owns the web app', last_seen=ago(1)),
    dict(id='codex', name='codex', status='online', description='Backend & API — billing, sync, migrations', last_seen=ago(1)),
    dict(id='gemini', name='gemini', status='online', description='Docs & research — release notes, specs, digests', last_seen=ago(2)),
    dict(id='pi', name='pi', status='online', description='Code reviewer — runs on a local model', last_seen=ago(3)),
]

def task(id, subject, agent, status, minutes, **extra):
    return dict(id=id, team_id='orbit', agent_id=agent, subject=subject, status=status, created_at=ago(minutes),
                sender_id='me', first_message_role='user', first_message_type='user', **extra)

TASKS = [
    task('t-openapi', 'Add OpenAPI docs for /v1/availability', 'codex', 'pending', 4),
    task('t-heatmap', 'Build the team availability heatmap UI', 'claude', 'running', 25),
    task('t-cents', 'Migrate invoices.amount to integer cents', 'codex', 'running', 40),
    task('t-release', 'Draft the v2.4 release notes from merged PRs', 'gemini', 'waiting_input', 62),
    task('t-ratelimit', 'Add rate limiting to the public booking API', 'claude', 'done', 180),
    task('t-pr482', 'Review PR #482: calendar sync retry logic', 'pi', 'done', 300),
    task('t-react19', 'Upgrade web app to React 19 and fix type errors', 'claude', 'done', 420),
    task('t-flaky', 'Fix flaky e2e test: checkout › applies coupon', 'codex', 'done', 610,
         supervisor_report_count=1, last_supervisor_at=ago(560)),
    task('t-digest', 'Weekly dependency & CVE audit', 'codex', 'failed', 900),
]

def msg(id, role, body, minutes, **extra): return dict(id=id, role=role, body=body, created_at=ago(minutes), attachments=[], **extra)

MESSAGES = {
    't-ratelimit': [
        msg('m1', 'user', 'Our public booking endpoint (POST /v1/bookings) got hammered by a scraper last night. Add per-API-key rate limiting: 60 requests/minute, burst of 10. Keep it in the existing middleware stack and add tests.', 186),
        msg('m2', 'agent', 'Rate limiting is live for `POST /v1/bookings`.\n\n**What changed**\n- 60 requests/min with a burst of 10; limits live in `config/limits.ts` so ops can tune them.\n- Token bucket per API key, falling back to client IP for anonymous calls.\n- Over-limit requests get `429` with a JSON error body.\n\n**Tests**\n- 6 new tests in `rateLimit.test.ts` (burst, refill, per-key isolation, IP fallback).\n- Full API suite: 41 passed, 0 failed.', 174),
        msg('m3', 'user', 'Nice. Can you also return a `Retry-After` header on 429s? Our SDK already respects it.', 170),
        msg('m4', 'agent', 'Done — 429 responses now include `Retry-After` (seconds until the next token is available), and I added a test asserting it. Suite: **42 passed, 0 failed**. Ready to close.', 165),
    ],
    't-release': [
        msg('r1', 'user', 'Draft the v2.4 release notes from the PRs merged since v2.3. Group by Features, Fixes, Internal. Keep it customer-facing.', 66),
        msg('r2', 'agent', '## v2.4 — draft\n\n**Features**\n- Team availability heatmap (beta)\n- Per-key rate limits on the public booking API\n\n**Fixes**\n- Calendar sync retries no longer drop events after a 503\n- Coupon codes apply correctly at checkout\n\nShould I mention the React 19 upgrade, or keep internal changes out?', 58),
    ],
    't-heatmap': [
        msg('h1', 'user', 'Build the heatmap UI from the spec in Notes. Week view, 30-minute cells, hover shows who is free.', 25),
        msg('h2', 'agent', 'Working on it. `AvailabilityHeatmap.tsx` renders the week grid and pulls `GET /v1/teams/:id/availability`. Next: hover popover and the empty-hours hatch from the spec review.', 9),
    ],
}

def note(id, title, content, tags, days):
    return dict(id=id, title=title, content=content, tags=tags, created_at=ago(days * 1440), updated_at=ago(days * 1440), author_id='me')

NOTES = [
    note('n-spec', 'Spec: Team availability heatmap', '# Team availability heatmap\n\n## Problem\nTeam admins can\'t see at a glance when their team is actually bookable. Today they open each member\'s calendar.\n\n## Proposal\nA week view (Mon–Sun × 07:00–20:00) where each cell\'s color = % of team members free in that 30-minute slot.\n\n- Hover a cell → list of who is free / busy\n- Click a cell → pre-fill "New team booking" for that slot\n- Respects each member\'s working hours and timezone\n\n## API\n`GET /v1/teams/:id/availability?week=2026-W42`\n\n## Out of scope\n- Room/resource availability\n- Editing other people\'s calendars', ['spec', 'frontend'], 2),
    note('n-q4', 'Q4 reliability plan', '# Q4 reliability plan\n\n**Goal:** 99.95% monthly availability for the public API (currently 99.87%).\n\n## Top 3 risks\n1. Calendar sync backlog under provider outages\n2. Unbounded scraper traffic on booking endpoints\n3. Single-region database failover', ['planning', 'backend'], 7),
    note('n-postmortem', 'Postmortem: calendar sync backlog', '# Postmortem — calendar sync backlog, 2026-10-03\n\n**Impact:** 41 minutes of delayed calendar updates for ~9% of teams.\n\n**Root cause:** retries without jitter amplified a provider 503 storm.', ['calendar-sync', 'incident'], 8),
    note('n-onboarding', 'Onboarding wizard copy v3', '# Onboarding wizard — copy v3\n\n**Step 1 — Welcome:** "Let\'s get your team bookable in under 2 minutes."\n\n**Step 2 — Working hours:** "When are you usually available?"', ['customers', 'frontend'], 13),
]
COMMENTS = {'n-spec': [
    dict(id='c1', author_id='priya', author_email='priya@orbit.example', content='Can we use the existing color scale from the analytics page so it matches?', created_at=ago(2900)),
    dict(id='c2', author_id='pi', agent_id='pi', author_type='agent', content='Critique: the spec does not say what happens for members with no working hours set. Suggest treating them as "unknown" (hatched cell) rather than free, otherwise the heatmap overstates availability.', created_at=ago(2880)),
]}

PLANNERS = [dict(id='p-heatmap', title='Ship team availability heatmap', description='From spec to production: API, UI, tests, review.',
                 status='running', created_at=ago(2900), max_retries=3, phases=[
    dict(phase_id='ph1', name='Write technical spec', status='completed', agent_id='gemini', retry_count=0, max_retries=3, user_verdict='up', last_response='Spec written and linked in Notes: "Spec: Team availability heatmap".'),
    dict(phase_id='ph2', name='Implement availability API', status='completed', agent_id='codex', sub_agent='api-designer', retry_count=0, max_retries=3, user_verdict='up', last_response='GET /v1/teams/:id/availability merged in #486 with 14 tests.'),
    dict(phase_id='ph3', name='Build heatmap UI', status='in_progress', agent_id='claude', sub_agent='frontend-reviewer', task_id='t-heatmap', retry_count=0, max_retries=3),
    dict(phase_id='ph4', name='Review and release', status='pending', agent_id='pi', retry_count=0, max_retries=3),
])]

def conveyor(id, title, agent, frequency, hour, minute, runs, next_hours, **extra):
    return dict(id=id, title=title, agent_id=agent, frequency=frequency, hour=hour, minute=minute, timezone='Europe/Berlin',
                repeat_counter=runs, next_run_at=NOW + next_hours * 60 * MIN, created_at=ago(40 * 1440), paused=False,
                body=title, auto_close=True, **extra)

CONVEYORS = [
    conveyor('cv-cost', 'Monthly cost & usage report', 'gemini', 'monthly', 10, 0, 13, 400, day_of_month=1),
    conveyor('cv-flaky', 'Nightly flaky-test triage', 'claude', 'daily', 2, 0, 17, 9),
    conveyor('cv-cve', 'Weekly dependency & CVE audit', 'codex', 'weekly', 8, 30, 19, 70, day_of_week=1),
]

PORTALS = [
    dict(id='po-claude', team_id='orbit', agent_id='claude', status='running', session_id='orbit-claude-session', created_at=ago(12)),
    dict(id='po-codex', team_id='orbit', agent_id='codex', status='done', created_at=ago(360), completed_at=ago(330)),
    dict(id='po-pi', team_id='orbit', agent_id='pi', status='done', created_at=ago(1440 * 2), completed_at=ago(1440 * 2 - 25)),
]

SKILLS = [dict(id='s-review', name='frontend-review', description='Checks accessibility, bundle size and visual regressions before merge.', category='review', auto_install=1, created_at=ago(9000)),
          dict(id='s-release', name='release-notes', description='Turns merged PRs into customer-facing release notes.', category='docs', auto_install=1, created_at=ago(8000)),
          dict(id='s-migrate', name='safe-migrations', description='Writes reversible D1 migrations with a backfill plan.', category='backend', auto_install=0, created_at=ago(7000))]
SUB_AGENTS = [dict(id='sa-api', name='api-designer', description='Designs REST endpoints and OpenAPI specs.', created_at=ago(9000)),
              dict(id='sa-fe', name='frontend-reviewer', description='Reviews React components against the design system.', created_at=ago(9000))]
MEMORY = [dict(id='mem-1', title='Rate limits live in config/limits.ts', content='Ops tune limits there; never hard-code them in middleware.', tags=['backend'], created_at=ago(170)),
          dict(id='mem-2', title='Calendar sync retries need jitter', content='Exponential backoff with full jitter after the 2026-10-03 incident.', tags=['calendar-sync'], created_at=ago(8 * 1440)),
          dict(id='mem-3', title='Run bun test src/api before closing API tasks', content='The suite takes ~3s and catches middleware regressions.', tags=['testing'], created_at=ago(3 * 1440))]
MEMBERS = [dict(id='me', email='alex@orbit.example', role='owner', created_at=ago(60 * 1440)),
           dict(id='priya', email='priya@orbit.example', role='maintainer', created_at=ago(50 * 1440)),
           dict(id='sam', email='sam@orbit.example', role='member', created_at=ago(20 * 1440))]

def stats():
    daily, pattern = [], [(1, 0), (0, 1), (1, 0), (1, 0), (1, 0), (0, 0), (1, 0), (1, 0), (1, 0), (2, 0), (1, 0), (1, 0), (1, 0), (2, 0), (0, 0), (0, 1), (1, 0), (1, 0), (2, 0), (1, 0), (1, 0), (3, 1), (4, 0)]
    for i, (done, failed) in enumerate(pattern):
        day = time.strftime('%Y-%m-%d', time.gmtime((NOW - (len(pattern) - 1 - i) * 86_400_000) / 1000))
        daily.append(dict(date=day, created=done + failed, done=done, failed=failed))
    agents = [dict(agent_id=a, name=n, tasks=t, started=t, done=d, failed=f, cancelled=0, in_progress=p, success_rate=d / max(d + f, 1),
                   median_completion_ms=m, grades_up=u, grades_down=g, sessions_reported=s, active_ms=s * 1_500_000, turns=s * 3,
                   input_tokens=s * 38_000, output_tokens=s * 5_000, tool_calls=s * 13, tool_errors=e)
              for a, n, t, d, f, p, m, u, g, s, e in [('claude', 'claude-code', 13, 10, 1, 2, 1_380_000, 5, 1, 12, 1),
                                                      ('codex', 'codex', 10, 8, 1, 1, 1_620_000, 3, 0, 9, 1),
                                                      ('gemini', 'gemini', 5, 4, 0, 1, 840_000, 1, 1, 4, 0),
                                                      ('pi', 'pi', 3, 2, 1, 0, 1_100_000, 1, 0, 2, 0)]]
    return dict(range=dict(from_=ago(30 * 1440), to=NOW), totals=dict(created=31, started=30, done=24, failed=3, cancelled=0, in_progress=4, scheduled=1,
                grades_up=10, grades_down=2, success_rate=0.889, median_completion_ms=1_410_000), daily=daily,
                usage=dict(sessions_reported=27, active_ms=41_880_000, turns=81, input_tokens=1_000_000, output_tokens=136_600, cache_read_tokens=0,
                           cache_write_tokens=0, tool_calls=356, tool_errors=2, models=[dict(name='claude-opus', sessions=12), dict(name='gpt-5-codex', sessions=9)]),
                tools=[dict(name=n, count=c) for n, c in [('Bash', 132), ('Read', 98), ('Edit', 61), ('Grep', 38), ('Write', 27)]],
                skills=[dict(name=n, count=c) for n, c in [('tsq-end-session-learning', 27), ('frontend-review', 11), ('release-notes', 4)]],
                agents=agents)

def workspace():
    s = stats(); s['range']['from'] = s['range'].pop('from_')
    return dict(
        me=dict(id='me', email='alex@orbit.example', plan='pro'),
        teams=[dict(id='orbit', name='orbit-web', role='owner', memory_enabled=True)],
        agents=AGENTS, tasks=TASKS, messages=MESSAGES, portals=PORTALS, stats=s, comments=COMMENTS,
        resources=dict(notes=NOTES, planners=PLANNERS, conveyors=CONVEYORS, skills=SKILLS, sub_agents=SUB_AGENTS,
                       commands=[], memory=MEMORY, members=MEMBERS),
    )

if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name('sample-workspace.json'))
    out.write_text(json.dumps(workspace(), ensure_ascii=False, indent=1))
    print(out)
