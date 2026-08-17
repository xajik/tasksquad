package agent

import (
	"testing"
)

// ── Transition ────────────────────────────────────────────────────────────────

func TestTransition_ValidPaths(t *testing.T) {
	cases := []struct {
		name   string
		start  Mode
		events []AgentEvent
		want   Mode
	}{
		{
			name:   "idle → running via task started",
			start:  ModeIdle,
			events: []AgentEvent{EventTaskStarted},
			want:   ModeRunning,
		},
		{
			name:   "running → waiting_input via stop hook",
			start:  ModeRunning,
			events: []AgentEvent{EventHookStop},
			want:   ModeWaitingInput,
		},
		{
			name:   "running → waiting_input via notification hook",
			start:  ModeRunning,
			events: []AgentEvent{EventHookNotification},
			want:   ModeWaitingInput,
		},
		{
			name:   "waiting_input → running via user reply",
			start:  ModeWaitingInput,
			events: []AgentEvent{EventUserReplied},
			want:   ModeRunning,
		},
		{
			name:   "waiting_input → learning",
			start:  ModeWaitingInput,
			events: []AgentEvent{EventLearnStart},
			want:   ModeLearning,
		},
		{
			name:   "running → idle via completed",
			start:  ModeRunning,
			events: []AgentEvent{EventCompleted},
			want:   ModeIdle,
		},
		{
			name:   "learning → idle via completed",
			start:  ModeLearning,
			events: []AgentEvent{EventCompleted},
			want:   ModeIdle,
		},
		{
			name:   "any mode → idle via reset (from running)",
			start:  ModeRunning,
			events: []AgentEvent{EventReset},
			want:   ModeIdle,
		},
		{
			name:   "waiting_input → idle via user closed",
			start:  ModeWaitingInput,
			events: []AgentEvent{EventUserClosed},
			want:   ModeIdle,
		},
		{
			name:   "full task round-trip",
			start:  ModeIdle,
			events: []AgentEvent{EventTaskStarted, EventHookStop, EventUserReplied, EventCompleted},
			want:   ModeIdle,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := &AgentState{mode: tc.start}
			for _, ev := range tc.events {
				if err := st.Transition(ev); err != nil {
					t.Fatalf("unexpected error on event %q: %v", ev, err)
				}
			}
			if got := st.ModeValue(); got != tc.want {
				t.Errorf("got mode %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTransition_InvalidRejected(t *testing.T) {
	cases := []struct {
		start Mode
		event AgentEvent
	}{
		{ModeIdle, EventHookStop},
		{ModeIdle, EventUserReplied},
		{ModeIdle, EventCompleted},
		{ModeRunning, EventLearnStart},
		{ModeRunning, EventUserClosed},
		{ModeLearning, EventHookStop},
		{ModeLearning, EventUserReplied},
	}

	for _, tc := range cases {
		st := &AgentState{mode: tc.start}
		if err := st.Transition(tc.event); err == nil {
			t.Errorf("expected error for %q -[%q]-> but got none", tc.start, tc.event)
		}
		if got := st.ModeValue(); got != tc.start {
			t.Errorf("mode changed on invalid transition: was %q, now %q", tc.start, got)
		}
	}
}

func TestTransition_ModeUnchangedOnError(t *testing.T) {
	st := &AgentState{mode: ModeIdle}
	_ = st.Transition(EventHookStop) // invalid
	if st.ModeValue() != ModeIdle {
		t.Error("mode must not change when Transition returns an error")
	}
}

// ── Accessors ─────────────────────────────────────────────────────────────────

func TestAgentState_ModeString(t *testing.T) {
	st := &AgentState{mode: ModeRunning}
	if st.Mode() != "running" {
		t.Errorf("Mode() = %q, want \"running\"", st.Mode())
	}
}

func TestAgentState_Paused(t *testing.T) {
	st := &AgentState{}
	if st.Paused() {
		t.Error("new state should not be paused")
	}
	st.paused = true
	if !st.Paused() {
		t.Error("expected paused=true")
	}
}

// ── PinCLISessionID ───────────────────────────────────────────────────────────

func TestPinCLISessionID_EmptyAlwaysAllowed(t *testing.T) {
	st := &AgentState{}
	if !st.PinCLISessionID("") {
		t.Error("empty session_id should always be allowed (provider doesn't report one)")
	}
	if !st.PinCLISessionID("real-session") {
		t.Error("pinning a real session_id after an empty one should succeed")
	}
	// Once pinned, empty is still allowed (no-op check), but must not clear the pin.
	if !st.PinCLISessionID("") {
		t.Error("empty session_id should still be allowed after a pin exists")
	}
	if !st.PinCLISessionID("real-session") {
		t.Error("the originally pinned session_id should still match")
	}
}

func TestPinCLISessionID_FirstCallPins(t *testing.T) {
	st := &AgentState{}
	if !st.PinCLISessionID("session-a") {
		t.Error("first call should pin and return true")
	}
	if !st.PinCLISessionID("session-a") {
		t.Error("matching the pinned session_id should return true")
	}
}

func TestPinCLISessionID_MismatchRejected(t *testing.T) {
	st := &AgentState{}
	st.PinCLISessionID("session-a")
	if st.PinCLISessionID("session-b") {
		t.Error("a different session_id after pinning should be rejected")
	}
	// Rejection must not overwrite the pin.
	if !st.PinCLISessionID("session-a") {
		t.Error("the original pin should still be intact after a rejected mismatch")
	}
}

// ── TUIBlocked ────────────────────────────────────────────────────────────────

func TestSetTUIBlocked_OnlyAppliesWhileRunning(t *testing.T) {
	st := &AgentState{mode: ModeIdle}
	st.SetTUIBlocked(true)
	if st.TUIBlocked() {
		t.Error("SetTUIBlocked(true) should no-op outside ModeRunning")
	}

	st.mode = ModeRunning
	st.SetTUIBlocked(true)
	if !st.TUIBlocked() {
		t.Error("SetTUIBlocked(true) should take effect in ModeRunning")
	}
}

func TestTransition_ClearsTUIBlocked(t *testing.T) {
	st := &AgentState{mode: ModeRunning, tuiBlocked: true}
	if err := st.Transition(EventHookStop); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if st.TUIBlocked() {
		t.Error("any successful mode transition should clear tuiBlocked")
	}
}

func TestTransition_InvalidLeavesTUIBlockedUnchanged(t *testing.T) {
	st := &AgentState{mode: ModeIdle, tuiBlocked: true}
	if err := st.Transition(EventHookStop); err == nil {
		t.Fatal("expected invalid transition to error")
	}
	if !st.TUIBlocked() {
		t.Error("a rejected transition must not clear tuiBlocked (mode never changed)")
	}
}
