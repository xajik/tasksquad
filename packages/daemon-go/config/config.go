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
	Token        string `toml:"token"`
	TeamID       string `toml:"team_id"`
	PollInterval int    `toml:"poll_interval"`
}

type AgentConfig struct {
	ID      string `toml:"id"`
	Name    string `toml:"name"`
	Command string `toml:"command"`
	WorkDir string `toml:"work_dir"`
}

type StuckDetectionConfig struct {
	TimeoutSeconds int    `toml:"timeout_seconds"`
	OnStuck        string `toml:"on_stuck"`
}

type HooksConfig struct {
	Port int `toml:"port"`
}

type Config struct {
	Server         ServerConfig         `toml:"server"`
	Agents         []AgentConfig        `toml:"agents"`
	StuckDetection StuckDetectionConfig `toml:"stuck_detection"`
	Hooks          HooksConfig          `toml:"hooks"`
}

func (c *Config) setDefaults() {
	if c.Server.PollInterval == 0 {
		c.Server.PollInterval = 30
	}
	if c.Hooks.Port == 0 {
		c.Hooks.Port = 7374
	}
	if c.StuckDetection.TimeoutSeconds == 0 {
		c.StuckDetection.TimeoutSeconds = 120
	}
	if c.StuckDetection.OnStuck == "" {
		c.StuckDetection.OnStuck = "notify"
	}
}

func expandHome(path string) string {
	if len(path) >= 2 && path[:2] == "~/" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

func Load() (*Config, error) {
	home, _ := os.UserHomeDir()
	configPath := filepath.Join(home, ".tasksquad", "config.toml")

	cfg := &Config{}

	_, err := toml.DecodeFile(configPath, cfg)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("config file not found at %s", configPath)
		}
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	for i := range cfg.Agents {
		cfg.Agents[i].WorkDir = expandHome(cfg.Agents[i].WorkDir)
	}

	cfg.setDefaults()

	if cfg.Server.Token == "" {
		return nil, fmt.Errorf("server.token is required")
	}
	if cfg.Server.TeamID == "" {
		return nil, fmt.Errorf("server.team_id is required")
	}

	return cfg, nil
}

func Watch(cfg *Config, onChange func(*Config)) error {
	home, _ := os.UserHomeDir()
	configPath := filepath.Join(home, ".tasksquad", "config.toml")

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("failed to create watcher: %w", err)
	}

	dir := filepath.Dir(configPath)
	if err := watcher.Add(dir); err != nil {
		return fmt.Errorf("failed to watch config dir: %w", err)
	}

	go func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
					if filepath.Clean(event.Name) == filepath.Clean(configPath) {
						newCfg, err := Load()
						if err != nil {
							fmt.Printf("Error reloading config: %v\n", err)
							continue
						}
						onChange(newCfg)
					}
				}
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				fmt.Printf("Watcher error: %v\n", err)
			}
		}
	}()

	return nil
}
