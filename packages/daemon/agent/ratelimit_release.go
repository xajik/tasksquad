//go:build !debug

package agent

import "time"

// minHeartbeatInterval enforces a minimum of 5 seconds between heartbeats
// in release builds to prevent accidental server hammering.
const minHeartbeatInterval = 5 * time.Second
