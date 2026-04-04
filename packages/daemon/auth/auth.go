// Package auth manages credentials for the tsq daemon via the OS keychain.
//
// Flow:
//  1. tsq login → opens browser to portal /auth/cli, waits for local callback,
//     stores Firebase ID token + refresh token in OS keychain, then immediately
//     exchanges the ID token for a long-lived CLI token (90 days) via
//     POST /auth/cli-token on the worker.
//  2. tsq (run) → GetToken() returns the stored CLI token if valid.
//     If < 7 days remain, it silently rotates: refreshes the Firebase ID token
//     and mints a new CLI token without user interaction.
//     If the CLI token is absent or fully expired, GetToken() tries the Firebase
//     refresh-token path and mints a fresh CLI token opportunistically.
//  3. Any 401 "invalid_token" / "token_expired" from the API triggers one
//     automatic rotation attempt; if that also fails, the daemon prompts
//     "run: tsq login".
//  4. tsq logout → deletes all stored credentials from the keychain.
//
// File layout:
//   auth.go      — Login (OAuth browser flow + callback server)
//   keychain.go  — IsLoggedIn, GetEmail, Logout (keychain accessors)
//   token.go     — GetToken, ForceRotate, rotation helpers
package auth

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"github.com/zalando/go-keyring"
)

// Login opens a browser to the portal's CLI auth page, waits for the OAuth
// callback on a local HTTP server, stores the Firebase credentials, and then
// mints a long-lived CLI token from the worker.
//
// dashboardURL is the portal base URL (e.g. "https://tasksquad.ai").
// apiURL is the worker base URL (e.g. "https://api.tasksquad.ai").
func Login(dashboardURL, apiURL string) (email string, err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("start callback server: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	type result struct {
		idToken      string
		refreshToken string
		email        string
		err          error
	}
	ch := make(chan result, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		idToken := q.Get("id_token")
		refreshToken := q.Get("refresh_token")
		emailParam := q.Get("email")

		if idToken == "" {
			http.Error(w, "missing id_token", http.StatusBadRequest)
			ch <- result{err: fmt.Errorf("missing id_token in callback")}
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>TaskSquad — Logged in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', -apple-system, sans-serif;
      background: #F6F7F9;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border: 1px solid #E2E4EA;
      border-radius: 16px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 380px;
      text-align: center;
      box-shadow: 0 1px 4px rgba(15,17,23,0.06);
    }
    .icon {
      width: 56px;
      height: 56px;
      background: #DCFCE7;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.25rem;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #0F1117;
      margin-bottom: 0.5rem;
    }
    p {
      font-size: 0.9rem;
      color: #6B7280;
      line-height: 1.5;
    }
    .badge {
      display: inline-block;
      margin-top: 1.5rem;
      background: #EFF6FF;
      color: #2563EB;
      font-size: 0.8rem;
      font-weight: 500;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <h1>Logged in successfully</h1>
    <p>You can close this window and return to the terminal.</p>
    <div class="badge">TaskSquad daemon is ready</div>
  </div>
</body>
</html>`)
		ch <- result{idToken: idToken, refreshToken: refreshToken, email: emailParam}
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(ln) //nolint:errcheck
	defer srv.Close()

	callbackURL := "http://localhost:" + strconv.Itoa(port) + "/callback"
	authURL := dashboardURL + "/auth/cli?redirect_uri=" + url.QueryEscape(callbackURL)

	fmt.Printf("Opening browser for login...\n")
	fmt.Printf("If the browser doesn't open, visit:\n  %s\n\n", authURL)
	openBrowser(authURL)

	select {
	case res := <-ch:
		if res.err != nil {
			return "", res.err
		}

		// Store Firebase credentials (needed for future CLI token rotation).
		expiry := time.Now().Add(time.Hour).Format(time.RFC3339)
		if setErr := keyring.Set(keychainService, keyIDToken, res.idToken); setErr != nil {
			return "", fmt.Errorf("save id token: %w", setErr)
		}
		if res.refreshToken != "" {
			keyring.Set(keychainService, keyRefreshToken, res.refreshToken) //nolint:errcheck
		}
		keyring.Set(keychainService, keyExpiry, expiry)   //nolint:errcheck
		keyring.Set(keychainService, keyEmail, res.email) //nolint:errcheck

		// Mint a long-lived CLI token so the daemon runs for 90 days without re-login.
		log.Printf("[auth] minting long-lived CLI token from worker...")
		cliToken, cliExpiry, mintErr := mintCLIToken(apiURL, res.idToken)
		if mintErr != nil {
			// Non-fatal: daemon will fall back to Firebase refresh on next poll.
			log.Printf("[auth] warning: could not mint CLI token: %v — will use Firebase refresh", mintErr)
		} else {
			keyring.Set(keychainService, keyCLIToken, cliToken)                             //nolint:errcheck
			keyring.Set(keychainService, keyCLITokenExpiry, cliExpiry.Format(time.RFC3339)) //nolint:errcheck
			log.Printf("[auth] CLI token stored, valid until %s", cliExpiry.Format(time.RFC3339))
		}

		return res.email, nil

	case <-time.After(5 * time.Minute):
		return "", fmt.Errorf("login timed out (5 minutes)")
	}
}

func openBrowser(rawURL string) {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "linux":
		cmd = "xdg-open"
	case "windows":
		cmd = "start"
	default:
		return
	}
	exec.Command(cmd, rawURL).Start() //nolint:errcheck
}
