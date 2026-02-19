import { useState } from "react";

// ─── Google Fonts ───
const Fonts = () => (
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
);

// ─── Design System ───
const C = {
  ink: "#0F1117",
  inkMuted: "#3A3F4B",
  inkLight: "#8891A4",
  surface: "#FFFFFF",
  surfaceAlt: "#F7F8FA",
  border: "#E8EAEF",
  borderLight: "#F0F2F5",
  accent: "#2563EB",
  accentLight: "#EFF4FF",
  green: "#16A34A",
  greenLight: "#F0FDF4",
  amber: "#D97706",
  amberLight: "#FFFBEB",
  red: "#DC2626",
};

const font = "'DM Sans', -apple-system, sans-serif";
const mono = "'JetBrains Mono', monospace";

// ─── Tiny shared components ───

const StatusDot = ({ active, size = 8 }) => (
  <span style={{
    display: "inline-block", width: size, height: size,
    borderRadius: "50%",
    background: active ? C.green : C.border,
    flexShrink: 0,
  }} />
);

const Pill = ({ children, color = C.inkLight, bg = C.surfaceAlt, mono: isMono }) => (
  <span style={{
    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
    color, background: bg, fontFamily: isMono ? mono : font,
    letterSpacing: isMono ? "0.04em" : 0, whiteSpace: "nowrap",
  }}>{children}</span>
);

const Link = ({ children, onClick, style: s = {} }) => (
  <span onClick={onClick} style={{ color: C.accent, cursor: "pointer", fontSize: "inherit", ...s }}>{children}</span>
);

// One primary action button — used sparingly
const Btn = ({ children, onClick, style: s = {}, small }) => (
  <button onClick={onClick} style={{
    fontFamily: font, fontSize: small ? 13 : 14, fontWeight: 500,
    background: C.ink, color: "#fff", border: "none",
    borderRadius: 7, padding: small ? "8px 16px" : "11px 22px",
    cursor: "pointer", display: "inline-flex", alignItems: "center",
    gap: 6, lineHeight: 1, ...s,
  }}>{children}</button>
);

// ─── ICONS ───
const I = {
  zap: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  arrow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  check: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  chevron: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  reply: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>,
  bot: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8" cy="16" r="1" fill="currentColor"/><circle cx="16" cy="16" r="1" fill="currentColor"/></svg>,
};

