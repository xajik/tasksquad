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
package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	keychainService  = "tasksquad-daemon"
	keyIDToken       = "id-token"
	keyRefreshToken  = "refresh-token"
	keyExpiry        = "expiry"
	keyEmail         = "email"
	keyCLIToken      = "cli-token"
	keyCLITokenExpiry = "cli-token-expiry"
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
			keyring.Set(keychainService, keyCLIToken, cliToken)                                 //nolint:errcheck
			keyring.Set(keychainService, keyCLITokenExpiry, cliExpiry.Format(time.RFC3339))     //nolint:errcheck
			log.Printf("[auth] CLI token stored, valid until %s", cliExpiry.Format(time.RFC3339))
		}

		return res.email, nil

	case <-time.After(5 * time.Minute):
		return "", fmt.Errorf("login timed out (5 minutes)")
	}
}

// Logout removes all stored credentials from the OS keychain.
func Logout() error {
	for _, key := range []string{keyIDToken, keyRefreshToken, keyExpiry, keyEmail, keyCLIToken, keyCLITokenExpiry} {
		if err := keyring.Delete(keychainService, key); err != nil && err != keyring.ErrNotFound {
			return err
		}
	}
	return nil
}

// GetToken returns a valid token for the worker API. It prefers the long-lived
// CLI token and silently rotates it when < 7 days remain. If no CLI token is
// available it falls back to the Firebase refresh-token path and opportunistically
// mints a fresh CLI token.
//
// firebaseAPIKey is the Firebase public API key (from config).
// apiURL is the worker base URL (e.g. "https://api.tasksquad.ai").
func GetToken(firebaseAPIKey, apiURL string) (string, error) {
	// ── 1. Check long-lived CLI token ───────────────────────────────────────
	cliToken, _ := keyring.Get(keychainService, keyCLIToken)
	cliExpiryStr, _ := keyring.Get(keychainService, keyCLITokenExpiry)

	if cliToken != "" && cliExpiryStr != "" {
		cliExpiry, err := time.Parse(time.RFC3339, cliExpiryStr)
		if err == nil {
			daysLeft := time.Until(cliExpiry).Hours() / 24

			switch {
			case daysLeft > 7:
				log.Printf("[auth] CLI token valid (%.0fd remaining)", daysLeft)
				return cliToken, nil

			case daysLeft > 0:
				// Token still valid but approaching expiry — rotate silently.
				log.Printf("[auth] CLI token expiring in %.0fd — rotating silently...", daysLeft)
				newToken, rotErr := rotateCLIToken(firebaseAPIKey, apiURL)
				if rotErr != nil {
					log.Printf("[auth] rotation failed, continuing with existing token: %v", rotErr)
					return cliToken, nil
				}
				log.Printf("[auth] CLI token rotated successfully")
				return newToken, nil

			default:
				log.Printf("[auth] CLI token expired %.0fd ago — falling back to Firebase", -daysLeft)
			}
		}
	}

	// ── 2. Fall back: get/refresh Firebase ID token ──────────────────────────
	log.Printf("[auth] no valid CLI token — refreshing Firebase ID token...")
	idToken, err := getFirebaseToken(firebaseAPIKey)
	if err != nil {
		return "", err
	}

	// Opportunistically mint a new CLI token so future calls skip Firebase.
	log.Printf("[auth] minting new CLI token from refreshed Firebase credentials...")
	newCLI, cliExpiry, mintErr := mintCLIToken(apiURL, idToken)
	if mintErr != nil {
		log.Printf("[auth] warning: could not mint CLI token: %v — using Firebase ID token for now", mintErr)
		return idToken, nil
	}
	keyring.Set(keychainService, keyCLIToken, newCLI)                                 //nolint:errcheck
	keyring.Set(keychainService, keyCLITokenExpiry, cliExpiry.Format(time.RFC3339))   //nolint:errcheck
	log.Printf("[auth] new CLI token stored, valid until %s", cliExpiry.Format(time.RFC3339))
	return newCLI, nil
}

// ForceRotate refreshes the CLI token unconditionally using the Firebase refresh
// token. Called by API callers that receive a 401 invalid_token / token_expired
// response — one retry attempt before prompting the user to re-login.
func ForceRotate(firebaseAPIKey, apiURL string) (string, error) {
	log.Printf("[auth] server returned 401 — forcing token rotation (one-time retry)...")
	newToken, err := rotateCLIToken(firebaseAPIKey, apiURL)
	if err != nil {
		return "", fmt.Errorf("force rotate failed: %w — run: tsq login", err)
	}
	log.Printf("[auth] token rotated after server 401")
	return newToken, nil
}

