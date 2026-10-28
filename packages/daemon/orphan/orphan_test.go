package orphan

import (
	"testing"
	"time"
)

func TestIsOrphan(t *testing.T) {
	tests := []struct {
		name       string
		state      SessionState
		wantOrphan bool
	}{
		{
			name:       "done status is orphan",
			state:      SessionState{TaskStatus: "done"},
			wantOrphan: true,
		},
		{
			name:       "failed status is orphan",
			state:      SessionState{TaskStatus: "failed"},
			wantOrphan: true,
		},
		{
			name:       "running status is not orphan",
			state:      SessionState{TaskStatus: "running"},
			wantOrphan: false,
		},
		{
			name:       "waiting_input status is not orphan",
			state:      SessionState{TaskStatus: "waiting_input"},
			wantOrphan: false,
		},
		{
			name:       "pending status is not orphan",
			state:      SessionState{TaskStatus: "pending"},
			wantOrphan: false,
		},
		{
			name:       "empty status is not orphan",
			state:      SessionState{TaskStatus: ""},
			wantOrphan: false,
		},
	}

	oc := &OrphanController{}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := oc.isOrphan(tt.state)
			if got != tt.wantOrphan {
				t.Errorf("isOrphan() = %v, want %v", got, tt.wantOrphan)
			}
		})
	}
}

func TestSessionStateFields(t *testing.T) {
	state := SessionState{
		TaskID:        "01KNT4ABCD",
		TaskStatus:    "done",
		SessionStatus: "closed",
	}

	if state.TaskID != "01KNT4ABCD" {
		t.Errorf("TaskID = %q, want 01KNT4ABCD", state.TaskID)
	}
	if state.TaskStatus != "done" {
		t.Errorf("TaskStatus = %q, want done", state.TaskStatus)
	}
	if state.SessionStatus != "closed" {
		t.Errorf("SessionStatus = %q, want closed", state.SessionStatus)
	}
}

func TestTaskSessionNames(t *testing.T) {
	for _, prefix := range []string{"tsq-sup-", "tsq-portal-", "tsq-stm-", "tsq-dream-", "tsq-kbinit-", "personal-"} {
		if isTaskSessionName(prefix + "123") {
			t.Error("auxiliary session treated as orphan candidate", prefix)
		}
	}
	if !isTaskSessionName("tsq-01SESSION") {
		t.Error("task session skipped")
	}
}

func TestIsUntracked(t *testing.T) {
	now := time.Now()
	c := &OrphanController{startedAt: now.Add(-time.Minute), created: map[string]time.Time{
		"old":      now.Add(-time.Hour),
		"fresh":    now.Add(-10 * time.Second),
		"mine":     now.Add(-time.Hour),
		"previous": now.Add(-90 * time.Second), // before this daemon started: no grace
	}}
	if c.isUntracked("old", now) {
		t.Fatal("without a tracker nothing is untracked")
	}
	c.WithTracked(func(name string) bool { return name == "tsq-mine" })
	for sid, want := range map[string]bool{"old": true, "fresh": false, "mine": false, "unknown": false, "previous": true} {
		if got := c.isUntracked(sid, now); got != want {
			t.Errorf("isUntracked(%q) = %v, want %v", sid, got, want)
		}
	}
}
