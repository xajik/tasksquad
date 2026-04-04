package agent

import "testing"

func TestBuildConversationPrompt_NoMessages(t *testing.T) {
	got := buildConversationPrompt("fix the bug", nil)
	if got != "fix the bug" {
		t.Errorf("got %q, want %q", got, "fix the bug")
	}
}

func TestBuildConversationPrompt_EmptySlice(t *testing.T) {
	got := buildConversationPrompt("subject", []interface{}{})
	if got != "subject" {
		t.Errorf("got %q, want subject", got)
	}
}

func TestBuildConversationPrompt_SingleMessage(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "hello"},
	}
	got := buildConversationPrompt("fallback", msgs)
	if got != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
}

func TestBuildConversationPrompt_SingleMessageEmptyBody(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": ""},
	}
	got := buildConversationPrompt("fallback", msgs)
	if got != "fallback" {
		t.Errorf("single message with empty body should fall back to subject, got %q", got)
	}
}

func TestBuildConversationPrompt_MultiTurn(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "Hello"},
		map[string]interface{}{"role": "agent", "body": "Hi there"},
		map[string]interface{}{"role": "user", "body": "How are you?"},
	}
	got := buildConversationPrompt("unused", msgs)
	if want := "Human: Hello\n\nAssistant: Hi there\n\nHuman: How are you?"; got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestBuildConversationPrompt_MultiTurnUnknownRoleSkipped(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "system", "body": "ignored"},
		map[string]interface{}{"role": "user", "body": "question"},
	}
	got := buildConversationPrompt("unused", msgs)
	if want := "Human: question"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
