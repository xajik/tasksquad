# TaskSquad: Product Hunt launch kit

**Positioning:** one secure place to manage many AI projects with your team, across a distributed set of machines.

Every security claim below was checked against the code (see "Claim sources" at the bottom). **Never** claim SOC 2, end-to-end encryption, zero-knowledge, self-hosting, or any compliance certification. None of them are true today.

---

## 1. Listing copy

**Vision:** AI agents are the newest members of the team. TaskSquad is the secure, shared space where agents and
people work together: bring any harness (even your own) and your own servers, see what every agent is doing,
govern access, learn together, plan the creative work, and track execution with analytics.

**Launch name** (limit 40 characters): **TaskSquad: where AI & team works** (32 chars)
Alternative: "TaskSquad: where AI & teams work" (32 chars), which is grammatically cleaner.

**Tagline** (limit 60 characters):

| # | Tagline | Chars |
|---|---|---|
| ⭐ Primary | One creative workspace for teams and agents | 43 |
| Alt A | Where AI agents and your team build together | 44 |
| Alt B | Bring any agent. See everything. Build together. | 48 |
| Alt C | Your agents, your servers, one shared workspace | 47 |
| Alt D | Observe, govern and grow your AI agents as a team | 49 |

**Description** (limit 260 characters):

> TaskSquad is the creative workspace where your team and AI agents build together. Bring any harness, even your own, on your own machines. Watch agents work live, govern who runs what, learn as a team, and track every run with analytics.

(236 chars)

**Topics:** Artificial Intelligence · Developer Tools · Productivity · Team Collaboration

**Links:**
- Website: https://tasksquad.ai
- Product tour: https://tasksquad.ai/demo
- GitHub: https://github.com/xajik/tasksquad
- Docs: https://tasksquad.ai/docs

**Pricing on PH:** Free (paid plans available)

**Launch offer:** 3 months of Pro free. Email contact@tasksquad.ai with code `PRODUCTHUNT`. This is already wired into the site behind `PH_LAUNCH_ACTIVE` in `packages/portal/src/lib/launch.ts`.

---

## 2. Maker's first comment

> Hey Product Hunt 👋
>
> AI agents are becoming real teammates, but today they work alone. Claude Code on one laptop, Codex on a build
> server, a homegrown agent in a container. Nobody sees what they're doing, nothing they learn gets shared, and
> nobody can say who is allowed to run what.
>
> **TaskSquad is the workspace where agents and people finally work together.**
>
> 🧩 **Bring your own harness.** Claude Code, Codex, Gemini, OpenCode, Pi, or the agent you built yourself. If it
> runs in a terminal, it can join the squad.
>
> 🖥 **Bring your own servers.** Agents run on your laptops, workstations and servers. Your repo is never uploaded,
> and model API keys stay on your machines.
>
> 👀 **See everything.** Live output, every tool call, and full transcripts. When an agent goes quiet, a Supervisor
> inspects its terminal and unblocks it or escalates.
>
> 🛡 **Governance built in.** Owner, Maintainer and Member roles, transcripts encrypted before upload, and hashed,
> expiring daemon tokens.
>
> ✍️ **Create together.** Write specs in shared Notes, get an agent's critique, and send the note to the inbox as a
> task. Split big goals into phases across agents with the Planner.
>
> 🧠 **Learn together.** After every task, agents save team memory and reusable skills, and the whole squad gets them.
>
> 📊 **Track execution.** Analytics for outcomes, time to done, tool calls, tokens and feedback, per agent.
>
> Take the 2-minute tour at tasksquad.ai/demo, or install with `brew tap xajik/tap && brew install tsq`.
>
> 🎁 **For the PH community: 3 months of Pro free.** Email contact@tasksquad.ai with code `PRODUCTHUNT`.
>
> One question for you: **what's the first agent you'd bring to your squad?** I'll be here all day.

---

## 3. Gallery posters

Posters are generated from `launch/media/src/scenes.html` by `launch/media/render.sh` (headless Chrome, about 10 s).
They use the product design system: light surfaces, ink `#0F1117`, accent `#2563EB` and DM Sans. Every product
screenshot comes from the sample **orbit-web** workspace (the `orbit-web` project in the production Demo team) and is labeled "Sample workspace".
Screenshot sources are in `launch/media/shots/`, and the content-only crops in `launch/media/shots/crop/`.

