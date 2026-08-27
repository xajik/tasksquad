package main

import (
	"sync"
	"time"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/autostart"
)

// agentController implements the ui.AgentController interface.
// It fans Pause/Resume/IsPaused calls out to all configured agents.
type agentController struct {
	agents []*agent.Agent
}

func (c *agentController) Pause() {
	for _, a := range c.agents {
		a.Pause()
	}
}

func (c *agentController) Resume() {
	for _, a := range c.agents {
		a.Resume()
	}
}

func (c *agentController) IsPaused() bool {
	if len(c.agents) == 0 {
		return false
	}
	return c.agents[0].IsPaused()
}

// CloseActivePortals implements ui.ShutdownController — fans out to every
// agent in parallel so the wait is bounded by timeout, not by the number of
// agents with an active portal (there's normally at most one anyway).
func (c *agentController) CloseActivePortals(timeout time.Duration) {
	var wg sync.WaitGroup
	for _, a := range c.agents {
		wg.Add(1)
		go func(a *agent.Agent) {
			defer wg.Done()
			a.CloseActivePortal(timeout)
		}(a)
	}
	wg.Wait()
}

// mainAuthController implements the ui.AuthController interface.
type mainAuthController struct{}

func (c *mainAuthController) Email() string { return auth.GetEmail() }
func (c *mainAuthController) Logout() error { return auth.Logout() }

// mainAutostartController implements the ui.AutostartController interface.
type mainAutostartController struct{ execPath string }

func (c *mainAutostartController) IsEnabled() bool { return autostart.IsEnabled() }
func (c *mainAutostartController) Enable() error   { return autostart.Enable(c.execPath) }
func (c *mainAutostartController) Disable() error  { return autostart.Disable() }
