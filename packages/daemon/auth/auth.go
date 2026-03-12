// Package auth manages Firebase credentials for the tsq daemon via the OS keychain.
//
// Flow:
//  1. tsq login → opens browser to portal /auth/cli, waits for local callback,
//     stores Firebase ID token + refresh token in OS keychain.
//  2. tsq (run) → GetToken() loads the stored token, refreshing it when near
//     expiry via the Firebase token-refresh REST endpoint.
//  3. tsq logout → deletes all stored credentials from the keychain.
package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	keychainService = "tasksquad-daemon"
	keyIDToken      = "id-token"
	keyRefreshToken = "refresh-token"
	keyExpiry       = "expiry"
	keyEmail        = "email"
)

// Login opens a browser to the portal's CLI auth page, waits for the OAuth
// callback on a local HTTP server, and stores the resulting Firebase credentials
// in the OS keychain.  dashboardURL is the portal base URL (e.g. "https://app.tasksquad.ai").
//
// The portal /auth/cli page must redirect to the callback URL with query params:
//
//	id_token=<firebase-id-token>&refresh_token=<refresh-token>&email=<user-email>
func Login(dashboardURL string) (email string, err error) {
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
		expiry := time.Now().Add(time.Hour).Format(time.RFC3339)
		if setErr := keyring.Set(keychainService, keyIDToken, res.idToken); setErr != nil {
			return "", fmt.Errorf("save id token: %w", setErr)
		}
		if res.refreshToken != "" {
			keyring.Set(keychainService, keyRefreshToken, res.refreshToken) //nolint:errcheck
		}
		keyring.Set(keychainService, keyExpiry, expiry)    //nolint:errcheck
		keyring.Set(keychainService, keyEmail, res.email)  //nolint:errcheck
		return res.email, nil
	case <-time.After(5 * time.Minute):
		return "", fmt.Errorf("login timed out (5 minutes)")
	}
}

// Logout removes all stored Firebase credentials from the OS keychain.
func Logout() error {
	for _, key := range []string{keyIDToken, keyRefreshToken, keyExpiry, keyEmail} {
		if err := keyring.Delete(keychainService, key); err != nil && err != keyring.ErrNotFound {
			return err
		}
	}
	return nil
}

// GetToken returns a valid Firebase ID token. If the stored token is within
// 5 minutes of expiry it is refreshed using the stored refresh token.
// Returns an error if the user is not logged in.
func GetToken(firebaseAPIKey string) (string, error) {
	idToken, _ := keyring.Get(keychainService, keyIDToken)
	expiryStr, _ := keyring.Get(keychainService, keyExpiry)

	if idToken != "" && expiryStr != "" {
		expiry, err := time.Parse(time.RFC3339, expiryStr)
		if err == nil && time.Now().Add(5*time.Minute).Before(expiry) {
			return idToken, nil
		}
	}

	// Attempt token refresh.
	refreshToken, _ := keyring.Get(keychainService, keyRefreshToken)
	if refreshToken == "" {
		return "", fmt.Errorf("not logged in — run: tsq login")
	}
	return refreshIDToken(firebaseAPIKey, refreshToken)
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

// refreshIDToken exchanges a Firebase refresh token for a new ID token using
// the Firebase REST token endpoint.
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
	keyring.Set(keychainService, keyIDToken, result.IDToken)        //nolint:errcheck
	keyring.Set(keychainService, keyRefreshToken, result.RefreshToken) //nolint:errcheck
	keyring.Set(keychainService, keyExpiry, expiry)                 //nolint:errcheck
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