| Order | File (`launch/media/gallery/`) | What it shows |
|---|---|---|
| Thumbnail | `thumbnail.png` (240×240) | Logo on accent |
| 1 · Feature graphic | `01.png` | Tagline, supported agents, inbox and thread, "Secure, open, observable" card |
| 2 | `02.png` | Inbox thread: prompt, tool calls, agent reply |
| 3 | `03.png` | Bring your own harness and servers: daemons on Mac, Linux and Windows (WSL) feeding one inbox |
| 4 | `04.png` | Security boundary: what stays local and what reaches the cloud |
| 5 | `05.png` | Planner: phases, harness and sub-agent per phase, approvals |
| 6 | `06.png` | Supervisor: a resolved verdict with what it found and did |
| 7 | `07.png` | Notes: spec with teammate comment and agent critique |
| 8 | `08.png` | Memory and skills by category and tag |
| 9 | `09.png` | Observability and analytics: outcomes, tokens, tool calls, feedback |
| 10 | `10.png` | Get started: install commands, 3 steps, supported agents |
| Overview A | `bento-1.png` | **Run the work:** Inbox, Supervisor, Portals, Conveyor |
| Overview B | `bento-2.png` | **Grow the squad:** Agents, Notes, Memory, Skills |
| Overview C | `bento-3.png` | **Run it your way:** Collaboration, bring your own agents and machines, infrastructure, analytics, security |
| OG | `og-image.png` (1200×630), also copied to `packages/portal/public/og-image.png` | Link preview |
| Social | `../out/teaser-1600x900.png`, `../out/teaser-1080x1080.png` | "Launching on Product Hunt" posts |

All posters are 1270×760, Product Hunt's gallery size. The three overview posters (`bento-1..3`) each cover several features at once. They work well right after the feature graphic, or as a short gallery of their own (01 → bento-1 → bento-2 → bento-3 → 10). Every window in the overview posters is a real screenshot of the sample workspace. The one exception is the infrastructure diagram on `bento-3`, drawn in the same style as poster 04. The Conveyor and Agents captures had the stray "0" text removed in the page before capture, which matches the fix in `Conveyor.tsx` / `Dashboard.tsx` that ships with the next portal deploy. The same posters are served as a product tour at https://tasksquad.ai/demo (`packages/portal/src/pages/Demo.tsx`, images in `packages/portal/public/demo/`). After changing posters, run `launch/media/render.sh`, then `SHARP_DIR=<folder with sharp installed> bun launch/media/convert-web.mjs`. The analytics numbers are sample data, so never quote them
as real usage.

## 4. FAQ and replies to likely comments

**"Is my code sent to your servers?"**
Your repo is never uploaded. Agents run on your machine inside the `work_dir` you configure. TaskSquad gets task metadata, thread messages, and the agent transcript. Be upfront that the transcript and agent replies can include code snippets the agent read or wrote; the transcript is AES-256-GCM encrypted by the daemon before upload. Your model API keys never touch TaskSquad.

**"How is this different from just running Claude Code myself?"**
It's the same Claude Code, unchanged. TaskSquad adds the team layer around it: a shared inbox across projects and machines, assigning work to agents *or* people, watching and steering from any browser (including your phone), supervision when a task goes quiet, and shared memory and skills, so each agent benefits from what the others learned.

**"Can I self-host?"**
Not today. The coordination layer runs on Cloudflare. Execution is already local, which is the part that touches your code. Tell us if self-hosting is a blocker for you; it helps us prioritize.

**"Which agents are supported?"**
Claude Code, Codex, Gemini CLI, OpenCode and Pi out of the box, plus any CLI that writes to stdout. OpenClaw is coming soon.

**"Windows?"**
Yes, through WSL. The daemon drives agents through tmux, so it needs a tmux-compatible environment. macOS and Linux work natively, and there's also a native macOS menu-bar app (DMG).

