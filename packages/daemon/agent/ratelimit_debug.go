//go:build debug

package agent

import "time"

// minHeartbeatInterval is unrestricted in debug builds.
const minHeartbeatInterval = time.Duration(0)
