package provider

import (
	"runtime"
	"sync"
)

var setupMu sync.Mutex

// Shared project plugins resolve their owner from the CLI process environment.
// Per-invocation providers continue to receive concrete IDs through SetupArgs.
func SetupForTask(p Provider, workDir string, port int, agentID, taskID string) error {
	setupMu.Lock()
	defer setupMu.Unlock()
	switch p.Name() {
	case "gemini", "claw":
		agentID, taskID = "$TSQ_AGENT_ID", "$TSQ_TASK_ID"
		if runtime.GOOS == "windows" && p.Name() == "gemini" {
			agentID, taskID = "%TSQ_AGENT_ID%", "%TSQ_TASK_ID%"
		}
	case "pi", "opencode":
		agentID = `" + encodeURIComponent(process.env.TSQ_AGENT_ID ?? "") + "`
		taskID = `" + encodeURIComponent(process.env.TSQ_TASK_ID ?? "") + "`
	}
	return p.Setup(workDir, port, agentID, taskID)
}