// GetEmail returns the stored user email, or empty string if not logged in.
func GetEmail() string {
	email, _ := keyring.Get(keychainService, keyEmail)
	return email
}

// IsLoggedIn reports whether credentials are present in the keychain.
func IsLoggedIn() bool {
	token, _ := keyring.Get(keychainService, keyIDToken)
	return token != ""
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// getFirebaseToken returns a valid Firebase ID token, refreshing if near expiry.
func getFirebaseToken(firebaseAPIKey string) (string, error) {
	idToken, _ := keyring.Get(keychainService, keyIDToken)
	expiryStr, _ := keyring.Get(keychainService, keyExpiry)

	if idToken != "" && expiryStr != "" {
		expiry, err := time.Parse(time.RFC3339, expiryStr)
		if err == nil && time.Now().Add(5*time.Minute).Before(expiry) {
			return idToken, nil
		}
	}

	refreshToken, _ := keyring.Get(keychainService, keyRefreshToken)
	if refreshToken == "" {
		return "", fmt.Errorf("not logged in — run: tsq login")
	}
	return refreshIDToken(firebaseAPIKey, refreshToken)
}

// rotateCLIToken gets a fresh Firebase ID token and mints a new CLI token.
func rotateCLIToken(firebaseAPIKey, apiURL string) (string, error) {
	idToken, err := getFirebaseToken(firebaseAPIKey)
	if err != nil {
		return "", fmt.Errorf("refresh Firebase token for rotation: %w", err)
	}
	token, expiry, err := mintCLIToken(apiURL, idToken)
	if err != nil {
		return "", err
	}
	keyring.Set(keychainService, keyCLIToken, token)                              //nolint:errcheck
	keyring.Set(keychainService, keyCLITokenExpiry, expiry.Format(time.RFC3339)) //nolint:errcheck
	return token, nil
}

// mintCLIToken calls POST /auth/cli-token on the worker to get a new 90-day token.
func mintCLIToken(apiURL, firebaseIDToken string) (token string, expiry time.Time, err error) {
	req, err := http.NewRequest("POST", apiURL+"/auth/cli-token", strings.NewReader("{}"))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+firebaseIDToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("mint CLI token request: %w", err)
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, fmt.Errorf("mint CLI token HTTP %d: %s", resp.StatusCode, b)
	}

	var result struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"` // unix ms
	}
	if err := json.Unmarshal(b, &result); err != nil {
		return "", time.Time{}, fmt.Errorf("parse mint response: %w", err)
	}
	if result.Token == "" {
		return "", time.Time{}, fmt.Errorf("empty token in mint response")
	}

	return result.Token, time.UnixMilli(result.ExpiresAt), nil
}

// refreshIDToken exchanges a Firebase refresh token for a new ID token.
func refreshIDToken(apiKey, refreshToken string) (string, error) {
	endpoint := "https://securetoken.googleapis.com/v1/token?key=" + url.QueryEscape(apiKey)
	data := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}

	resp, err := http.PostForm(endpoint, data)
	if err != nil {
		return "", fmt.Errorf("token refresh: %w", err)
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token refresh HTTP %d: %s", resp.StatusCode, b)
	}

	var result struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    string `json:"expires_in"`
	}
	if err := json.Unmarshal(b, &result); err != nil {
		return "", fmt.Errorf("parse refresh response: %w", err)
	}
	if result.IDToken == "" {
		return "", fmt.Errorf("empty id_token in refresh response")
	}

	expiresIn := 3600
	if n, err := strconv.Atoi(result.ExpiresIn); err == nil {
		expiresIn = n
	}
	expiry := time.Now().Add(time.Duration(expiresIn) * time.Second).Format(time.RFC3339)
	keyring.Set(keychainService, keyIDToken, result.IDToken)           //nolint:errcheck
	keyring.Set(keychainService, keyRefreshToken, result.RefreshToken) //nolint:errcheck
	keyring.Set(keychainService, keyExpiry, expiry)                    //nolint:errcheck
	return result.IDToken, nil
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
