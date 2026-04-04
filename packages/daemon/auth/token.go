package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

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
				return cliToken, nil

			case daysLeft > 0:
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
	keyring.Set(keychainService, keyCLIToken, newCLI)                               //nolint:errcheck
	keyring.Set(keychainService, keyCLITokenExpiry, cliExpiry.Format(time.RFC3339)) //nolint:errcheck
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
	keyring.Set(keychainService, keyCLIToken, token)                             //nolint:errcheck
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
