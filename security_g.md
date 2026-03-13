# TaskSquad Security Audit Report
**Date:** 13 March 2026

## Executive Summary
A comprehensive security audit of the TaskSquad codebase (Worker, Daemon, Portal) was conducted. The audit identified several critical and high-severity vulnerabilities, primarily in the authentication and network configuration layers. While data encryption practices are sound (DEK wrapping), the system's reliance on permissive configurations and legacy authentication patterns poses significant risks.

## Detailed Findings

### 1. Network Security: Permissive CORS Policy
- **Severity:** **High**
- **Location:** `packages/worker/src/index.ts`
- **Description:** The Worker API is configured with `Access-Control-Allow-Origin: *`.
- **Risk:** This allows any malicious website to make authenticated requests to the API if a user with an active session visits the site. While the API uses Bearer tokens (which are less susceptible to CSRF than cookies), this permissive policy weakens the security posture and could facilitate data exfiltration if tokens are ever stored in a way accessible to third-party scripts.
- **Remediation:** Configure `Access-Control-Allow-Origin` to match the specific Portal domain (e.g., via `PORTAL_ORIGIN` environment variable).

### 2. Authentication: Hardcoded Admin Secret
- **Severity:** **Critical**
- **Location:** `packages/worker/src/routes/me.ts` (`setUserPlan` function)
- **Description:** Administrative actions (setting user plans) are protected solely by a hardcoded HTTP header `X-Admin-Secret` compared against an environment variable `ADMIN_SECRET`.
- **Risk:**
    -   **Leakage:** If the secret is leaked (e.g., in logs, source code, or shared channels), an attacker can grant themselves "Pro" status or modify other users' plans.
    -   **Rotation Difficulty:** Rotating a shared secret requires updating all admin clients and the server simultaneously.
    -   **Lack of Audit:** Shared secrets do not identify *which* admin performed the action.
- **Remediation:** Replace the shared secret with a role-based access control (RBAC) system using Firebase ID tokens and an allowlist of admin email addresses (`ADMIN_EMAILS`).

### 3. Daemon: Command Injection via Configuration
- **Severity:** **Medium** (Configuration Risk)
- **Location:** `packages/daemon/config/config.go`
- **Description:** The daemon executes the configured `command` using the user's prompt as an argument (or via stdin).
- **Risk:** If a user inadvertently configures a shell (e.g., `bash -c`, `sh -c`) as the agent command, the prompt text is executed as a shell script. This leads to Remote Code Execution (RCE) on the daemon host. While this requires user misconfiguration, the lack of safeguards increases the likelihood of accidental exposure.
- **Remediation:** Implement validation in the daemon startup logic to warn or block if the configured command is a known shell binary.

### 4. Daemon Identity: User Impersonation
- **Severity:** **Medium** (Architectural Weakness)
- **Location:** `packages/daemon/auth/` and `packages/worker/src/auth.ts`
- **Description:** The daemon authenticates using the **User's** Firebase ID token.
- **Risk:**
    -   **Excessive Privilege:** The daemon runs with the full permissions of the user, rather than a scoped "agent" identity.
    -   **Credential Exposure:** If the daemon machine is compromised, the attacker gains access to the user's account (teams, billing, other agents).
- **Remediation:** Transition to `daemon_tokens` (Service Accounts). The daemon should authenticate with a unique, long-lived token that scopes its access to a specific Agent/Team, without impersonating the user.

### 5. Data Protection: Sound Encryption Practices (Positive Finding)
- **Status:** **Secure**
- **Location:** `packages/worker/src/crypto.ts`, `packages/daemon/api/crypto.go`
- **Description:** The system uses a robust Data Encryption Key (DEK) hierarchy. Log data is encrypted with a unique DEK per agent, which is wrapped using a master key (`R2_LOGS_MASTER_KEY`). This ensures that even if the database is dumped, the log contents in R2 remain encrypted.

## Conclusion
Immediate action is required to address the **Admin Secret** and **CORS** vulnerabilities. The **Daemon Command Injection** risk should be mitigated with code safeguards and documentation. The **Daemon Identity** issue represents a longer-term architectural improvement to reduce the blast radius of a compromised agent.
