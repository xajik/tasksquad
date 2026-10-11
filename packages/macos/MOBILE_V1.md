# TaskSquad iPhone and Watch v1 implementation brief

Status: implementation-ready product and API brief. Mobile implementation is a separate milestone from the direct Mac distribution.

## Release scope

The iPhone app creates tasks, sends text and image replies, closes tasks with confirmation, and monitors task conversations, agent availability, and project summaries. The Watch app is read-only after setup and works over its own network connection without the iPhone nearby. Both apps use existing accounts. They have no subscription purchase, upgrade link, task approval, or terminal control in v1.

## Platform and module boundaries

- SwiftUI, iOS 17 and watchOS 10 minimums.
- Extract a platform-neutral `TaskSquadClient` Swift package from the native app. Put typed API records, authentication protocols, status derivation, cache rules, and structured errors there.
- Keep AppKit, process execution, tmux, filesystem operations, local daemon authentication, and macOS Keychain adapters in the Mac target.
- iPhone storage uses Keychain-backed short-lived credentials and an encrypted local cache. Watch storage contains only its revocable read-only credential and cached summaries/task views.
- All project-scoped requests revalidate membership on the server. Logout revokes device credentials and clears local caches.

## iPhone navigation and screens

1. **Sign in** launches the system browser. An app/universal-link callback returns a single-use authorization code; the app exchanges it using PKCE. Reusable tokens never appear in callback URLs.
2. **Projects** lists teams the account can access, with a clear active-project switcher and per-project summary.
3. **Inbox** has search, status, origin, and agent filters. Scheduled work is labeled separately from historical messages that were scheduled.
4. **Task conversation** shows subject, project, agent, current status, timestamps, text and image attachments, and an explicit freshness indicator. Replies persist as drafts and retry with the same idempotency key. Close asks for confirmation.
5. **New task** requires project, subject, and agent; accepts an optional message and up to three supported images. Repeated submission after a timeout reuses an idempotency key.
6. **Settings** offers notification preferences, device revocation, logout, and cache clearing. It does not advertise upgrades.

Cached screens remain readable offline and always show the last successful update time. Mutations require a network connection. On retry, the app reuses the original idempotency key rather than silently creating another task or message.

## Watch screens and pairing

- Pair from the iPhone app. The server creates a separate, revocable credential with read-only scopes; never copy the iPhone credential to Watch.
- Use WatchConnectivity for setup, pairing state, and transfer of a recent snapshot. Fetch summaries and tasks directly from the API when Watch has network connectivity.
- Show project summaries, Inbox, abbreviated task detail, agent availability, and an attention-required complication count. Display the snapshot timestamp whenever cached data is shown.
- Refresh on foreground entry and system-permitted background opportunities. Do not promise continuous background polling.
- No reply, task creation, approval, close, terminal, or local execution controls.

## API contract additions

Existing user-scoped team, agent, task, message, and statistics endpoints remain the source of task data. New endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /mobile/authorization/exchange` | Exchange one-time OAuth code plus PKCE verifier for an iPhone session |
| `POST /mobile/devices` | Register device identity and notification preferences |
| `DELETE /mobile/devices/:id` | Revoke an iPhone device and its credentials |
| `POST /mobile/devices/:id/watch` | Issue a distinct Watch read-only credential after authenticated pairing |
| `DELETE /mobile/devices/:id/watch` | Revoke the paired Watch credential |
| `GET /mobile/watch/projects` | Read project summaries using Watch scope |
| `GET /mobile/watch/inbox` | Read Inbox summaries using Watch scope |
| `GET /mobile/watch/tasks/:id` | Read an abbreviated task conversation using Watch scope |
| `PUT /mobile/notification-preferences` | Save waiting-input, completion, and failure preferences |

Task creation and message reply endpoints accept `Idempotency-Key`. Store the key with the authenticated user, operation, and result; return the original result for a repeated key and reject reuse with a different request body. Every request checks current project membership. Watch authorization allows only the three read endpoints above. Image uploads keep the existing MIME, count, and size constraints.

APNs delivery covers waiting for input, completion, and failure. Persist the event/device delivery key, deduplicate retries, apply the user's per-event preferences, and remove invalid device tokens when APNs reports them. Payloads contain project/task identifiers and a short preview only when permitted by notification privacy settings; deep links open the matching project and task.

## Privacy and review work

- Document account identity, project data, task messages, images, notification tokens, and Watch snapshots in privacy disclosures.
- Supply a review account with non-sensitive projects, tasks, agents, and notification examples.
- Verify account deletion and device revocation, including offline cache purge on the next successful launch after remote revocation.
- Confirm current App Review eligibility for an app that signs in to an existing service account before submission. Existing-account access is the product model, not a promise of Store acceptance.

## Implementation backlog and acceptance

1. Extract the shared package and move model/status/error tests without changing Mac behavior.
2. Add mobile OAuth code + PKCE exchange, device registration/revocation, scoped Watch credentials, idempotency storage, and membership tests.
3. Build iPhone navigation, cached Inbox/task detail, create/reply/close flows, image upload, and duplicate-retry tests.
4. Add notification preference UI, APNs delivery deduplication, and task deep links.
5. Build Watch pairing, read-only API calls, cached snapshot timestamps, complication, and independent-network tests.
6. Test logout, revocation, membership loss, stale cache, offline reads, failed uploads, repeated idempotency keys, and Watch use with iPhone powered off.
7. Complete privacy disclosures, review credentials, screenshots, accessibility audit, and App Review eligibility review.
