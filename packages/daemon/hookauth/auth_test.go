package hookauth

import (
	"os"
	"strings"
	"testing"
)

func TestCapabilityIsPrivatePersistentAndPortScoped(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a, err := LoadOrCreate(7374)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreate(7374)
	if err != nil || a != b || len(a) != 64 {
		t.Fatal("capability not stable")
	}
	c, err := LoadOrCreate(7375)
	if err != nil || c == a {
		t.Fatal("ports share capability")
	}
	info, _ := os.Stat(Path(7374))
	if info.Mode().Perm() != 0600 {
		t.Fatal("capability exposed")
	}
	if !strings.Contains(URL("http://localhost:7374/hooks/stop?agent=a"), "hook_token="+a) {
		t.Fatal("Claw capability missing")
	}
	if err := os.Chmod(Path(7374), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(7374); err == nil {
		t.Fatal("accepted exposed capability")
	}
}
