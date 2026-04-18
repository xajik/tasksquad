//go:build cgo && darwin

package ui

import (
	_ "embed"

	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/tasksquad/daemon/voicetomd"
	"github.com/tasksquad/daemon/whisperer"
)

// dashboardHTML is the single-page control panel served at the local HTTP server.
// Visual design mirrors the TaskSquad portal — same color tokens, card style,
// button variants, and typography. Source lives in dashboard.html alongside this file.
//
//go:embed dashboard.html
var dashboardHTML string

//go:embed voice_to_md.html
var voiceToMDHTML string

type dashStatus struct {
	Email     string        `json:"email"`
	DashURL   string        `json:"dash_url"`
	PortalURL string        `json:"portal_url"` // /dashboard if logged in, /auth otherwise
	ConfigDir string        `json:"config_dir"`
	Agents    []dashAgent   `json:"agents"`
	Sessions  []dashSession `json:"sessions"`
	UpdatedAt int64         `json:"updated_at"`
}

type dashAgent struct {
	Name          string   `json:"name"`
	Mode          string   `json:"mode"`
	TaskID        string   `json:"task_id"`
	LogPath       string   `json:"log_path"`
	Session       string   `json:"session"`
	PullAgo       string   `json:"pull_ago"`
	ID            string   `json:"id"`
	WorkDir       string   `json:"work_dir"`
	Command       string   `json:"command"`
	Provider      string   `json:"provider"`
	PendingSteps  []string `json:"pending_steps"`
	ExecutedSteps []string `json:"executed_steps"`
}

type dashSession struct {
	Name         string `json:"name"`
	AgentName    string `json:"agent_name"`
	TaskID       string `json:"task_id"`
	Orphan       bool   `json:"orphan"`
	IsSupervisor bool   `json:"is_supervisor"`
}

