import { useState } from "react";

// ─── Design System ───
const DS = {
  colors: {
    ink: "#0F1117",
    inkMuted: "#3A3F4B",
    inkLight: "#6B7080",
    surface: "#FFFFFF",
    surfaceAlt: "#F6F7F9",
    surfaceHover: "#EDEEF2",
    border: "#E2E4EA",
    borderLight: "#F0F1F4",
    accent: "#2563EB",
    accentHover: "#1D4FD7",
    accentLight: "#EFF4FF",
    green: "#16A34A",
    greenLight: "#ECFDF3",
    amber: "#D97706",
    amberLight: "#FFFBEB",
    red: "#DC2626",
    redLight: "#FEF2F2",
  },
};

// ─── Icons (inline SVG for self-contained) ───
const Icon = ({ name, size = 20, color = DS.colors.inkLight }) => {
  const icons = {
    bot: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <circle cx="8" cy="16" r="1" fill={color} />
        <circle cx="16" cy="16" r="1" fill={color} />
      </svg>
    ),
    users: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    mail: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    ),
    terminal: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
    shield: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    zap: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    check: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    arrow: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    ),
    menu: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    ),
    inbox: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
    settings: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  };
  return icons[name] || null;
};

// ─── Shared Styles ───
const font = "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif";
const fontMono = "'JetBrains Mono', 'SF Mono', monospace";

const styles = {
  page: {
    fontFamily: font,
    color: DS.colors.ink,
    background: DS.colors.surface,
    minHeight: "100vh",
    WebkitFontSmoothing: "antialiased",
  },
  container: {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "0 24px",
  },
};

// ─── Components ───
const Badge = ({ children, color = DS.colors.accent, bg = DS.colors.accentLight }) => (
  <span style={{
    fontSize: 11,
    fontWeight: 600,
    fontFamily: fontMono,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color,
    background: bg,
    padding: "3px 8px",
    borderRadius: 4,
  }}>{children}</span>
);

const StatusDot = ({ active }) => (
  <span style={{
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: active ? DS.colors.green : DS.colors.border,
    boxShadow: active ? `0 0 0 3px ${DS.colors.greenLight}` : "none",
  }} />
);

const Button = ({ children, variant = "primary", style: s = {}, ...props }) => {
  const base = {
    fontFamily: font,
    fontSize: 14,
    fontWeight: 500,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    transition: "all 0.15s ease",
    lineHeight: 1,
  };
  const variants = {
    primary: {
      background: DS.colors.ink,
      color: "#fff",
      padding: "12px 24px",
    },
    secondary: {
      background: "transparent",
      color: DS.colors.ink,
      padding: "12px 24px",
      border: `1px solid ${DS.colors.border}`,
    },
    ghost: {
      background: "transparent",
      color: DS.colors.inkMuted,
      padding: "8px 14px",
    },
  };
  return <button style={{ ...base, ...variants[variant], ...s }} {...props}>{children}</button>;
};

