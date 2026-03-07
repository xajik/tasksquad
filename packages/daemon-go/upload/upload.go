package upload

import (
	"fmt"
	"os"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/logger"
)

func LogFile(presignedURL, localPath string) error {
	data, err := os.ReadFile(localPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to read log file: %w", err)
	}

	if len(data) == 0 {
		return nil
	}

	if err := api.PutBytes(presignedURL, data); err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}

	logger.Info(fmt.Sprintf("[upload] Uploaded %d bytes to R2", len(data)))
	return nil
}
