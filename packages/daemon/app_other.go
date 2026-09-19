//go:build !darwin

package main

import (
	"fmt"
	"os"
)

func prepareAppEnvironment()                   {}
func acquireDaemonLock(string) (func(), error) { return func() {}, nil }
func startAppSetup(string) (bool, error)       { return false, nil }
func startupError(err error)                   { fmt.Fprintln(os.Stderr, err) }