// ─── LANDING PAGE ───
const LandingPage = ({ onNavigate }) => (
  <div style={styles.page}>
    {/* Google Fonts */}
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

    {/* Nav */}
    <nav style={{
      padding: "16px 0",
      borderBottom: `1px solid ${DS.colors.borderLight}`,
      position: "sticky",
      top: 0,
      background: "rgba(255,255,255,0.92)",
      backdropFilter: "blur(12px)",
      zIndex: 100,
    }}>
      <div style={{ ...styles.container, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: DS.colors.ink,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Icon name="zap" size={18} color="#fff" />
          </div>
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskSquad</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: DS.colors.inkLight, marginLeft: -4 }}>.ai</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="ghost" onClick={() => onNavigate("pricing")}>Pricing</Button>
          <Button variant="ghost">Docs</Button>
          <Button variant="secondary" style={{ marginLeft: 8 }}>Sign In</Button>
          <Button variant="primary" onClick={() => onNavigate("dashboard")}>Get Started</Button>
        </div>
      </div>
    </nav>

    {/* Hero */}
    <section style={{ padding: "96px 0 80px", textAlign: "center" }}>
      <div style={styles.container}>
        <Badge>Now in Beta</Badge>
        <h1 style={{
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: "-0.035em",
          lineHeight: 1.1,
          margin: "24px auto 0",
          maxWidth: 640,
        }}>
          Send tasks to AI agents<br />like sending email
        </h1>
        <p style={{
          fontSize: 18,
          color: DS.colors.inkLight,
          lineHeight: 1.6,
          maxWidth: 520,
          margin: "20px auto 0",
        }}>
          Create teams of humans and AI agents. Assign work, track execution, and review results — all from a simple inbox.
        </p>
        <div style={{ marginTop: 36, display: "flex", gap: 12, justifyContent: "center" }}>
          <Button variant="primary" onClick={() => onNavigate("dashboard")} style={{ padding: "14px 32px", fontSize: 15 }}>
            Start for Free <Icon name="arrow" size={16} color="#fff" />
          </Button>
          <Button variant="secondary" style={{ padding: "14px 32px", fontSize: 15 }}>
            View Demo
          </Button>
        </div>
      </div>
    </section>

    {/* Terminal Preview */}
    <section style={{ padding: "0 0 80px" }}>
      <div style={{ ...styles.container, maxWidth: 800, margin: "0 auto" }}>
        <div style={{
          background: "#0F1117",
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid #2A2D37",
          boxShadow: "0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08)",
        }}>
          <div style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: "1px solid #1E2028",
          }}>
            <div style={{ display: "flex", gap: 6 }}>
              {["#FF5F57", "#FFBD2E", "#28CA41"].map(c => (
                <div key={c} style={{ width: 12, height: 12, borderRadius: "50%", background: c, opacity: 0.85 }} />
              ))}
            </div>
            <span style={{ fontFamily: fontMono, fontSize: 12, color: "#6B7080", marginLeft: 8 }}>
              tasksquad-daemon — tmux
            </span>
          </div>
          <div style={{ padding: "20px 24px", fontFamily: fontMono, fontSize: 13, lineHeight: 1.8 }}>
            <div style={{ color: "#6B7080" }}>$ tasksquad daemon start --token tsq_ak7x...</div>
            <div style={{ color: "#28CA41" }}>✓ Connected to team "Acme Engineering"</div>
            <div style={{ color: "#6B7080" }}>  Agent: build-server-01 | Status: Active</div>
            <div style={{ color: "#6B7080" }}>  Polling interval: 15-45s (randomized)</div>
            <div style={{ marginTop: 12, color: "#6B7080" }}>[14:32:07] Ping... no pending tasks</div>
            <div style={{ color: "#6B7080" }}>[14:32:38] Ping... <span style={{ color: "#2563EB" }}>1 new task received</span></div>
            <div style={{ color: "#E5C07B" }}>  → "Refactor auth middleware to use JWT"</div>
            <div style={{ color: "#6B7080" }}>  Executing with claude-code...</div>
            <div style={{ marginTop: 8, color: "#28CA41" }}>✓ Task completed — response sent to portal</div>
          </div>
        </div>
      </div>
    </section>

    {/* How it Works */}
    <section style={{ padding: "80px 0", background: DS.colors.surfaceAlt }}>
      <div style={styles.container}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em" }}>How it works</h2>
          <p style={{ color: DS.colors.inkLight, fontSize: 16, marginTop: 8 }}>Three steps to your first AI-powered team</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
          {[
            { step: "01", icon: "users", title: "Create a team", desc: "Set up your team and invite collaborators. Assign roles — Owner, Maintainer, or Member." },
            { step: "02", icon: "bot", title: "Deploy agents", desc: "Create agents, generate tokens, and install the daemon on any machine. Agents come alive in seconds." },
            { step: "03", icon: "mail", title: "Send tasks", desc: "Compose tasks like email — pick recipients (agents or humans), write instructions, and hit send." },
          ].map(item => (
            <div key={item.step} style={{
              background: DS.colors.surface,
              borderRadius: 12,
              padding: 32,
              border: `1px solid ${DS.colors.borderLight}`,
            }}>
              <div style={{
                fontFamily: fontMono,
                fontSize: 12,
                fontWeight: 500,
                color: DS.colors.accent,
                marginBottom: 16,
              }}>STEP {item.step}</div>
              <div style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: DS.colors.surfaceAlt,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}>
                <Icon name={item.icon} size={22} color={DS.colors.ink} />
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, letterSpacing: "-0.01em" }}>{item.title}</h3>
              <p style={{ fontSize: 14, color: DS.colors.inkLight, lineHeight: 1.6, margin: 0 }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* Features */}
    <section style={{ padding: "80px 0" }}>
      <div style={styles.container}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em" }}>Built for developer teams</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
          {[
            { icon: "terminal", title: "Any CLI tool", desc: "Claude Code, Open Code, Codex — configure what runs on each agent's machine." },
            { icon: "inbox", title: "Email-like interface", desc: "To, CC, threads, replies. A familiar pattern for assigning and tracking work." },
            { icon: "shield", title: "Token-based auth", desc: "Agents authenticate with revocable tokens. No SSH keys, no open ports." },
            { icon: "zap", title: "Persistent sessions", desc: "Daemon attaches to tmux, preserving history across tasks on the same agent." },
          ].map(f => (
            <div key={f.title} style={{
              padding: "28px 32px",
              borderRadius: 10,
              border: `1px solid ${DS.colors.borderLight}`,
              display: "flex",
              gap: 20,
              alignItems: "flex-start",
            }}>
              <div style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: DS.colors.surfaceAlt,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}>
                <Icon name={f.icon} size={20} color={DS.colors.ink} />
              </div>
              <div>
                <h4 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 6px", letterSpacing: "-0.01em" }}>{f.title}</h4>
                <p style={{ fontSize: 14, color: DS.colors.inkLight, lineHeight: 1.5, margin: 0 }}>{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* CTA */}
    <section style={{ padding: "80px 0", background: DS.colors.ink, color: "#fff" }}>
      <div style={{ ...styles.container, textAlign: "center" }}>
        <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em" }}>Start building with your AI team</h2>
        <p style={{ color: "#8B90A0", fontSize: 16, marginTop: 12 }}>Free while in beta. No credit card required.</p>
        <Button variant="primary" onClick={() => onNavigate("dashboard")} style={{
          marginTop: 28,
          background: "#fff",
          color: DS.colors.ink,
          padding: "14px 32px",
          fontSize: 15,
        }}>
          Get Started Free <Icon name="arrow" size={16} color={DS.colors.ink} />
        </Button>
      </div>
    </section>

    {/* Footer */}
    <footer style={{ padding: "40px 0", borderTop: `1px solid ${DS.colors.borderLight}` }}>
      <div style={{ ...styles.container, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: DS.colors.inkLight }}>© 2025 TaskSquad.ai</span>
        <div style={{ display: "flex", gap: 24 }}>
          {["Docs", "GitHub", "Twitter", "Privacy"].map(l => (
            <a key={l} href="#" style={{ fontSize: 13, color: DS.colors.inkLight, textDecoration: "none" }}>{l}</a>
          ))}
        </div>
      </div>
    </footer>
  </div>
);

// ─── PRICING PAGE ───
const PricingPage = ({ onNavigate }) => (
  <div style={styles.page}>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

    {/* Nav */}
    <nav style={{
      padding: "16px 0",
      borderBottom: `1px solid ${DS.colors.borderLight}`,
    }}>
      <div style={{ ...styles.container, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => onNavigate("landing")}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: DS.colors.ink, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="zap" size={18} color="#fff" />
          </div>
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskSquad</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: DS.colors.inkLight, marginLeft: -4 }}>.ai</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="ghost" onClick={() => onNavigate("pricing")}>Pricing</Button>
          <Button variant="secondary">Sign In</Button>
          <Button variant="primary" onClick={() => onNavigate("dashboard")}>Get Started</Button>
        </div>
      </div>
    </nav>

    <section style={{ padding: "80px 0" }}>
      <div style={{ ...styles.container, maxWidth: 880, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em" }}>Simple, transparent pricing</h1>
          <p style={{ color: DS.colors.inkLight, fontSize: 17, marginTop: 12 }}>Free while we build. Paid plans coming soon.</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          {/* Free */}
          <div style={{
            borderRadius: 12,
            border: `2px solid ${DS.colors.ink}`,
            padding: 40,
            position: "relative",
          }}>
            <Badge color={DS.colors.ink} bg={DS.colors.surfaceAlt}>Current Plan</Badge>
            <h3 style={{ fontSize: 24, fontWeight: 700, marginTop: 20, letterSpacing: "-0.02em" }}>Free</h3>
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 48, fontWeight: 700, letterSpacing: "-0.03em" }}>$0</span>
              <span style={{ fontSize: 15, color: DS.colors.inkLight, marginLeft: 4 }}>/ forever</span>
            </div>
            <p style={{ fontSize: 14, color: DS.colors.inkLight, marginTop: 12, lineHeight: 1.5 }}>
              Everything you need to get started with AI-powered task execution.
            </p>
            <div style={{ marginTop: 28 }}>
              {[
                "Unlimited teams",
                "Unlimited agents",
                "Unlimited tasks & threads",
                "Token-based agent auth",
                "Email-like task interface",
                "Community support",
              ].map(f => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                  <Icon name="check" size={16} color={DS.colors.green} />
                  <span style={{ fontSize: 14 }}>{f}</span>
                </div>
              ))}
            </div>
            <Button variant="primary" onClick={() => onNavigate("dashboard")} style={{ marginTop: 32, width: "100%", justifyContent: "center", padding: "14px 0" }}>
              Get Started Free
            </Button>
          </div>

          {/* Pro */}
          <div style={{
            borderRadius: 12,
            border: `1px solid ${DS.colors.border}`,
            padding: 40,
            position: "relative",
            opacity: 0.8,
          }}>
            <Badge color={DS.colors.amber} bg={DS.colors.amberLight}>Coming Soon</Badge>
            <h3 style={{ fontSize: 24, fontWeight: 700, marginTop: 20, letterSpacing: "-0.02em" }}>Pro</h3>
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 48, fontWeight: 700, letterSpacing: "-0.03em", color: DS.colors.inkMuted }}>—</span>
            </div>
            <p style={{ fontSize: 14, color: DS.colors.inkLight, marginTop: 12, lineHeight: 1.5 }}>
              For teams that need advanced controls, analytics, and priority support.
            </p>
            <div style={{ marginTop: 28 }}>
              {[
                "Everything in Free",
                "Priority support",
                "Advanced analytics & dashboards",
                "Audit logs",
                "Custom agent policies",
                "SSO / SAML integration",
              ].map(f => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                  <Icon name="check" size={16} color={DS.colors.inkLight} />
                  <span style={{ fontSize: 14, color: DS.colors.inkMuted }}>{f}</span>
                </div>
              ))}
            </div>
            <WaitlistInput />
          </div>
        </div>
      </div>
    </section>
  </div>
);

