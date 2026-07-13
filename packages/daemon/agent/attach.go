package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/upload"
)

// AttachImage reads the file at path and posts it as a new message in the
// current task's thread (caption becomes the message body), reusing the
// exact presign+PUT+attach pipeline already built for supervisor
// screenshots (packages/daemon/upload). Called from hooks.handleAttach,
// which `tsq send-image --task <id> <path>` posts to.
func (a *Agent) AttachImage(cfg *config.Config, path, caption string) error {
	a.st.mu.Lock()
	sessionID := a.st.sessionID
	a.st.mu.Unlock()
	if sessionID == "" {
		return fmt.Errorf("no active session")
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read image file: %w", err)
	}

	mimeType := mimeTypeForExt(filepath.Ext(path))
	if mimeType == "" {
		return fmt.Errorf("unsupported image type: %s", filepath.Ext(path))
	}

	body := caption
	if body == "" {
		body = "📎 Attached image"
	}

	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}

	resp, err := api.Post(cfg, token, a.Config.ID, "/daemon/session/message", map[string]any{
		"session_id": sessionID,
		"type":       "output",
		"message":    body,
	})
	if err != nil {
		return fmt.Errorf("post message: %w", err)
	}
	msgID, _ := resp["message_id"].(string)
	if msgID == "" {
		return fmt.Errorf("no message_id in response")
	}

	uploader := upload.NewUploader(cfg, token, a.Config.ID, a.Config.Name)
	if err := uploader.Attach(upload.AttachOptions{
		SessionID: sessionID,
		MessageID: msgID,
		Filename:  filepath.Base(path),
		Content:   content,
		MimeType:  mimeType,
		AsImage:   true,
	}); err != nil {
		return fmt.Errorf("attach image: %w", err)
	}

	logger.Info(fmt.Sprintf("[%s] Sent image %s (message %s)", a.Config.Name, path, msgID))
	return nil
}

func mimeTypeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return ""
	}
}
