package agent

import (
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
)

// Runtimes returns a snapshot. Each task owns its process, state machine, relay and hooks.
func (a *Agent) Runtimes() []*Agent {
	a.slotsMu.Lock()
	defer a.slotsMu.Unlock()
	runtimes := []*Agent{a}
	for _, slot := range a.slots {
		if slot != a {
			runtimes = append(runtimes, slot)
		}
	}
	return runtimes
}

func (a *Agent) HookRuntimes() []hooks.Agent {
	var result []hooks.Agent
	for _, slot := range a.Runtimes() {
		result = append(result, slot)
	}
	return result
}

func (a *Agent) activeTasks() []map[string]any {
	active := make([]map[string]any, 0)
	for _, slot := range a.Runtimes() {
		slot.st.mu.Lock()
		if slot.st.mode != ModeIdle && slot.st.taskID != "" {
			entry := map[string]any{"task_id": slot.st.taskID, "status": slot.st.mode, "tui_blocked": slot.st.tuiBlocked}
			if slot.st.mode == ModeLearning {
				entry["close_step_idx"] = len(slot.st.executedSteps)
			}
			active = append(active, entry)
		}
		slot.st.mu.Unlock()
	}
	return active
}

func (a *Agent) startOffer(cfg *config.Config, offer map[string]any) {
	task, _ := offer["task"].(map[string]any)
	id, _ := task["id"].(string)
	if id == "" || a.IsPaused() {
		return
	}
	a.slotsMu.Lock()
	if a.slots == nil {
		a.slots = make(map[string]*Agent)
	}
	if a.slots[id] != nil {
		a.slotsMu.Unlock()
		return
	}
	slot := a
	for _, other := range a.slots {
		if other == a {
			slot = New(a.Config)
			break
		}
	}
	if slot == a && a.st.ModeValue() != ModeIdle {
		slot = New(a.Config)
	}
	a.slots[id] = slot
	a.slotsMu.Unlock()
	rollup, _ := offer["memory_rollup"].(string)
	go func() {
		slot.startTask(cfg, task, rollup)
		a.slotsMu.Lock()
		delete(a.slots, id)
		a.slotsMu.Unlock()
	}()
}

func (a *Agent) processParallel(cfg *config.Config, response map[string]any) {
	for _, slot := range a.Runtimes() {
		if reset, _ := response["reset"].(bool); reset && slot != a {
			slot.processResponse(cfg, response)
			continue
		}
		updates, _ := response["task_updates"].([]any)
		for _, raw := range updates {
			update, _ := raw.(map[string]any)
			if id, _ := update["task_id"].(string); id != "" && id == slot.GetTaskID() {
				slot.processResponse(cfg, update)
			}
		}
	}
	a.processResponse(cfg, response)
	offers, _ := response["offers"].([]any)
	for _, raw := range offers {
		if offer, ok := raw.(map[string]any); ok {
			a.startOffer(cfg, offer)
		}
	}
}