// StartDashboard starts a local HTTP control panel server and returns the URL.
// The server provides status, log reading, and session kill endpoints.
func StartDashboard(agents []AgentStatus, email, dashURL, configPath string) string {
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(dashboardHTML)) //nolint:errcheck
	})

	mux.HandleFunc("/voice-to-md", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(voiceToMDHTML)) //nolint:errcheck
	})

	// ── Voice-to-MD API ───────────────────────────────────────────────────────

	mux.HandleFunc("/api/voice-to-md/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mgr := GetVoiceManager()
		if mgr == nil {
			json.NewEncoder(w).Encode(map[string]any{"state": "idle"}) //nolint:errcheck
			return
		}
		json.NewEncoder(w).Encode(mgr.Status()) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/stream", func(w http.ResponseWriter, r *http.Request) {
		mgr := GetVoiceManager()
		if mgr == nil {
			http.Error(w, "voice-to-md not initialised", http.StatusServiceUnavailable)
			return
		}
		mgr.ServeSSE(w, r)
	})

	mux.HandleFunc("/api/voice-to-md/session/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Agent string `json:"agent"`
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Agent == "" {
			http.Error(w, "agent required", http.StatusBadRequest)
			return
		}
		if body.Model == "" {
			body.Model = "base"
		}
		mgr := GetVoiceManager()
		if mgr == nil {
			http.Error(w, "voice-to-md not initialised", http.StatusServiceUnavailable)
			return
		}
		if err := mgr.StartSession(body.Agent, body.Model); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/recording/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetVoiceManager()
		if mgr == nil {
			http.Error(w, "no active session", http.StatusBadRequest)
			return
		}
		if err := mgr.StartRecording(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/recording/pause", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetVoiceManager()
		if mgr != nil {
			mgr.PauseRecording() //nolint:errcheck
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/session/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetVoiceManager()
		if mgr != nil {
			mgr.StopSession()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetVoiceManager()
		if mgr == nil {
			http.Error(w, "no active session", http.StatusBadRequest)
			return
		}
		if err := mgr.HandleUploadRequest(r); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/content", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		content, fileName := GetVoiceContent()
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"content":  content,
			"fileName": fileName,
		})
	})

	mux.HandleFunc("/api/voice-to-md/transcript", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mgr := GetVoiceManager()
		transcript := ""
		if mgr != nil {
			transcript = mgr.Transcript()
		}
		json.NewEncoder(w).Encode(map[string]string{"transcript": transcript}) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(whisperModelStatus()) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/prereqs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(whisperer.CheckPrereqs()) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/models/download", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Model == "" {
			http.Error(w, "model required", http.StatusBadRequest)
			return
		}
		mgr := GetVoiceManager()
		if mgr == nil {
			http.Error(w, "manager not ready", http.StatusServiceUnavailable)
			return
		}
		// Stream download progress as SSE.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, _ := w.(http.Flusher)
		ch := startModelDownload(body.Model)
		for p := range ch {
			fmt.Fprintf(w, "data: %s\n\n", p)
			if flusher != nil {
				flusher.Flush()
			}
		}
	})

	mux.HandleFunc("/api/voice-to-md/agents", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var names []string
		for _, a := range agents {
			names = append(names, a.Name())
		}
		json.NewEncoder(w).Encode(names) //nolint:errcheck
	})

	mux.HandleFunc("/api/voice-to-md/sessions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		sessions, _ := voicetomd.ListSessions()
		json.NewEncoder(w).Encode(sessions) //nolint:errcheck
	})

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		// Build lookup maps for matching tmux sessions to agents.
		// Task sessions:       tsq-<sessionID>      — matched by agent's TmuxSession() value.
		// Supervisor sessions: tsq-sup-<taskID>     — matched by agent's task ID.
		type linked struct{ agent, task string }
		bySession := map[string]linked{} // full tmux session name → linked
		byTaskID := map[string]linked{}  // full task ID → linked
		for _, a := range agents {
			if sess := a.TmuxSession(); sess != "" {
				bySession[sess] = linked{a.Name(), a.GetTaskID()}
			}
			if tid := a.GetTaskID(); tid != "" {
				byTaskID[tid] = linked{a.Name(), tid}
			}
		}

		var agts []dashAgent
		for _, a := range agents {
			ago := "never"
			if t := a.LastPullTime(); !t.IsZero() {
				ago = relTime(t)
			}
			pending, executed := a.CloseSteps()
			agts = append(agts, dashAgent{
				Name:          a.Name(),
				Mode:          a.GetMode(),
				TaskID:        a.GetTaskID(),
				LogPath:       a.LastLogPath(),
				Session:       a.TmuxSession(),
				PullAgo:       ago,
				ID:            a.AgentID(),
				WorkDir:       a.WorkDir(),
				Command:       a.Command(),
				Provider:      a.Provider(),
				PendingSteps:  pending,
				ExecutedSteps: executed,
			})
		}

		var sessions []dashSession
		out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
		if err == nil {
			for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "tsq-") || line == "" {
					continue
				}
				// Supervisor sessions: tsq-sup-<taskID>
				if strings.HasPrefix(line, "tsq-sup-") {
					taskID := strings.TrimPrefix(line, "tsq-sup-")
					lnk, ok := byTaskID[taskID]
					sessions = append(sessions, dashSession{
						Name:         line,
						AgentName:    lnk.agent,
						TaskID:       lnk.task,
						IsSupervisor: true,
						Orphan:       !ok,
					})
					continue
				}
				// Regular agent sessions: tsq-<sessionID>
				lnk, ok := bySession[line]
				sessions = append(sessions, dashSession{
					Name:      line,
					AgentName: lnk.agent,
					TaskID:    lnk.task,
					Orphan:    !ok,
				})
			}
		}

		portalURL := dashURL + "/auth"
		if email != "" {
			portalURL = dashURL + "/dashboard"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dashStatus{ //nolint:errcheck
			Email:     email,
			DashURL:   dashURL,
			PortalURL: portalURL,
			ConfigDir: filepath.Dir(configPath),
			Agents:    agts,
			Sessions:  sessions,
			UpdatedAt: time.Now().UnixMilli(),
		})
	})

	mux.HandleFunc("/api/logs/daemon", func(w http.ResponseWriter, r *http.Request) {
		home, _ := os.UserHomeDir()
		today := time.Now().Format("2006-01-02")
		path := filepath.Join(home, ".tasksquad", "logs", "daemon-"+today+".log")
		content, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "daemon log not found: "+path, http.StatusNotFound)
			return
		}
		lines := strings.Split(string(content), "\n")
		if len(lines) > 500 {
			lines = lines[len(lines)-500:]
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(strings.Join(lines, "\n"))) //nolint:errcheck
	})

	mux.HandleFunc("/api/logs", func(w http.ResponseWriter, r *http.Request) {
		agentName := r.URL.Query().Get("agent")
		taskID := r.URL.Query().Get("task")
		if agentName == "" || taskID == "" {
			http.Error(w, "missing agent or task", http.StatusBadRequest)
			return
		}
		home, _ := os.UserHomeDir()
		safe := dashSanitize(agentName)
		logDir := filepath.Join(home, ".tasksquad", "logs", safe)
		path := filepath.Join(logDir, taskID+".log")

		content, err := os.ReadFile(path)
		if err != nil {
			// Log file missing — pull directly from the tmux session.
			sessionSuffix := taskID
			if len(sessionSuffix) > 8 {
				sessionSuffix = sessionSuffix[:8]
			}
			sessionName := "tsq-" + sessionSuffix
			tmuxOut, tmuxErr := exec.Command("tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-").Output()
			if tmuxErr != nil {
				http.Error(w, "log file not found and no active tmux session", http.StatusNotFound)
				return
			}
			// Persist to file so future reads come from disk.
			os.MkdirAll(logDir, 0755)                    //nolint:errcheck
			os.WriteFile(path, tmuxOut, 0644)             //nolint:errcheck
			content = tmuxOut
		}

		lines := strings.Split(string(content), "\n")
		if len(lines) > 300 {
			lines = lines[len(lines)-300:]
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(strings.Join(lines, "\n"))) //nolint:errcheck
	})

	mux.HandleFunc("/api/logs/supervisor", func(w http.ResponseWriter, r *http.Request) {
		taskID := r.URL.Query().Get("task")
		if taskID == "" {
			http.Error(w, "missing task", http.StatusBadRequest)
			return
		}
		home, _ := os.UserHomeDir()
		path := filepath.Join(home, ".tasksquad", "logs", "supervisor", taskID+".log")
		content, err := os.ReadFile(path)
		if err != nil {
			// Fall back to live tmux capture if log file not yet written.
			suffix := taskID
			if len(suffix) > 8 {
				suffix = suffix[:8]
			}
			sessionName := "tsq-sup-" + suffix
			tmuxOut, tmuxErr := exec.Command("tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-").Output()
			if tmuxErr != nil {
				http.Error(w, "supervisor log not found", http.StatusNotFound)
				return
			}
			content = tmuxOut
		}
		lines := strings.Split(string(content), "\n")
		if len(lines) > 500 {
			lines = lines[len(lines)-500:]
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(strings.Join(lines, "\n"))) //nolint:errcheck
	})

	mux.HandleFunc("/api/tasks/", func(w http.ResponseWriter, r *http.Request) {
		taskID := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
		taskID = dashSanitize(taskID)
		if taskID == "" {
			http.Error(w, "missing task id", http.StatusBadRequest)
			return
		}
		home, _ := os.UserHomeDir()
		path := filepath.Join(home, ".tasksquad", "tasks", taskID+".jsonl")
		content, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "task not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(content) //nolint:errcheck
	})

	mux.HandleFunc("/api/tasks", func(w http.ResponseWriter, r *http.Request) {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".tasksquad", "tasks")
		entries, err := os.ReadDir(dir)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("[]")) //nolint:errcheck
			return
		}

		type taskSummary struct {
			TaskID  string `json:"task_id"`
			Agent   string `json:"agent"`
			Subject string `json:"subject"`
			LogPath string `json:"log_path"`
			Ts      string `json:"ts"`
		}

		// Collect entries sorted newest-first (ReadDir returns alpha order; use ModTime).
		type fileInfo struct {
			name    string
			modTime int64
		}
		var files []fileInfo
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			files = append(files, fileInfo{name: e.Name(), modTime: info.ModTime().UnixMilli()})
		}
		// Sort newest-first.
		for i := 0; i < len(files); i++ {
			for j := i + 1; j < len(files); j++ {
				if files[j].modTime > files[i].modTime {
					files[i], files[j] = files[j], files[i]
				}
			}
		}
		if len(files) > 100 {
			files = files[:100]
		}

		var summaries []taskSummary
		for _, fi := range files {
			path := filepath.Join(dir, fi.name)
			f, err := os.Open(path)
			if err != nil {
				continue
			}
			var first string
			scanner := bufio.NewScanner(f)
			if scanner.Scan() {
				first = scanner.Text()
			}
			f.Close()
			if first == "" {
				continue
			}
			var ev struct {
				Type    string `json:"type"`
				TaskID  string `json:"task_id"`
				Agent   string `json:"agent"`
				Subject string `json:"subject"`
				LogPath string `json:"log_path"`
				Ts      string `json:"ts"`
			}
			if err := json.Unmarshal([]byte(first), &ev); err != nil || ev.Type != "task_start" {
				continue
			}
			summaries = append(summaries, taskSummary{
				TaskID:  ev.TaskID,
				Agent:   ev.Agent,
				Subject: ev.Subject,
				LogPath: ev.LogPath,
				Ts:      ev.Ts,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(summaries) //nolint:errcheck
	})

	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Path == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		exec.Command("open", body.Path).Start() //nolint:errcheck
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/api/session/kill", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Name == "" || !strings.HasPrefix(body.Name, "tsq-") {
			http.Error(w, "invalid session name", http.StatusBadRequest)
			return
		}
		if err := exec.Command("tmux", "kill-session", "-t", body.Name).Run(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0") // binds to loopback; URL uses localhost
	if err != nil {
		return ""
	}
	go func() { //nolint:errcheck
		srv := &http.Server{Handler: mux}
		srv.Serve(ln) //nolint:errcheck
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	return fmt.Sprintf("http://localhost:%d", port)
}

// whisperModelStatus returns download status for all known Whisper models.
func whisperModelStatus() []map[string]any {
	return whisperer.ModelStatus()
}

// startModelDownload starts downloading a model and returns a channel that emits
// JSON-encoded progress strings until the download completes.
func startModelDownload(modelName string) <-chan string {
	ch := make(chan string, 8)
	go func() {
		defer close(ch)
		size := whisperer.ModelSize(modelName)
		for p := range whisperer.DownloadModel(size) {
			var msg string
			if p.Err != nil {
				msg = fmt.Sprintf(`{"error":%q}`, p.Err.Error())
			} else if p.Done {
				msg = `{"done":true}`
			} else {
				pct := 0
				if p.BytesTotal > 0 {
					pct = int(p.BytesDone * 100 / p.BytesTotal)
				}
				msg = fmt.Sprintf(`{"bytes_done":%d,"bytes_total":%d,"pct":%d}`, p.BytesDone, p.BytesTotal, pct)
			}
			ch <- msg
		}
	}()
	return ch
}

// dashSanitize mirrors logger.sanitizeName: replaces non-alphanumeric chars with '-'.
func dashSanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	return b.String()
}
