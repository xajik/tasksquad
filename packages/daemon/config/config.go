package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/fsnotify/fsnotify"
)

type ServerConfig struct {
	URL          string `toml:"url"`
	PollInterval int    `toml:"poll_interval"`
}

// AgentConfig holds per-agent settings. The token uniquely identifies the agent
// on the server — no separate agent_id or team_id needed.
type AgentConfig struct {
	Token   string `toml:"token"`
	Name    string `toml:"name"`
	Command string `toml:"command"`
	WorkDir string `toml:"work_dir"`
	// Provider selects the hook integration for the CLI tool.
	// Valid values: "claude-code", "opencode", "codex", "stdout".
	// Auto-detected from the command binary name when empty.
	Provider string `toml:"provider"`
}

type HooksConfig struct {
	Port int `toml:"port"`
}

type Config struct {
	Server ServerConfig  `toml:"server"`
	Agents []AgentConfig `toml:"agents"`
	Hooks  HooksConfig   `toml:"hooks"`
}

func setDefaults(cfg *Config) {
	if cfg.Server.PollInterval == 0 {
		cfg.Server.PollInterval = 30
	}
	if cfg.Hooks.Port == 0 {
		cfg.Hooks.Port = 7374
	}
}

func expandHome(path string) string {
	if len(path) >= 2 && path[:2] == "~/" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

func DefaultPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "config.toml")
}

func Load(path string) (*Config, error) {
	cfg := &Config{}

	if _, err := toml.DecodeFile(path, cfg); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("config file not found at %s", path)
		}
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	setDefaults(cfg)

	if cfg.Server.URL == "" {
		return nil, fmt.Errorf("server.url is required")
	}
	if len(cfg.Agents) == 0 {
		return nil, fmt.Errorf("at least one [[agents]] entry is required")
	}
	for i, a := range cfg.Agents {
		if a.Token == "" {
			return nil, fmt.Errorf("agents[%d].token is required", i)
		}
		cfg.Agents[i].WorkDir = expandHome(a.WorkDir)
	}

	return cfg, nil
}

func Watch(path string, onChange func(*Config)) (func(), error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := w.Add(filepath.Dir(path)); err != nil {
		w.Close()
		return nil, err
	}
	go func() {
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if (ev.Has(fsnotify.Write) || ev.Has(fsnotify.Create)) &&
					filepath.Clean(ev.Name) == filepath.Clean(path) {
					if cfg, err := Load(path); err == nil {
						onChange(cfg)
					}
				}
			case _, ok := <-w.Errors:
				if !ok {
					return
				}
			}
		}
	}()
	return func() { w.Close() }, nil
}
