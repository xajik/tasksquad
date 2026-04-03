package agent

import (
	"fmt"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/upload"
)

// withUploader creates an uploader for the agent and calls fn with it.
// Shared error-handling for all uploadAndAttach* methods.
func (a *Agent) withUploader(cfg *config.Config, fn func(*upload.Uploader) error) {
	uploader, err := upload.CreateAgentUploader(a, cfg)
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to create uploader: %v", a.Config.Name, err))
		return
	}
	if err := fn(uploader); err != nil {
		logger.Warn(fmt.Sprintf("[%s] Upload failed: %v", a.Config.Name, err))
	}
}

// uploadAndAttach gets a presigned R2 PUT URL, uploads the local file, then
// attaches the stored key to the message record.
func (a *Agent) uploadAndAttach(cfg *config.Config, sessionID, messageID, filename, filePath string) {
	if messageID == "" || filePath == "" {
		return
	}
	a.withUploader(cfg, func(u *upload.Uploader) error {
		return u.Attach(upload.AttachOptions{
			SessionID: sessionID,
			MessageID: messageID,
			Filename:  filename,
			FilePath:  filePath,
		})
	})
}

// uploadAndAttachContent uploads raw bytes to R2 and attaches the key to a message.
// Unlike uploadAndAttach (which reads from a file), this takes the content directly.
func (a *Agent) uploadAndAttachContent(cfg *config.Config, sessionID, messageID, filename string, content []byte) {
	if messageID == "" || len(content) == 0 {
		return
	}
	a.withUploader(cfg, func(u *upload.Uploader) error {
		return u.Attach(upload.AttachOptions{
			SessionID: sessionID,
			MessageID: messageID,
			Filename:  filename,
			Content:   content,
		})
	})
}

func (a *Agent) uploadAndAttachLog(cfg *config.Config, sessionID, logContent string) {
	if sessionID == "" || logContent == "" {
		return
	}
	a.withUploader(cfg, func(u *upload.Uploader) error {
		return u.AttachLog(sessionID, logContent)
	})
}
