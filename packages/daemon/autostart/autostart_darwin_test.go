package autostart

import (
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistrationDoesNotLaunchOrKillDaemon(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// No executable can be invoked: registration must only affect the next login.
	t.Setenv("PATH", t.TempDir())
	executable := "/Applications/Task & Squad.app/Contents/MacOS/TaskSquad"
	if err := Enable(executable); err != nil {
		t.Fatal(err)
	}
	if !IsEnabled() {
		t.Fatal("registration missing")
	}
	p, _ := plistPath()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	d := xml.NewDecoder(strings.NewReader(string(data)))
	found := false
	for {
		token, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if text, ok := token.(xml.CharData); ok && string(text) == executable {
			found = true
		}
	}
	if !found {
		t.Fatal("executable did not survive XML escaping")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".tasksquad/logs")); err != nil {
		t.Fatal(err)
	}
	if err := Disable(); err != nil {
		t.Fatal(err)
	}
	if IsEnabled() {
		t.Fatal("registration remains")
	}
	if err := Disable(); err != nil {
		t.Fatal(err)
	}
}
