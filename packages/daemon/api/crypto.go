package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

// EncryptGCM encrypts data using AES-256-GCM with the provided base64-encoded key.
// It prepends a 12-byte random IV to the ciphertext.
func EncryptGCM(dekB64 string, data []byte) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(dekB64)
	if err != nil {
		return nil, fmt.Errorf("invalid DEK encoding: %v", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	// Seal appends the ciphertext to the nonce (IV)
	return gcm.Seal(nonce, nonce, data, nil), nil
}
