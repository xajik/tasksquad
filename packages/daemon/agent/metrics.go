package agent

import (
	"fmt"
	"os"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/metrics"
)

// recordTyped counts a turn the daemon typed and the TaskSquad skill tokens in it.
func (a *Agent) recordTyped(text string) {
	skills := metrics.Skills(text)
	a.st.mu.Lock()
	a.st.typedTurns++
	a.st.typedSkills = append(a.st.typedSkills, skills...)
	a.st.mu.Unlock()
}

// postSessionReport sends the session's aggregate usage (counts only, never
// content) for the analytics dashboard. Best-effort and asynchronous: parsing
// a large transcript or an older worker without the endpoint never affects
// the task.
func (a *Agent) postSessionReport(cfg *config.Config, sessionID string, startedAt time.Time, transcriptPath string) {
	if sessionID == "" {
		return
	}
	a.st.mu.Lock()
	turns := a.st.typedTurns
	skills := append([]string(nil), a.st.typedSkills...)
	thread := a.st.cliSessionID
	a.st.mu.Unlock()
	provider, workDir := a.Provider(), a.Config.WorkDir

	go func() {
		r := metrics.New(provider)
		if !startedAt.IsZero() {
			r.DurationMs = time.Since(startedAt).Milliseconds()
		}
		r.Turns = turns
		for _, s := range skills {
			r.AddSkill(s)
		}
		if home, err := os.UserHomeDir(); err == nil {
			if path := metrics.Transcript(provider, workDir, transcriptPath, thread, startedAt, home); path != "" {
				metrics.Read(path, provider, r)
			}
		}
		if _, err := a.post(cfg, "/daemon/session/metrics", r.Body(sessionID)); err != nil {
			logger.Debug(fmt.Sprintf("[%s] session report not accepted: %v", a.Config.Name, err))
		}
	}()
}