**"Why tmux?"**
It gives every task a real, persistent terminal session. Agents keep their full interactive TUI, sessions survive daemon restarts, and you can attach locally or open a live browser terminal (Portal) into the exact same session.

**"How do you stop one teammate's agent from being used by someone else?"**
Agents belong to a team. Only Owners and Maintainers can create agents and issue tokens, and the API rejects requests for any agent outside the caller's teams. Tokens are hashed at rest and expire after 90 days, and deleting an agent revokes them.

**"Pricing?"**
Free covers up to 3 projects × 3 agents × 5 members. Pro is $29/mo for 10 projects, 10 agents each, 5-second polling, and live terminal Portals. PH launch: 3 months of Pro free with code `PRODUCTHUNT`.

---

## 5. Launch checklist

### T-7 days
- [ ] Find a hunter, or self-hunt. Schedule the launch on a **Tuesday–Thursday**.
- [ ] Create the PH draft: name, tagline, description, topics, links, posters 1–10, thumbnail.
- [ ] Post `teaser-1600x900.png` on X and LinkedIn: "Launching on Product Hunt on <date>".
- [ ] Line up supporters with a personal message, not a mass DM. Ask for honest feedback, never upvotes. Asking for upvotes violates PH rules.

### T-1 day
- [ ] Merge and deploy the portal changes. Confirm https://tasksquad.ai shows the new hero, the "Secure by design" section, and the "Take the product tour" link to /demo.
- [ ] Check https://tasksquad.ai/og-image.png loads, and test the preview card with opengraph.xyz or the X card validator.
- [ ] Check https://tasksquad.ai/pricing shows the PH offer under Pro.
- [ ] Run a fresh-machine install: `brew tap xajik/tap && brew install tsq`, `curl -sSL install.tasksquad.ai | bash`, and the macOS DMG download.
- [ ] Make sure contact@tasksquad.ai is monitored, with a ready reply for `PRODUCTHUNT` Pro activations.

### Launch day (posts go live at 12:01 AM PT)
- [ ] Publish, then immediately post the **maker's first comment** (§2).
- [ ] Uncomment the PH badge in `README.md`.
- [ ] Share on X, LinkedIn and relevant communities, with the teaser images or posters 1, 4 and 5.
- [ ] Reply to **every** comment within about 30 minutes, using §4 as a base and personalizing each reply.
- [ ] Watch the `cta_clicked` analytics events: `get_started_free`, `product_tour`, `download_macos`.

### T+1 to T+7
- [ ] Thank-you post with results and learnings.
- [ ] Activate every Pro request that came in.
- [ ] Set `PH_LAUNCH_ACTIVE = false` once the offer window closes, and deploy.

---

## Claim sources (keep copy honest)

| Claim | Where it's true in code |
|---|---|
| Agents execute locally in a chosen `work_dir`; the repo itself is never uploaded (transcripts and replies may contain excerpts) | daemon `agent/`, `~/.tasksquad/config.toml` |
| Supervisor inspects quiet tasks and posts a diagnosis | `packages/daemon/supervisor/`, README "Supervisor" |
| Agents extract reusable Skills after tasks | `tsq-end-session-learning` skill, README "Skills & Learning" |
| Transcripts AES-256-GCM encrypted by the daemon before upload, per-agent DEK wrapped by a master key | `packages/daemon/api/crypto.go`, `packages/daemon/upload/uploader.go`, `packages/worker/src/crypto.ts`, `agents.encrypted_dek` |
| Daemon (`tsq_cli_*`) tokens hashed (SHA-256), 90-day expiry, revocable; credentials in OS keychain | `mintCliToken` / `withUserTokenAuth` in `packages/worker/src/auth.ts` |
| Daemon credentials in the OS keychain | `packages/daemon/auth/keychain.go` |
| API rejects agents outside the caller's teams | `withDaemonAgentAuth` in `packages/worker/src/auth.ts` |
| Owner / Maintainer / Member roles | `packages/worker/src/routes/teams.ts` |
| Single-use, 60 s terminal tickets | `POST /terminal/ticket`, `docs/concepts/security.md` |
| Windows needs WSL | `packages/daemon/README.md` |
