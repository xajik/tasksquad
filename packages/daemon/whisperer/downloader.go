package whisperer

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// DownloadProgress carries download status for a model.
type DownloadProgress struct {
	Size       ModelSize
	BytesDone  int64
	BytesTotal int64  // 0 if Content-Length is unknown
	Done       bool
	Err        error
}

// DownloadModel downloads the GGML model file from HuggingFace into
// ~/.tasksquad/models/tts/. Progress events are sent on the returned channel,
// which is closed when the download finishes (success or error).
func DownloadModel(size ModelSize) <-chan DownloadProgress {
	ch := make(chan DownloadProgress, 4)
	go func() {
		defer close(ch)
		if err := downloadModel(size, ch); err != nil {
			ch <- DownloadProgress{Size: size, Err: err}
		}
	}()
	return ch
}

func downloadModel(size ModelSize, progress chan<- DownloadProgress) error {
	if err := EnsureModelsDir(); err != nil {
		return fmt.Errorf("models dir: %w", err)
	}

	dir := modelsDir()
	destPath := filepath.Join(dir, fmt.Sprintf("ggml-%s.bin", size))
	tmpPath := destPath + ".tmp"

	url := HuggingFaceURL(size)
	resp, err := http.Get(url) //nolint:noctx
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s returned %d", url, resp.StatusCode)
	}

	total := resp.ContentLength // may be -1

	f, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}

	buf := make([]byte, 32*1024)
	var done int64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := f.Write(buf[:n]); writeErr != nil {
				f.Close()
				os.Remove(tmpPath)
				return fmt.Errorf("write: %w", writeErr)
			}
			done += int64(n)
			var t int64
			if total > 0 {
				t = total
			}
			select {
			case progress <- DownloadProgress{Size: size, BytesDone: done, BytesTotal: t}:
			default:
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			f.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("read: %w", readErr)
		}
	}
	f.Close()

	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	progress <- DownloadProgress{Size: size, BytesDone: done, BytesTotal: done, Done: true}
	return nil
}

// IsDownloading returns whether a model is currently being downloaded.
// Checks for the presence of a .tmp file.
func IsDownloading(size ModelSize) bool {
	dir := modelsDir()
	tmpPath := filepath.Join(dir, fmt.Sprintf("ggml-%s.bin.tmp", size))
	_, err := os.Stat(tmpPath)
	return err == nil
}
