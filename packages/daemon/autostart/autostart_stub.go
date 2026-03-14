//go:build !darwin && !linux && !windows

// Package autostart manages registering the tsq daemon to start on OS boot.
package autostart

import "errors"

var errUnsupported = errors.New("autostart: unsupported platform")

// IsEnabled always returns false on unsupported platforms.
func IsEnabled() bool { return false }

// Enable returns an error on unsupported platforms.
func Enable(_ string) error { return errUnsupported }

// Disable returns an error on unsupported platforms.
func Disable() error { return errUnsupported }
