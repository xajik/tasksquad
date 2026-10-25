package util

import "regexp"

var resourceNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`)

// ValidResourceName reports whether a skill, command or sub-agent name received from
// the server is safe to use as a single path segment: letters, digits, '_' and '-',
// starting with a letter or digit, at most 100 characters. Same rule as the worker's
// validResourceName (packages/worker/src/routes/helpers.ts) and HarnessLayout.isSafe
// in tsq-core.
func ValidResourceName(name string) bool {
	return resourceNameRE.MatchString(name)
}
