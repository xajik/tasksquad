package config

import (
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

func DefaultPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "config.toml")
}

func Load(path string) (*Config, error) {
	cfg := &Config{}
	cfg.Server.PollInterval = 30
	cfg.Hooks.Port = 7374
	cfg.StuckDetection.TimeoutSeconds = 120
	cfg.StuckDetection.OnStuck = "notify"

	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func Watch(path string, onChange func(*Config)) (func(), error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := w.Add(path); err != nil {
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
				if ev.Has(fsnotify.Write) {
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
