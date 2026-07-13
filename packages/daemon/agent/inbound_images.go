package agent

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// materializeInboundImages downloads any image attachments on inbound
// messages and writes them to workDir/.tasksquad/inbox/, then appends a
// local-path reference to that message's body — the CLI tool already has
// full shell/file access to workDir, so a plain path reference is all it
// needs to open the image. Called once before the prompt is built for a
// fresh task, and again before a follow-up reply is sent via tmux.
//
// Download/write failures only log a warning and leave that message's body
// untouched; they must never block the task from starting or the reply from
// being delivered.
func materializeInboundImages(cfg *config.Config, agentID, workDir string, rawMsgs []interface{}) []interface{} {
	hasAny := false
	for _, raw := range rawMsgs {
		m, _ := raw.(map[string]interface{})
		if atts, ok := m["attachments"].([]interface{}); ok && len(atts) > 0 {
			hasAny = true
			break
		}
	}
	if !hasAny {
		return rawMsgs
	}

	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Warn(fmt.Sprintf("[inbound-images] auth failed, skipping attachment download: %v", err))
		return rawMsgs
	}

	inboxDir := filepath.Join(workDir, ".tasksquad", "inbox")
	if err := os.MkdirAll(inboxDir, 0755); err != nil {
		logger.Warn(fmt.Sprintf("[inbound-images] could not create inbox dir: %v", err))
		return rawMsgs
	}

	out := make([]interface{}, len(rawMsgs))
	for i, raw := range rawMsgs {
		out[i] = materializeOneMessage(cfg, token, agentID, inboxDir, raw)
	}
	return out
}

func materializeOneMessage(cfg *config.Config, token, agentID, inboxDir string, raw interface{}) interface{} {
	m, ok := raw.(map[string]interface{})
	if !ok {
		return raw
	}
	atts, ok := m["attachments"].([]interface{})
	if !ok || len(atts) == 0 {
		return raw
	}
	msgID, _ := m["id"].(string)
	if msgID == "" {
		return raw
	}

	var paths []string
	for _, rawAtt := range atts {
		att, _ := rawAtt.(map[string]interface{})
		attID, _ := att["id"].(string)
		filename, _ := att["filename"].(string)
		if attID == "" {
			continue
		}
		path, err := downloadAttachment(cfg, token, agentID, msgID, attID, filename, inboxDir)
		if err != nil {
			logger.Warn(fmt.Sprintf("[inbound-images] failed to download attachment %s on message %s: %v", attID, msgID, err))
			continue
		}
		paths = append(paths, path)
	}
	if len(paths) == 0 {
		return raw
	}

	body, _ := m["body"].(string)
	for _, p := range paths {
		body += fmt.Sprintf("\n\n[Attached image: %s]", p)
	}
	mCopy := make(map[string]interface{}, len(m))
	for k, v := range m {
		mCopy[k] = v
	}
	mCopy["body"] = body
	return mCopy
}

// materializeReplyAttachments handles the single-reply heartbeat shape
// (resp["reply"] + resp["reply_attachments"] + resp["reply_message_id"]),
// distinct from materializeInboundImages' multi-message task shape — a
// follow-up reply is delivered as a bare string via tmux.SendKeys, not
// through buildConversationPrompt, so it needs its own small entry point.
func materializeReplyAttachments(cfg *config.Config, agentID, workDir, reply string, resp map[string]any) string {
	atts, ok := resp["reply_attachments"].([]interface{})
	if !ok || len(atts) == 0 {
		return reply
	}
	msgID, _ := resp["reply_message_id"].(string)
	if msgID == "" {
		return reply
	}

	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Warn(fmt.Sprintf("[inbound-images] auth failed, skipping reply attachment download: %v", err))
		return reply
	}

	inboxDir := filepath.Join(workDir, ".tasksquad", "inbox")
	if err := os.MkdirAll(inboxDir, 0755); err != nil {
		logger.Warn(fmt.Sprintf("[inbound-images] could not create inbox dir: %v", err))
		return reply
	}

	for _, rawAtt := range atts {
		att, _ := rawAtt.(map[string]interface{})
		attID, _ := att["id"].(string)
		filename, _ := att["filename"].(string)
		if attID == "" {
			continue
		}
		path, err := downloadAttachment(cfg, token, agentID, msgID, attID, filename, inboxDir)
		if err != nil {
			logger.Warn(fmt.Sprintf("[inbound-images] failed to download reply attachment %s on message %s: %v", attID, msgID, err))
			continue
		}
		reply += fmt.Sprintf("\n\n[Attached image: %s]", path)
	}
	return reply
}

func downloadAttachment(cfg *config.Config, token, agentID, msgID, attID, filename, inboxDir string) (string, error) {
	path := fmt.Sprintf("/daemon/messages/%s/attachments/%s", msgID, attID)
	bytes, err := api.GetBytesWithAgent(cfg, token, agentID, path)
	if err != nil {
		return "", err
	}
	if filename == "" {
		filename = attID
	}
	localPath := filepath.Join(inboxDir, fmt.Sprintf("%s-%s", attID, filename))
	if err := os.WriteFile(localPath, bytes, 0644); err != nil {
		return "", err
	}
	return localPath, nil
}
