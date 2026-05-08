//go:build cgo && darwin

package ui

import (
	_ "embed"

	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/speechtomd"
	"github.com/tasksquad/daemon/whisperer"
)

// dashboardHTML is the single-page control panel served at the local HTTP server.
// Visual design mirrors the TaskSquad portal — same color tokens, card style,
// button variants, and typography. Source lives in dashboard.html alongside this file.
//
//go:embed portal.html
var embeddedPortalHTML string

var (
	cachedPortalHTML  string
	cachedPortalMtime int64
)

func getPortalHTML() string {
	cwd, _ := os.Getwd()
	searchPaths := []string{
		filepath.Join(cwd, "ui", "portal.html"),
		filepath.Join(filepath.Dir(os.Args[0]), "ui", "portal.html"),
		filepath.Join(filepath.Dir(os.Args[0]), "packages", "daemon", "ui", "portal.html"),
		filepath.Join(os.Getenv("HOME"), "Projects", "tasksquad-doc", "packages", "daemon", "ui", "portal.html"),
	}

	for _, path := range searchPaths {
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		currentMtime := info.ModTime().Unix()
		if cachedPortalHTML == "" || currentMtime > cachedPortalMtime {
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			cachedPortalHTML = string(data)
			cachedPortalMtime = currentMtime
			log.Printf("[ui] loaded portal.html from: %s", path)
		}
		return cachedPortalHTML
	}

	return embeddedPortalHTML
}

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
func StartDashboard(agents []AgentStatus, email, dashURL, configPath string, authCtrl AuthController, skillsSyncer SkillsSyncer, conveyorSyncer ConveyorSyncer, port int) string {
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(getPortalHTML())) //nolint:errcheck
	})

	mux.HandleFunc("/speech-to-md", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusFound)
	})

	// ── Speech-to-MD API ──────────────────────────────────────────────────────

	mux.HandleFunc("/api/speech-to-md/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mgr := GetSpeechManager()
		if mgr == nil {
			json.NewEncoder(w).Encode(map[string]any{"state": "idle"}) //nolint:errcheck
			return
		}
		json.NewEncoder(w).Encode(mgr.Status()) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/stream", func(w http.ResponseWriter, r *http.Request) {
		mgr := GetSpeechManager()
		if mgr == nil {
			http.Error(w, "speech-to-md not initialised", http.StatusServiceUnavailable)
			return
		}
		mgr.ServeSSE(w, r)
	})

	mux.HandleFunc("/api/speech-to-md/session/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Agent      string `json:"agent"`
			Model      string `json:"model"`
			Prompt     string `json:"prompt"`
			LocalModel string `json:"local_model"` // omlx model name when agent=="local"
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Agent == "" {
			http.Error(w, "agent required", http.StatusBadRequest)
			return
		}
		if body.Model == "" {
			body.Model = "base"
		}
		mgr := GetSpeechManager()
		if mgr == nil {
			http.Error(w, "speech-to-md not initialised", http.StatusServiceUnavailable)
			return
		}
		var startErr error
		if body.Agent == "local" {
			startErr = mgr.StartLocalSession(body.LocalModel, body.Model, body.Prompt)
		} else {
			startErr = mgr.StartSession(body.Agent, body.Model, body.Prompt)
		}
		if startErr != nil {
			http.Error(w, startErr.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/recording/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			EditMode bool `json:"edit_mode"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		mgr := GetSpeechManager()
		if mgr == nil {
			http.Error(w, "no active session", http.StatusBadRequest)
			return
		}
		if err := mgr.StartRecording(body.EditMode); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/edit-mode", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Enabled bool `json:"enabled"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		mgr := GetSpeechManager()
		if mgr == nil {
			http.Error(w, "speech-to-md not initialised", http.StatusBadRequest)
			return
		}
		mgr.SetEditMode(body.Enabled)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/recording/pause", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetSpeechManager()
		if mgr == nil {
			http.Error(w, "no active session", http.StatusBadRequest)
			return
		}
		if err := mgr.PauseRecording(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/session/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetSpeechManager()
		if mgr != nil {
			mgr.StopSession()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mgr := GetSpeechManager()
		if mgr == nil {
			http.Error(w, "no active session - start a session first", http.StatusBadRequest)
			return
		}
		if err := mgr.HandleUploadRequest(r); err != nil {
			httpStatus := http.StatusInternalServerError
			if strings.Contains(err.Error(), "not recording") || strings.Contains(err.Error(), "model not found") {
				httpStatus = http.StatusBadRequest
			}
			http.Error(w, err.Error(), httpStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/content", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		content, fileName := GetSpeechContent()
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"content":  content,
			"fileName": fileName,
		})
	})

	mux.HandleFunc("/api/speech-to-md/transcript", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mgr := GetSpeechManager()
		transcript := ""
		if mgr != nil {
			transcript = mgr.Transcript()
		}
		json.NewEncoder(w).Encode(map[string]string{"transcript": transcript}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(whisperModelStatus()) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/models/open-folder", func(w http.ResponseWriter, r *http.Request) {
		dir := whisperer.ModelsDir()
		if err := os.MkdirAll(dir, 0755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		exec.Command("open", dir).Start() //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/prereqs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(whisperer.CheckPrereqs()) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/models/download", func(w http.ResponseWriter, r *http.Request) {
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

	mux.HandleFunc("/api/speech-to-md/agents", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var names []string
		for _, a := range agents {
			names = append(names, a.Name())
		}
		json.NewEncoder(w).Encode(names) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/local-models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		models, err := speechtomd.ListLocalModels("")
		if err != nil {
			json.NewEncoder(w).Encode(map[string]any{"models": []string{}, "error": err.Error()}) //nolint:errcheck
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"models": models}) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/sessions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		sessions, _ := speechtomd.ListSessions()
		json.NewEncoder(w).Encode(sessions) //nolint:errcheck
	})

	mux.HandleFunc("/api/speech-to-md/prompts", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			prompts, err := speechtomd.ListPrompts()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if prompts == nil {
				prompts = []speechtomd.PromptEntry{}
			}
			json.NewEncoder(w).Encode(prompts) //nolint:errcheck
		case http.MethodPost:
			var body speechtomd.PromptEntry
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
				http.Error(w, "name and content required", http.StatusBadRequest)
				return
			}
			if err := speechtomd.SavePrompt(body.Name, body.Content); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/speech-to-md/session/content", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		kind := r.URL.Query().Get("kind") // "md" or "txt"
		if id == "" || (kind != "md" && kind != "txt") {
			http.Error(w, "missing id or kind", http.StatusBadRequest)
			return
		}
		home, _ := os.UserHomeDir()
		path := filepath.Join(home, ".tasksquad", "speech-to-markdown", id, id+"."+kind)
		data, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(data) //nolint:errcheck
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
				if supTaskID, isSup := strings.CutPrefix(line, "tsq-sup-"); isSup {
					lnk, ok := byTaskID[supTaskID]
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

	mux.HandleFunc("/api/tasks-log/", func(w http.ResponseWriter, r *http.Request) {
		taskID := strings.TrimPrefix(r.URL.Path, "/api/tasks-log/")
		taskID = dashSanitize(taskID)
		if taskID == "" {
			http.Error(w, "missing task id", http.StatusBadRequest)
			return
		}
		raw := r.URL.Query().Get("raw") == "true"
		home, _ := os.UserHomeDir()
		path := filepath.Join(home, ".tasksquad", "tasks", taskID+".jsonl")
		content, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "task not found", http.StatusNotFound)
			return
		}
		if raw {
			w.Header().Set("Content-Type", "application/json")
			w.Write(content) //nolint:errcheck
			return
		}
		lines := strings.Split(strings.TrimSpace(string(content)), "\n")
		var events []map[string]any
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var ev map[string]any
			if err := json.Unmarshal([]byte(line), &ev); err == nil {
				events = append(events, ev)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(events) //nolint:errcheck
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

	mux.HandleFunc("/api/file", func(w http.ResponseWriter, r *http.Request) {
		rawPath := r.URL.Query().Get("path")
		if rawPath == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		if rest, ok := strings.CutPrefix(rawPath, "~/"); ok {
			home, _ := os.UserHomeDir()
			rawPath = filepath.Join(home, rest)
		}
		clean := filepath.Clean(rawPath)
		ext := strings.ToLower(filepath.Ext(clean))
		allowed := map[string]bool{".md": true, ".log": true, ".jsonl": true, ".txt": true}
		if !allowed[ext] {
			http.Error(w, "file type not allowed", http.StatusForbidden)
			return
		}
		content, err := os.ReadFile(clean)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		const maxBytes = 512 * 1024
		if len(content) > maxBytes {
			content = append(content[:maxBytes], []byte("\n[… truncated …]")...)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(content) //nolint:errcheck
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

	mux.HandleFunc("/api/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if skillsSyncer != nil {
			skillsSyncer.ForceSync()
		}
		if conveyorSyncer != nil {
			conveyorSyncer.ForcePoll()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	})

	mux.HandleFunc("/api/tools", func(w http.ResponseWriter, r *http.Request) {
		type toolsEntry struct {
			WorkDir   string   `json:"work_dir"`
			Agents    []string `json:"agents"`
			Skills    []string `json:"skills"`
			Commands  []string `json:"commands"`
			SubAgents []string `json:"sub_agents"`
		}

		seen := map[string]*toolsEntry{}
		var order []string
		for _, a := range agents {
			wd := a.WorkDir()
			if wd == "" {
				continue
			}
			if _, ok := seen[wd]; !ok {
				seen[wd] = &toolsEntry{WorkDir: wd, Agents: []string{}, Skills: []string{}, Commands: []string{}, SubAgents: []string{}}
				order = append(order, wd)
			}
			seen[wd].Agents = append(seen[wd].Agents, a.Name())
		}

		for _, wd := range order {
			entry := seen[wd]

			// Skills: scan .tsq/skills/ for subdirs containing SKILL.md
			skillsBase := filepath.Join(wd, ".tsq", "skills")
			if des, err := os.ReadDir(skillsBase); err == nil {
				for _, de := range des {
					if de.IsDir() {
						if _, err2 := os.Stat(filepath.Join(skillsBase, de.Name(), "SKILL.md")); err2 == nil {
							entry.Skills = append(entry.Skills, de.Name())
						}
					}
				}
			}

			// Commands: scan .tsq/commands/ for *.md files
			cmdsBase := filepath.Join(wd, ".tsq", "commands")
			if des, err := os.ReadDir(cmdsBase); err == nil {
				for _, de := range des {
					if !de.IsDir() && strings.HasSuffix(de.Name(), ".md") {
						entry.Commands = append(entry.Commands, strings.TrimSuffix(de.Name(), ".md"))
					}
				}
			}

			// Sub-agents: scan .claude/agents/ for *.md files
			agentsBase := filepath.Join(wd, ".claude", "agents")
			if des, err := os.ReadDir(agentsBase); err == nil {
				for _, de := range des {
					if !de.IsDir() && strings.HasSuffix(de.Name(), ".md") {
						entry.SubAgents = append(entry.SubAgents, strings.TrimSuffix(de.Name(), ".md"))
					}
				}
			}
		}

		result := make([]*toolsEntry, 0, len(order))
		for _, wd := range order {
			result = append(result, seen[wd])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	})

	mux.HandleFunc("/api/logout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := authCtrl.Logout(); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]any{"error": err.Error()}) //nolint:errcheck
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	})

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		// port already in use — fall back to a random port
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return ""
		}
	}
	go func() { //nolint:errcheck
		srv := &http.Server{Handler: mux}
		srv.Serve(ln) //nolint:errcheck
	}()
	boundPort := ln.Addr().(*net.TCPAddr).Port
	return fmt.Sprintf("http://localhost:%d", boundPort)
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
		logger.Info(fmt.Sprintf("[download] Starting download of model %q", size))
		for p := range whisperer.DownloadModel(size) {
			var msg string
			if p.Err != nil {
				logger.Warn(fmt.Sprintf("[download] Model %q download failed: %v", size, p.Err))
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
