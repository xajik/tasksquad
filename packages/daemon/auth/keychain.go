package auth

import "github.com/zalando/go-keyring"

const (
	keychainService   = "tasksquad-daemon"
	keyIDToken        = "id-token"
	keyRefreshToken   = "refresh-token"
	keyExpiry         = "expiry"
	keyEmail          = "email"
	keyCLIToken       = "cli-token"
	keyCLITokenExpiry = "cli-token-expiry"
)

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

// Logout removes all stored credentials from the OS keychain.
func Logout() error {
	for _, key := range []string{keyIDToken, keyRefreshToken, keyExpiry, keyEmail, keyCLIToken, keyCLITokenExpiry} {
		if err := keyring.Delete(keychainService, key); err != nil && err != keyring.ErrNotFound {
			return err
		}
	}
	return nil
}