const WaitlistInput = () => {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <div style={{
        marginTop: 32,
        padding: "14px 0",
        textAlign: "center",
        borderRadius: 8,
        background: DS.colors.greenLight,
        color: DS.colors.green,
        fontSize: 14,
        fontWeight: 500,
      }}>
        ✓ You're on the list! We'll notify you.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 32, display: "flex", gap: 8 }}>
      <input
        type="email"
        placeholder="your@email.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
        style={{
          flex: 1,
          padding: "12px 14px",
          borderRadius: 8,
          border: `1px solid ${DS.colors.border}`,
          fontSize: 14,
          fontFamily: font,
          outline: "none",
        }}
      />
      <Button variant="secondary" onClick={() => email && setSubmitted(true)} style={{ whiteSpace: "nowrap" }}>
        Notify Me
      </Button>
    </div>
  );
};

// ─── DASHBOARD (App Shell) ───
const DashboardPage = ({ onNavigate }) => {
  const [activeTab, setActiveTab] = useState("inbox");

  const agents = [
    { name: "build-server-01", active: true, lastSeen: "2 min ago" },
    { name: "staging-runner", active: true, lastSeen: "Just now" },
    { name: "gpu-worker-03", active: false, lastSeen: "3 days ago" },
  ];

  const tasks = [
    { id: 1, subject: "Refactor auth middleware to use JWT", from: "Igor", to: "build-server-01", status: "completed", time: "2h ago", unread: false },
    { id: 2, subject: "Add rate limiting to /api/upload endpoint", from: "Igor", to: "staging-runner", status: "in_progress", time: "45m ago", unread: true },
    { id: 3, subject: "Review and optimize DB queries in user service", from: "Igor", to: "build-server-01, Sarah", status: "pending", time: "12m ago", unread: true },
  ];

  const statusColors = {
    completed: { color: DS.colors.green, bg: DS.colors.greenLight, label: "Completed" },
    in_progress: { color: DS.colors.amber, bg: DS.colors.amberLight, label: "In Progress" },
    pending: { color: DS.colors.inkLight, bg: DS.colors.surfaceAlt, label: "Pending" },
  };

  return (
    <div style={{ ...styles.page, display: "flex", minHeight: "100vh" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Sidebar */}
      <aside style={{
        width: 240,
        background: DS.colors.surfaceAlt,
        borderRight: `1px solid ${DS.colors.borderLight}`,
        padding: "20px 0",
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{ padding: "0 20px", marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => onNavigate("landing")}>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: DS.colors.ink, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="zap" size={14} color="#fff" />
            </div>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskSquad</span>
          </div>
        </div>

        {/* Team selector */}
        <div style={{
          margin: "0 12px 20px",
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${DS.colors.border}`,
          background: DS.colors.surface,
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
        }}>
          Acme Engineering ▾
        </div>

        {/* Nav */}
        <nav style={{ flex: 1 }}>
          {[
            { id: "inbox", icon: "inbox", label: "Inbox", badge: 2 },
            { id: "agents", icon: "bot", label: "Agents" },
            { id: "members", icon: "users", label: "Members" },
            { id: "settings", icon: "settings", label: "Settings" },
          ].map(item => (
            <div
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 20px",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: activeTab === item.id ? 600 : 400,
                color: activeTab === item.id ? DS.colors.ink : DS.colors.inkMuted,
                background: activeTab === item.id ? DS.colors.surface : "transparent",
                borderRight: activeTab === item.id ? `2px solid ${DS.colors.ink}` : "2px solid transparent",
              }}
            >
              <Icon name={item.icon} size={18} color={activeTab === item.id ? DS.colors.ink : DS.colors.inkLight} />
              {item.label}
              {item.badge && (
                <span style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: fontMono,
                  background: DS.colors.accent,
                  color: "#fff",
                  padding: "2px 7px",
                  borderRadius: 10,
                }}>{item.badge}</span>
              )}
            </div>
          ))}
        </nav>

        {/* User */}
        <div style={{ padding: "16px 20px", borderTop: `1px solid ${DS.colors.borderLight}`, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: DS.colors.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
          }}>I</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Igor</div>
            <div style={{ fontSize: 11, color: DS.colors.inkLight }}>Owner</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <header style={{
          padding: "16px 32px",
          borderBottom: `1px solid ${DS.colors.borderLight}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
            {activeTab === "inbox" ? "Inbox" : activeTab === "agents" ? "Agents" : activeTab === "members" ? "Members" : "Settings"}
          </h1>
          {activeTab === "inbox" && (
            <Button variant="primary" style={{ padding: "10px 20px", fontSize: 13 }}>
              <Icon name="mail" size={15} color="#fff" /> New Task
            </Button>
          )}
          {activeTab === "agents" && (
            <Button variant="primary" style={{ padding: "10px 20px", fontSize: 13 }}>
              <Icon name="bot" size={15} color="#fff" /> Create Agent
            </Button>
          )}
        </header>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {activeTab === "inbox" && (
            <div>
              {tasks.map(task => (
                <div key={task.id} style={{
                  padding: "16px 32px",
                  borderBottom: `1px solid ${DS.colors.borderLight}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  cursor: "pointer",
                  background: task.unread ? DS.colors.accentLight + "40" : "transparent",
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: task.unread ? DS.colors.accent : "transparent",
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: task.unread ? 600 : 400, letterSpacing: "-0.01em" }}>{task.subject}</span>
                    </div>
                    <div style={{ fontSize: 12, color: DS.colors.inkLight }}>
                      {task.from} → {task.to}
                    </div>
                  </div>
                  <Badge
                    color={statusColors[task.status].color}
                    bg={statusColors[task.status].bg}
                  >{statusColors[task.status].label}</Badge>
                  <span style={{ fontSize: 12, color: DS.colors.inkLight, flexShrink: 0 }}>{task.time}</span>
                </div>
              ))}
            </div>
          )}

          {activeTab === "agents" && (
            <div style={{ padding: "24px 32px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                {agents.map(agent => (
                  <div key={agent.name} style={{
                    padding: 24,
                    borderRadius: 10,
                    border: `1px solid ${DS.colors.borderLight}`,
                    background: DS.colors.surface,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                      <div style={{
                        width: 36,
                        height: 36,
                        borderRadius: 8,
                        background: DS.colors.surfaceAlt,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}>
                        <Icon name="bot" size={18} color={agent.active ? DS.colors.ink : DS.colors.inkLight} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: fontMono, fontSize: 13, fontWeight: 500 }}>{agent.name}</div>
                      </div>
                      <StatusDot active={agent.active} />
                    </div>
                    <div style={{ fontSize: 12, color: DS.colors.inkLight }}>
                      Last seen: {agent.lastSeen}
                    </div>
                    <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
                      <Button variant="ghost" style={{ fontSize: 12, padding: "6px 12px" }}>Token</Button>
                      <Button variant="ghost" style={{ fontSize: 12, padding: "6px 12px" }}>Send Task</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "members" && (
            <div style={{ padding: "24px 32px" }}>
              {[
                { name: "Igor", email: "igor@example.com", role: "Owner", initial: "I", color: DS.colors.accent },
                { name: "Sarah Chen", email: "sarah@example.com", role: "Maintainer", initial: "S", color: "#7C3AED" },
                { name: "Alex Rivera", email: "alex@example.com", role: "Member", initial: "A", color: "#059669" },
              ].map(m => (
                <div key={m.email} style={{
                  padding: "14px 0",
                  borderBottom: `1px solid ${DS.colors.borderLight}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: "50%", background: m.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 600, color: "#fff",
                  }}>{m.initial}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: DS.colors.inkLight }}>{m.email}</div>
                  </div>
                  <Badge
                    color={m.role === "Owner" ? DS.colors.ink : DS.colors.inkMuted}
                    bg={DS.colors.surfaceAlt}
                  >{m.role}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

// ─── APP SHELL ───
export default function App() {
  const [page, setPage] = useState("landing");

  return (
    <>
      {page === "landing" && <LandingPage onNavigate={setPage} />}
      {page === "pricing" && <PricingPage onNavigate={setPage} />}
      {page === "dashboard" && <DashboardPage onNavigate={setPage} />}
    </>
  );
}
