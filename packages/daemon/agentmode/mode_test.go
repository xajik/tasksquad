package agentmode

import "testing"

func TestModeConstants(t *testing.T) {
	if string(ModeIdle) != "idle" {
		t.Errorf("ModeIdle = %q, want idle", ModeIdle)
	}
	if string(ModeRunning) != "running" {
		t.Errorf("ModeRunning = %q", ModeRunning)
	}
	if string(ModeWaitingInput) != "waiting_input" {
		t.Errorf("ModeWaitingInput = %q", ModeWaitingInput)
	}
	if string(ModeLearning) != "wrapping_up" {
		t.Errorf("ModeLearning = %q", ModeLearning)
	}
}

func TestStatusConstants(t *testing.T) {
	if string(StatusClosed) != "closed" {
		t.Errorf("StatusClosed = %q", StatusClosed)
	}
	if string(StatusCrashed) != "crashed" {
		t.Errorf("StatusCrashed = %q", StatusCrashed)
	}
	if string(StatusCancelled) != "cancelled" {
		t.Errorf("StatusCancelled = %q", StatusCancelled)
	}
}

func TestModeIsStringType(t *testing.T) {
	var m Mode = ModeRunning
	if m != "running" {
		t.Error("Mode should be directly comparable to string constant")
	}
}
