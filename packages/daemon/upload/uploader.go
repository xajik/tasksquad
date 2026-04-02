package upload

import (
	"fmt"
	"os"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

type Uploader struct {
	cfg       *config.Config
	token     string
	agentID   string
	agentName string
}

func NewUploader(cfg *config.Config, token, agentID, agentName string) *Uploader {
	return &Uploader{
		cfg:       cfg,
		token:     token,
		agentID:   agentID,
		agentName: agentName,
	}
}

func (u *Uploader) post(path string, body any) (map[string]any, error) {
	return api.Post(u.cfg, u.token, u.agentID, path, body)
}

type PresignResult struct {
	UploadURL string
	Key       string
	DEK       string
}

func (u *Uploader) presign(sessionID, filename string) (*PresignResult, error) {
	resp, err := u.post("/daemon/r2/presign", map[string]any{
		"session_id": sessionID,
		"filename":   filename,
	})
	if err != nil {
		return nil, fmt.Errorf("presign request: %w", err)
	}

	uploadURL, _ := resp["upload_url"].(string)
	key, _ := resp["key"].(string)
	dek, _ := resp["dek"].(string)

	if uploadURL == "" || key == "" {
		return nil, fmt.Errorf("presign response missing url or key")
	}

	return &PresignResult{
		UploadURL: uploadURL,
		Key:       key,
		DEK:       dek,
	}, nil
}

func (u *Uploader) upload(data []byte, result *PresignResult, filename string) error {
	if result.DEK != "" {
		var err error
		data, err = api.EncryptGCM(result.DEK, data)
		if err != nil {
			return fmt.Errorf("encryption: %w", err)
		}
	}

	if err := api.PutBytes(result.UploadURL, data); err != nil {
		return fmt.Errorf("upload: %w", err)
	}

	logger.Info(fmt.Sprintf("[%s] Uploaded %d bytes to R2: %s", u.agentName, len(data), filename))
	return nil
}

func (u *Uploader) AttachToMessage(messageID, key string) error {
	_, err := u.post("/daemon/messages/"+messageID+"/attach", map[string]any{
		"transcript_key": key,
	})
	if err != nil {
		return fmt.Errorf("attach to message: %w", err)
	}
	logger.Debug(fmt.Sprintf("[%s] Attached R2 key %s to message %s", u.agentName, key, messageID))
	return nil
}

func (u *Uploader) AttachToSession(sessionID, key string) error {
	_, err := u.post("/daemon/sessions/"+sessionID+"/attach", map[string]any{
		"r2_log_key": key,
	})
	if err != nil {
		return fmt.Errorf("attach to session: %w", err)
	}
	logger.Debug(fmt.Sprintf("[%s] Attached R2 log key %s to session %s", u.agentName, key, sessionID))
	return nil
}

type AttachOptions struct {
	SessionID string
	MessageID string
	Filename  string
	FilePath  string
	Content   []byte
}

func (u *Uploader) Attach(opts AttachOptions) error {
	if opts.SessionID == "" {
		return fmt.Errorf("session_id required")
	}

	if opts.FilePath == "" && len(opts.Content) == 0 {
		return fmt.Errorf("either file_path or content required")
	}

	filename := opts.Filename
	if filename == "" {
		filename = "file"
	}

	presign, err := u.presign(opts.SessionID, filename)
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to get presigned URL for %s: %v", u.agentName, filename, err))
		return err
	}

	var data []byte
	if opts.FilePath != "" {
		data, err = os.ReadFile(opts.FilePath)
		if err != nil {
			logger.Warn(fmt.Sprintf("[%s] Could not read file for upload %s: %v", u.agentName, opts.FilePath, err))
			return err
		}
	} else {
		data = opts.Content
	}

	if err := u.upload(data, presign, filename); err != nil {
		logger.Warn(fmt.Sprintf("[%s] R2 upload failed for %s: %v", u.agentName, filename, err))
		return err
	}

	if opts.MessageID != "" {
		return u.AttachToMessage(opts.MessageID, presign.Key)
	}

	return nil
}

func (u *Uploader) AttachLog(sessionID, content string) error {
	if sessionID == "" || content == "" {
		return fmt.Errorf("session_id and content required")
	}

	presign, err := u.presign(sessionID, "full.log")
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to get presigned URL for log: %v", u.agentName, err))
		return err
	}

	data := []byte(content)
	if err := u.upload(data, presign, "full.log"); err != nil {
		logger.Warn(fmt.Sprintf("[%s] R2 log upload failed: %v", u.agentName, err))
		return err
	}

	return u.AttachToSession(sessionID, presign.Key)
}

func CreateAgentUploader(a AgentUploader, cfg *config.Config) (*Uploader, error) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	return NewUploader(cfg, token, a.AgentID(), a.Name()), nil
}

type AgentUploader interface {
	AgentID() string
	Name() string
}