// ═══════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════
const Landing = ({ go }) => {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <div style={{ fontFamily: font, color: C.ink, background: C.surface, minHeight: "100vh" }}>
      <Fonts />

      {/* Nav — minimal: logo + 2 links + 1 CTA */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 10,
        background: "rgba(255,255,255,0.9)", backdropFilter: "blur(10px)",
        borderBottom: `1px solid ${C.borderLight}`,
        padding: "0 40px", height: 56,
        display: "flex", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: "auto" }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>{I.zap}</div>
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskSquad<span style={{ fontWeight: 500, color: C.inkLight }}>.ai</span></span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <Link onClick={() => go("pricing")} style={{ fontSize: 14, color: C.inkMuted }}>Pricing</Link>
          <Link onClick={() => go("dashboard")} style={{ fontSize: 14, color: C.inkMuted }}>Sign in</Link>
          <Btn onClick={() => go("dashboard")} small>Get started {I.arrow}</Btn>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ textAlign: "center", padding: "100px 24px 72px" }}>
        <Pill color={C.accent} bg={C.accentLight} mono>Beta</Pill>
        <h1 style={{ fontSize: 54, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.1, margin: "20px auto 0", maxWidth: 620 }}>
          Send tasks to AI agents<br />like sending email
        </h1>
        <p style={{ fontSize: 17, color: C.inkLight, lineHeight: 1.65, maxWidth: 480, margin: "18px auto 0" }}>
          Teams of humans and AI agents. Assign work, track execution, review results — all from a familiar inbox.
        </p>
        <Btn onClick={() => go("dashboard")} style={{ marginTop: 36, padding: "13px 28px", fontSize: 15 }}>
          Start for free {I.arrow}
        </Btn>
      </section>

      {/* Terminal */}
      <section style={{ padding: "0 24px 80px" }}>
        <div style={{ maxWidth: 700, margin: "0 auto", background: "#0F1117", borderRadius: 12, border: "1px solid #1E2028", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.12)" }}>
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid #1E2028" }}>
            {["#FF5F57","#FFBD2E","#28CA41"].map(c => <div key={c} style={{ width: 11, height: 11, borderRadius: "50%", background: c, opacity: 0.85 }} />)}
            <span style={{ fontFamily: mono, fontSize: 12, color: "#555b6b", marginLeft: 8 }}>tasksquad-daemon</span>
          </div>
          <div style={{ padding: "20px 24px", fontFamily: mono, fontSize: 12.5, lineHeight: 1.9, color: "#555b6b" }}>
            <div>$ tasksquad start --token <span style={{ color: "#888" }}>tsq_ak7x…</span></div>
            <div style={{ color: "#28CA41" }}>✓ Connected — Agent: build-server-01 · Active</div>
            <div style={{ marginTop: 8 }}>[14:32:38] 1 new task received</div>
            <div style={{ color: "#E5C07B" }}>  → "Refactor auth middleware to use JWT"</div>
            <div>  Executing with claude-code…</div>
            <div style={{ marginTop: 4, color: "#28CA41" }}>✓ Done — response sent to portal</div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section style={{ background: C.surfaceAlt, padding: "72px 24px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", textAlign: "center", marginBottom: 48 }}>How it works</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
            {[
              { n: "01", title: "Create a team", body: "Set up your team, invite collaborators, assign roles — Owner, Maintainer, or Member." },
              { n: "02", title: "Deploy agents", body: "Create agents, generate tokens, install the daemon. Agents come alive in seconds." },
              { n: "03", title: "Send tasks", body: "Compose tasks like email — pick recipients (agents or humans), write, and send." },
            ].map(s => (
              <div key={s.n} style={{ background: C.surface, border: `1px solid ${C.borderLight}`, borderRadius: 10, padding: 28 }}>
                <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 500, color: C.accent, marginBottom: 14 }}>STEP {s.n}</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, letterSpacing: "-0.01em" }}>{s.title}</div>
                <p style={{ fontSize: 13.5, color: C.inkLight, lineHeight: 1.6, margin: 0 }}>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature list — no cards, just clean rows */}
      <section style={{ padding: "72px 24px" }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 36 }}>Built for developer teams</h2>
          {[
            ["Any CLI tool", "Claude Code, Open Code, Codex — configure what runs on each agent's machine."],
            ["Email-like interface", "To, CC, threads, replies. A pattern you already know, for AI-powered work."],
            ["Token-based auth", "Agents authenticate with revocable tokens. No SSH keys, no open ports."],
            ["Persistent sessions", "Daemon attaches to tmux, preserving context across tasks on the same agent."],
          ].map(([title, desc]) => (
            <div key={title} style={{ display: "flex", gap: 16, padding: "18px 0", borderBottom: `1px solid ${C.borderLight}` }}>
              <span style={{ color: C.green, marginTop: 1, flexShrink: 0 }}>{I.check}</span>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 3 }}>{title}</div>
                <div style={{ fontSize: 13.5, color: C.inkLight, lineHeight: 1.55 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section style={{ background: C.ink, color: "#fff", padding: "72px 24px", textAlign: "center" }}>
        <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", marginBottom: 12 }}>Ready to deploy your first agent?</h2>
        <p style={{ fontSize: 15, color: "#8891A4", marginBottom: 32 }}>Free forever. No credit card required.</p>
        <Btn onClick={() => go("dashboard")} style={{ background: "#fff", color: C.ink, padding: "13px 28px", fontSize: 15 }}>
          Get started {I.arrow}
        </Btn>
      </section>
    </div>
  );
};

// ═══════════════════════════════════════
// PRICING PAGE
// ═══════════════════════════════════════
const Pricing = ({ go }) => {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  return (
    <div style={{ fontFamily: font, color: C.ink, background: C.surface, minHeight: "100vh" }}>
      <Fonts />
      <nav style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(255,255,255,0.9)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${C.borderLight}`, padding: "0 40px", height: 56, display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: "auto", cursor: "pointer" }} onClick={() => go("landing")}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>{I.zap}</div>
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskSquad<span style={{ fontWeight: 500, color: C.inkLight }}>.ai</span></span>
        </div>
        <Btn onClick={() => go("dashboard")} small>Sign in</Btn>
      </nav>

      <div style={{ maxWidth: 800, margin: "80px auto", padding: "0 24px" }}>
        <h1 style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.025em", marginBottom: 8 }}>Pricing</h1>
        <p style={{ color: C.inkLight, fontSize: 16, marginBottom: 52 }}>Simple, honest. Free while we're building.</p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Free */}
          <div style={{ border: `2px solid ${C.ink}`, borderRadius: 12, padding: 36 }}>
            <Pill color={C.ink} bg={C.surfaceAlt}>Current plan</Pill>
            <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em", margin: "16px 0 4px" }}>$0</div>
            <div style={{ fontSize: 13, color: C.inkLight, marginBottom: 28 }}>Free forever</div>
            {["Unlimited teams", "Unlimited agents", "Unlimited tasks & threads", "Token-based agent auth", "Community support"].map(f => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", fontSize: 14 }}>
                <span style={{ color: C.green }}>{I.check}</span> {f}
              </div>
            ))}
            <Btn onClick={() => go("dashboard")} style={{ marginTop: 28, width: "100%", justifyContent: "center" }}>Get started free</Btn>
          </div>

          {/* Pro */}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: 36, opacity: 0.75 }}>
            <Pill color={C.amber} bg={C.amberLight}>Coming soon</Pill>
            <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em", margin: "16px 0 4px", color: C.inkLight }}>—</div>
            <div style={{ fontSize: 13, color: C.inkLight, marginBottom: 28 }}>Pro plan</div>
            {["Everything in Free", "Priority support", "Advanced analytics", "Audit logs", "SSO / SAML"].map(f => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", fontSize: 14, color: C.inkMuted }}>
                <span style={{ color: C.inkLight }}>{I.check}</span> {f}
              </div>
            ))}
            <div style={{ marginTop: 28 }}>
              {done ? (
                <div style={{ padding: "11px", background: C.greenLight, borderRadius: 7, fontSize: 13.5, fontWeight: 500, color: C.green, textAlign: "center" }}>✓ You're on the list</div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="email" placeholder="your@email.com" value={email} onChange={e => setEmail(e.target.value)}
                    style={{ flex: 1, padding: "10px 12px", borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 13, fontFamily: font, outline: "none" }} />
                  <Btn onClick={() => email && setDone(true)} small style={{ whiteSpace: "nowrap" }}>Notify me</Btn>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════
// DASHBOARD (App Shell)
// ═══════════════════════════════════════
const TEAMS = [
  { id: 1, name: "Acme Engineering", role: "Owner" },
  { id: 2, name: "Side Project", role: "Member" },
];

const AGENTS = [
  { id: 1, name: "build-server-01", active: true, lastSeen: "2 min ago", desc: "Main CI build machine" },
  { id: 2, name: "staging-runner", active: true, lastSeen: "Just now", desc: "Staging env runner" },
  { id: 3, name: "gpu-worker-03", active: false, lastSeen: "3 days ago", desc: "ML inference tasks" },
];

const MEMBERS = [
  { id: 1, name: "Igor", email: "igor@example.com", role: "Owner", init: "I", color: C.accent },
  { id: 2, name: "Sarah Chen", email: "sarah@example.com", role: "Maintainer", init: "S", color: "#7C3AED" },
  { id: 3, name: "Alex Rivera", email: "alex@example.com", role: "Member", init: "A", color: "#059669" },
];

const TASKS = [
  {
    id: 1, subject: "Refactor auth middleware to use JWT",
    from: "Igor", to: "build-server-01", status: "completed", time: "2h ago", unread: false,
    thread: [
      { from: "Igor", init: "I", color: C.accent, time: "14:10", body: "Please refactor the auth middleware in `src/middleware/auth.js` to use JWT instead of session tokens. Make sure to update the tests.", type: "human" },
      { from: "build-server-01", init: "⚙", color: C.inkMuted, time: "14:11", type: "agent",
        body: "Picked up task. Running `claude-code`…\n\n```diff\n- const session = require('./session');\n+ const jwt = require('jsonwebtoken');\n\n  module.exports = (req, res, next) => {\n-   if (!req.session.userId) return res.status(401).end();\n+   const token = req.headers.authorization?.split(' ')[1];\n+   if (!token) return res.status(401).end();\n+   req.user = jwt.verify(token, process.env.JWT_SECRET);\n    next();\n  };\n```\n✓ 14 tests passing. Committed to `feat/jwt-auth`." },
    ]
  },
  {
    id: 2, subject: "Add rate limiting to /api/upload endpoint",
    from: "Igor", to: "staging-runner", status: "in_progress", time: "45m ago", unread: true,
    thread: [
      { from: "Igor", init: "I", color: C.accent, time: "15:22", body: "Add express-rate-limit middleware to the `/api/upload` route. Max 10 requests per minute per IP.", type: "human" },
      { from: "staging-runner", init: "⚙", color: C.inkMuted, time: "15:23", type: "agent", body: "Received. Installing `express-rate-limit`… executing now." },
    ]
  },
  {
    id: 3, subject: "Review and optimize DB queries in user service",
    from: "Igor", to: "build-server-01, Sarah", status: "pending", time: "12m ago", unread: true,
    thread: [
      { from: "Igor", init: "I", color: C.accent, time: "16:00", body: "The user service is running slow. Profile and optimize the queries in `services/user.js`. CC Sarah for review.", type: "human" },
    ]
  },
];

const statusMeta = {
  completed:   { label: "Completed",   color: C.green,   bg: C.greenLight },
  in_progress: { label: "In Progress", color: C.amber,   bg: C.amberLight },
  pending:     { label: "Pending",     color: C.inkLight, bg: C.surfaceAlt },
};

const Avatar = ({ init, color, size = 30 }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.3, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
    {init}
  </div>
);

const Dashboard = ({ go }) => {
  const [teamId, setTeamId] = useState(1);
  const [teamOpen, setTeamOpen] = useState(false);
  const [tab, setTab] = useState("inbox"); // inbox | agents | members
  const [openTaskId, setOpenTaskId] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [agentToken, setAgentToken] = useState(null); // show token modal
  const [newAgentName, setNewAgentName] = useState("");
  const [addingAgent, setAddingAgent] = useState(false);

  const team = TEAMS.find(t => t.id === teamId);
  const openTask = TASKS.find(t => t.id === openTaskId);

  const sidebarItem = (id, label, badge) => (
    <div key={id} onClick={() => { setTab(id); setOpenTaskId(null); }} style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 16px", fontSize: 13.5, fontWeight: tab === id ? 600 : 400,
      color: tab === id ? C.ink : C.inkLight, cursor: "pointer",
      background: tab === id ? C.surface : "transparent",
      borderRight: tab === id ? `2px solid ${C.ink}` : "2px solid transparent",
      transition: "all 0.1s",
    }}>
      {label}
      {badge && <span style={{ marginLeft: "auto", background: C.accent, color: "#fff", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, fontFamily: mono }}>{badge}</span>}
    </div>
  );

  return (
    <div style={{ fontFamily: font, color: C.ink, background: C.surface, display: "flex", height: "100vh", overflow: "hidden" }}>
      <Fonts />

      {/* ── Sidebar ── */}
      <aside style={{ width: 220, background: C.surfaceAlt, borderRight: `1px solid ${C.borderLight}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        {/* Logo */}
        <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => go("landing")}>
          <div style={{ width: 24, height: 24, borderRadius: 5, background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>{I.zap}</div>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskSquad</span>
        </div>

        {/* Team switcher */}
        <div style={{ margin: "0 10px 16px", position: "relative" }}>
          <div onClick={() => setTeamOpen(o => !o)} style={{
            padding: "8px 12px", borderRadius: 7, border: `1px solid ${C.border}`,
            background: C.surface, fontSize: 13, fontWeight: 500, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</span>
            <span style={{ color: C.inkLight, marginLeft: 4 }}>{I.chevron}</span>
          </div>
          {teamOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", zIndex: 20, overflow: "hidden" }}>
              {TEAMS.map(t => (
                <div key={t.id} onClick={() => { setTeamId(t.id); setTeamOpen(false); }} style={{
                  padding: "9px 14px", fontSize: 13, cursor: "pointer",
                  background: t.id === teamId ? C.accentLight : "transparent",
                  color: t.id === teamId ? C.accent : C.ink,
                  fontWeight: t.id === teamId ? 600 : 400,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  {t.name}
                  {t.id === teamId && <span style={{ color: C.accent }}>{I.check}</span>}
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${C.borderLight}`, padding: "8px 14px", fontSize: 12.5, color: C.inkLight, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                {I.plus} New team
              </div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1 }}>
          {sidebarItem("inbox", "Inbox", TASKS.filter(t => t.unread).length || null)}
          {sidebarItem("agents", "Agents")}
          {sidebarItem("members", "Members")}
        </nav>

        {/* User */}
        <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar init="I" color={C.accent} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Igor</div>
            <div style={{ fontSize: 11, color: C.inkLight }}>Owner</div>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Header */}
        <header style={{ height: 52, padding: "0 28px", borderBottom: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {tab === "inbox" ? "Inbox" : tab === "agents" ? "Agents" : "Members"}
          </span>
          {/* Single contextual action */}
          {tab === "inbox" && !openTaskId && <Btn small onClick={() => alert("Compose new task")}>New task {I.plus}</Btn>}
          {tab === "agents" && <Btn small onClick={() => setAddingAgent(true)}>{I.plus} New agent</Btn>}
          {tab === "members" && <Btn small onClick={() => alert("Invite by email")}>Invite {I.plus}</Btn>}
          {openTaskId && (
            <span onClick={() => setOpenTaskId(null)} style={{ fontSize: 13, color: C.inkLight, cursor: "pointer" }}>← Back</span>
          )}
        </header>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto" }}>

          {/* ── INBOX ── */}
          {tab === "inbox" && !openTaskId && (
            <div>
              {TASKS.map(task => {
                const s = statusMeta[task.status];
                return (
                  <div key={task.id} onClick={() => { setOpenTaskId(task.id); setReplyText(""); }}
                    style={{ padding: "14px 28px", borderBottom: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", background: task.unread ? "#FAFBFF" : "transparent" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: task.unread ? C.accent : "transparent", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: task.unread ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.subject}</div>
                      <div style={{ fontSize: 12, color: C.inkLight, marginTop: 2 }}>{task.from} → {task.to}</div>
                    </div>
                    <Pill color={s.color} bg={s.bg}>{s.label}</Pill>
                    <span style={{ fontSize: 12, color: C.inkLight, flexShrink: 0 }}>{task.time}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── THREAD VIEW ── */}
          {tab === "inbox" && openTask && (
            <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 28px" }}>
              {/* Subject + meta */}
              <div style={{ marginBottom: 28 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.015em", margin: "0 0 8px" }}>{openTask.subject}</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: C.inkLight }}>
                  <span>To: <strong style={{ color: C.ink }}>{openTask.to}</strong></span>
                  <Pill color={statusMeta[openTask.status].color} bg={statusMeta[openTask.status].bg}>{statusMeta[openTask.status].label}</Pill>
                  <span>{openTask.time}</span>
                </div>
              </div>

              {/* Thread messages */}
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {openTask.thread.map((msg, i) => (
                  <div key={i} style={{ display: "flex", gap: 14 }}>
                    <Avatar init={msg.init} color={msg.color} size={32} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{msg.from}</span>
                        <span style={{ fontSize: 11.5, color: C.inkLight, fontFamily: mono }}>{msg.time}</span>
                        {msg.type === "agent" && <span style={{ color: C.inkLight, display: "flex", alignItems: "center", gap: 3, fontSize: 11 }}>{I.bot} agent</span>}
                      </div>
                      {msg.body.includes("```") ? (
                        <div>
                          {msg.body.split(/(```[\s\S]*?```)/g).map((part, pi) => {
                            if (part.startsWith("```")) {
                              const code = part.replace(/```\w*\n?/, "").replace(/```$/, "");
                              return (
                                <pre key={pi} style={{ background: "#0F1117", color: "#ABB2BF", fontFamily: mono, fontSize: 12, lineHeight: 1.7, padding: "14px 16px", borderRadius: 8, overflow: "auto", margin: "8px 0" }}>
                                  {code}
                                </pre>
                              );
                            }
                            return <p key={pi} style={{ fontSize: 14, lineHeight: 1.6, color: C.inkMuted, margin: "0 0 6px" }}>{part}</p>;
                          })}
                        </div>
                      ) : (
                        <p style={{ fontSize: 14, lineHeight: 1.6, color: C.inkMuted, margin: 0 }}>{msg.body}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Reply — inline, no separate button */}
              <div style={{ marginTop: 28, borderTop: `1px solid ${C.borderLight}`, paddingTop: 20 }}>
                <textarea
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder="Reply…"
                  rows={3}
                  style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: `1px solid ${C.border}`, fontFamily: font, fontSize: 14, resize: "vertical", outline: "none", color: C.ink, boxSizing: "border-box" }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <Btn small onClick={() => setReplyText("")} style={{ display: replyText ? "flex" : "none" }}>
                    {I.reply} Send reply
                  </Btn>
                </div>
              </div>
            </div>
          )}

          {/* ── AGENTS ── */}
          {tab === "agents" && (
            <div style={{ padding: "20px 28px" }}>
              {addingAgent && (
                <div style={{ marginBottom: 20, padding: "16px 20px", border: `1px solid ${C.border}`, borderRadius: 10, background: C.surfaceAlt, display: "flex", alignItems: "center", gap: 12 }}>
                  <input autoFocus value={newAgentName} onChange={e => setNewAgentName(e.target.value)}
                    placeholder="Agent name, e.g. build-server-02"
                    style={{ flex: 1, padding: "9px 12px", borderRadius: 7, border: `1px solid ${C.border}`, fontFamily: font, fontSize: 13.5, outline: "none" }} />
                  <Btn small onClick={() => { setAgentToken("tsq_" + Math.random().toString(36).slice(2,10)); setAddingAgent(false); setNewAgentName(""); }}>Create &amp; get token</Btn>
                  <span style={{ color: C.inkLight, cursor: "pointer", fontSize: 18, lineHeight: 1 }} onClick={() => setAddingAgent(false)}>×</span>
                </div>
              )}
              {agentToken && (
                <div style={{ marginBottom: 20, padding: "14px 20px", border: `1px solid ${C.green}`, borderRadius: 10, background: C.greenLight, display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ color: C.green, fontWeight: 600, fontSize: 13.5 }}>Token generated (shown once):</span>
                  <code style={{ fontFamily: mono, fontSize: 13, background: "rgba(0,0,0,0.06)", padding: "3px 10px", borderRadius: 5, flex: 1 }}>{agentToken}</code>
                  <span style={{ color: C.inkLight, cursor: "pointer", fontSize: 18, lineHeight: 1 }} onClick={() => setAgentToken(null)}>×</span>
                </div>
              )}
              {AGENTS.map(a => (
                <div key={a.id} style={{ padding: "16px 20px", border: `1px solid ${C.borderLight}`, borderRadius: 10, marginBottom: 10, display: "flex", alignItems: "center", gap: 16, background: C.surface }}>
                  <StatusDot active={a.active} size={10} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: mono, fontSize: 13.5, fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: C.inkLight, marginTop: 2 }}>Last seen: {a.lastSeen}</div>
                  </div>
                  <Pill color={a.active ? C.green : C.inkLight} bg={a.active ? C.greenLight : C.surfaceAlt}>{a.active ? "Active" : "Inactive"}</Pill>
                  {/* Only essential inline actions — no buttons cluster */}
                  <span style={{ fontSize: 12, color: C.accent, cursor: "pointer" }} onClick={() => setAgentToken("tsq_" + Math.random().toString(36).slice(2,10))}>Regenerate token</span>
                </div>
              ))}
            </div>
          )}

          {/* ── MEMBERS ── */}
          {tab === "members" && (
            <div style={{ padding: "20px 28px" }}>
              {MEMBERS.map(m => (
                <div key={m.id} style={{ padding: "14px 0", borderBottom: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", gap: 14 }}>
                  <Avatar init={m.init} color={m.color} size={34} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: C.inkLight }}>{m.email}</div>
                  </div>
                  {/* Role as inline selector, not a button */}
                  <select defaultValue={m.role} disabled={m.role === "Owner"} style={{ fontFamily: font, fontSize: 13, color: C.inkMuted, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 10px", cursor: m.role === "Owner" ? "default" : "pointer", outline: "none" }}>
                    <option>Owner</option>
                    <option>Maintainer</option>
                    <option>Member</option>
                  </select>
                </div>
              ))}
            </div>
          )}

        </div>
      </main>
    </div>
  );
};

// ═══════════════════════════════════════
// APP
// ═══════════════════════════════════════
export default function App() {
  const [page, setPage] = useState("landing");
  return (
    <>
      {page === "landing"   && <Landing  go={setPage} />}
      {page === "pricing"   && <Pricing  go={setPage} />}
      {page === "dashboard" && <Dashboard go={setPage} />}
    </>
  );
}
