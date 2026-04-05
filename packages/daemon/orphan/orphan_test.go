package orphan

import (
	"testing"
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
