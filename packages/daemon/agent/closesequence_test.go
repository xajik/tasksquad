package agent

import (
	"reflect"
	"testing"
)

// ── parseCloseSteps ───────────────────────────────────────────────────────────

func TestParseCloseSteps_ValidStrings(t *testing.T) {
	raw := []any{"/tsq-end-session-learning", "/tsq-memory", "clean up"}
	got := parseCloseSteps(raw)
	want := []string{"/tsq-end-session-learning", "/tsq-memory", "clean up"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestParseCloseSteps_SkipsEmptyStrings(t *testing.T) {
	raw := []any{"/tsq-learn", "", "  ", "/tsq-memory"}
	got := parseCloseSteps(raw)
	// empty strings filtered; "  " is non-empty so kept
	want := []string{"/tsq-learn", "  ", "/tsq-memory"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestParseCloseSteps_NilInput(t *testing.T) {
	if got := parseCloseSteps(nil); got != nil {
		t.Errorf("expected nil for nil input, got %v", got)
	}
}

func TestParseCloseSteps_NotSlice(t *testing.T) {
	if got := parseCloseSteps("a string"); got != nil {
		t.Errorf("expected nil for non-slice input, got %v", got)
	}
}

func TestParseCloseSteps_EmptySlice(t *testing.T) {
	got := parseCloseSteps([]any{})
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %v", got)
	}
}

func TestParseCloseSteps_NonStringEntries(t *testing.T) {
	raw := []any{"/tsq-learn", 42, true, "/tsq-memory"}
	got := parseCloseSteps(raw)
	want := []string{"/tsq-learn", "/tsq-memory"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("non-string entries should be ignored: got %v, want %v", got, want)
	}
}

// ── AgentState.CloseSteps ─────────────────────────────────────────────────────

func TestCloseSteps_EmptyByDefault(t *testing.T) {
	st := &AgentState{}
	pending, executed := st.CloseSteps()
	if len(pending) != 0 || len(executed) != 0 {
		t.Errorf("expected empty queues, got pending=%v executed=%v", pending, executed)
	}
}

func TestCloseSteps_ReturnsCopies(t *testing.T) {
	st := &AgentState{
		pendingSteps:  []string{"/tsq-a", "/tsq-b"},
		executedSteps: []string{"/tsq-done"},
	}
	pending, executed := st.CloseSteps()

	// Mutating the returned slices must not affect internal state.
	pending[0] = "mutated"
	executed[0] = "mutated"

	internalPending, internalExecuted := st.CloseSteps()
	if internalPending[0] != "/tsq-a" {
		t.Errorf("pendingSteps was mutated via returned slice")
	}
	if internalExecuted[0] != "/tsq-done" {
		t.Errorf("executedSteps was mutated via returned slice")
	}
}

// ── Close sequence queue state ────────────────────────────────────────────────

// advanceQueue simulates one successful step completion: moves the head of
// pendingSteps to executedSteps, mirroring what advanceCloseStep does before
// deciding to inject or complete.
func advanceQueue(st *AgentState) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.pendingSteps) > 0 {
		done := st.pendingSteps[0]
		st.executedSteps = append(st.executedSteps, done)
		st.pendingSteps = st.pendingSteps[1:]
	}
}

func TestCloseQueue_AdvancesCorrectly(t *testing.T) {
	st := &AgentState{
		mode:         ModeLearning,
		pendingSteps: []string{"/tsq-learn", "/tsq-memory", "clean up"},
	}

	// Step 1 completes
	advanceQueue(st)
	pending, executed := st.CloseSteps()
	if !reflect.DeepEqual(executed, []string{"/tsq-learn"}) {
		t.Errorf("after step 1: executed=%v", executed)
	}
	if !reflect.DeepEqual(pending, []string{"/tsq-memory", "clean up"}) {
		t.Errorf("after step 1: pending=%v", pending)
	}

	// Step 2 completes
	advanceQueue(st)
	pending, executed = st.CloseSteps()
	if !reflect.DeepEqual(executed, []string{"/tsq-learn", "/tsq-memory"}) {
		t.Errorf("after step 2: executed=%v", executed)
	}
	if !reflect.DeepEqual(pending, []string{"clean up"}) {
		t.Errorf("after step 2: pending=%v", pending)
	}

	// Step 3 completes — queue drained
	advanceQueue(st)
	pending, executed = st.CloseSteps()
	if len(pending) != 0 {
		t.Errorf("pending should be empty after all steps: %v", pending)
	}
	if !reflect.DeepEqual(executed, []string{"/tsq-learn", "/tsq-memory", "clean up"}) {
		t.Errorf("all steps should be in executed: %v", executed)
	}
}

func TestCloseQueue_AdvanceOnEmpty(t *testing.T) {
	st := &AgentState{mode: ModeLearning}
	advanceQueue(st) // must not panic
	pending, executed := st.CloseSteps()
	if len(pending) != 0 || len(executed) != 0 {
		t.Errorf("advance on empty queue should leave it empty")
	}
}

func TestCloseQueue_SingleStep(t *testing.T) {
	st := &AgentState{
		mode:         ModeLearning,
		pendingSteps: []string{"/tsq-end-session-learning"},
	}
	advanceQueue(st)
	pending, executed := st.CloseSteps()
	if len(pending) != 0 {
		t.Errorf("pending should be empty: %v", pending)
	}
	if len(executed) != 1 || executed[0] != "/tsq-end-session-learning" {
		t.Errorf("expected executed=['/tsq-end-session-learning'], got %v", executed)
	}
}

// ── injectNextStep (state only, no tmux) ─────────────────────────────────────

func TestInjectNextStep_DoesNotPanicOnEmptyQueue(t *testing.T) {
	a := &Agent{st: &AgentState{mode: ModeLearning}}
	// Should return immediately without panicking.
	a.injectNextStep("")
}

// ── State transitions for close sequence ─────────────────────────────────────

func TestTransition_WaitingInput_ToLearning(t *testing.T) {
	st := &AgentState{mode: ModeWaitingInput}
	if err := st.Transition(EventLearnStart); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if st.ModeValue() != ModeLearning {
		t.Errorf("expected ModeLearning, got %q", st.ModeValue())
	}
}

func TestTransition_Learning_ToIdle_ViaCompleted(t *testing.T) {
	st := &AgentState{mode: ModeLearning}
	if err := st.Transition(EventCompleted); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if st.ModeValue() != ModeIdle {
		t.Errorf("expected ModeIdle, got %q", st.ModeValue())
	}
}

func TestTransition_Learning_InvalidEvents(t *testing.T) {
	invalid := []AgentEvent{EventHookStop, EventUserReplied, EventHookNotification, EventLearnStart}
	for _, ev := range invalid {
		st := &AgentState{mode: ModeLearning}
		if err := st.Transition(ev); err == nil {
			t.Errorf("event %q should be invalid from ModeLearning", ev)
		}
		if st.ModeValue() != ModeLearning {
			t.Errorf("mode must not change on invalid transition for event %q", ev)
		}
	}
}
