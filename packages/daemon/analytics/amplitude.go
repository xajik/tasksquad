package analytics

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

type Config struct {
	APIKey  string `toml:"api_key"`
	Enabled bool   `toml:"enabled"`
}

type Event struct {
	EventType  string                 `json:"event_type"`
	DeviceID   string                 `json:"device_id"`
	Time       int64                  `json:"time"`
	AppVersion string                 `json:"app_version,omitempty"`
	OsName     string                 `json:"os_name,omitempty"`
	OsVersion  string                 `json:"os_version,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
	UserID     string                 `json:"user_id,omitempty"`
	SessionID  int64                  `json:"session_id,omitempty"`
}

type Client struct {
	apiKey     string
	enabled    bool
	deviceID   string
	appVersion string
	httpClient *http.Client
	queue      chan Event
	wg         sync.WaitGroup
	closed     bool
}

var (
	globalClient *Client
	globalMu     sync.RWMutex
)

func Init(cfg Config, deviceID, appVersion string) {
	globalMu.Lock()
	defer globalMu.Unlock()

	if !cfg.Enabled || cfg.APIKey == "" {
		globalClient = &Client{enabled: false}
		return
	}

	globalClient = &Client{
		apiKey:     cfg.APIKey,
		enabled:    true,
		deviceID:   deviceID,
		appVersion: appVersion,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
		queue: make(chan Event, 100),
	}
	globalClient.startWorker()
}

func (c *Client) startWorker() {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()

		var batch []Event
		for {
			select {
			case e, ok := <-c.queue:
				if !ok {
					return
				}
				batch = append(batch, e)
			case <-ticker.C:
				if len(batch) > 0 {
					c.flush(batch)
					batch = nil
				}
			}
		}
	}()
}

func (c *Client) flush(batch []Event) {
	if len(batch) == 0 {
		return
	}

	body, err := json.Marshal(batch)
	if err != nil {
		return
	}

	req, _ := http.NewRequest("POST", "https://api.amplitude.com/batch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	c.httpClient.Do(req)
}

func (c *Client) Close() {
	globalMu.Lock()
	defer globalMu.Unlock()

	if globalClient == nil || !globalClient.enabled {
		return
	}

	close(globalClient.queue)
	globalClient.closed = true
	globalClient.wg.Wait()
}

func Track(eventType string, properties map[string]interface{}) {
	globalMu.RLock()
	c := globalClient
	globalMu.RUnlock()

	if c == nil || !c.enabled {
		return
	}

	e := Event{
		EventType:  eventType,
		DeviceID:   c.deviceID,
		Time:       time.Now().UnixMilli(),
		AppVersion: c.appVersion,
		Properties: properties,
	}

	select {
	case c.queue <- e:
	default:
		fmt.Fprintf(os.Stderr, "[analytics] queue full, dropping event: %s\n", eventType)
	}
}

func SetUserID(userID string) {
	TrackUser(userID)
}

func Enabled() bool {
	globalMu.RLock()
	c := globalClient
	globalMu.RUnlock()
	return c != nil && c.enabled
}

func APIKey() string {
	globalMu.RLock()
	c := globalClient
	globalMu.RUnlock()
	if c == nil {
		return ""
	}
	return c.apiKey
}

func TrackUser(userID string) {
	globalMu.RLock()
	c := globalClient
	globalMu.RUnlock()

	if c == nil || !c.enabled {
		return
	}

	e := Event{
		EventType:  "$identify",
		DeviceID:   c.deviceID,
		Time:       time.Now().UnixMilli(),
		AppVersion: c.appVersion,
		Properties: map[string]interface{}{
			"$set": map[string]interface{}{
				"user_id": userID,
			},
		},
	}

	select {
	case c.queue <- e:
	default:
		fmt.Fprintf(os.Stderr, "[analytics] queue full, dropping event: %s\n", "$identify")
	}
}
