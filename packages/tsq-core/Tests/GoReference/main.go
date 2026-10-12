// Test-only oracle. Built from the existing daemon's module; never shipped in the app.
package main

import (
    "crypto/aes"
    "crypto/cipher"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "syscall"
    "time"

    "github.com/tasksquad/daemon/agent"
    "github.com/tasksquad/daemon/api"
    "github.com/tasksquad/daemon/config"
    "github.com/tasksquad/daemon/hooks"
    "github.com/tasksquad/daemon/provider"
    "github.com/tasksquad/daemon/supervisor"
    "github.com/zalando/go-keyring"
)

func main() {
    if err := run(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}

func run() error {
    switch os.Args[1] {
    case "config":
        cfg, err := config.Load(os.Args[2])
        if err != nil { return err }
        return json.NewEncoder(os.Stdout).Encode(cfg)
    case "encrypt":
        plaintext, err := base64.StdEncoding.DecodeString(os.Args[3])
        if err != nil { return err }
        bytes, err := api.EncryptGCM(os.Args[2], plaintext)
        if err != nil { return err }
        fmt.Println(base64.StdEncoding.EncodeToString(bytes))
    case "decrypt":
        key, err := base64.StdEncoding.DecodeString(os.Args[2])
        if err != nil { return err }
        data, err := base64.StdEncoding.DecodeString(os.Args[3])
        if err != nil { return err }
        block, err := aes.NewCipher(key)
        if err != nil { return err }
        gcm, err := cipher.NewGCM(block)
        if err != nil { return err }
        if len(data) < gcm.NonceSize() { return fmt.Errorf("short ciphertext") }
        plaintext, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
        if err != nil { return err }
        os.Stdout.Write(plaintext)
    case "lock":
        f, err := lockDaemon(os.Args[2])
        if err != nil { return err }
        defer f.Close()
        fmt.Println("locked")
        io.Copy(io.Discard, os.Stdin)
    case "daemon":
        // daemon <config>: Go's task path from runDaemon (hook server + batch poller)
        // under $HOME, with an in-memory keyring holding a CLI token and Go's
        // daemon.lock held for the process lifetime. Prints "running", then serves
        // until killed (Go installs no SIGTERM handler).
        keyring.MockInit()
        keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_go_oracle")
        keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339))
        lock, err := lockDaemon(config.DefaultDir())
        if err != nil { return fmt.Errorf("daemon.lock held: %w", err) }
        defer lock.Close() // keeps the lock reachable; os.File's finalizer would release it
        cfg, err := config.Load(os.Args[2])
        if err != nil { return err }
        raw := make([]*agent.Agent, 0, len(cfg.Agents))
        list := make([]hooks.Agent, 0, len(cfg.Agents))
        for _, ac := range cfg.Agents {
            a := agent.New(ac)
            raw = append(raw, a)
            list = append(list, a)
        }
        ctrl := agent.NewBatchController()
        hooks.StartHookServer(cfg, list, supervisor.New(cfg), ctrl)
        go agent.RunBatch(cfg, raw, ctrl)
        fmt.Println("running")
        select {}
    case "keychain-read":
        value, err := keyring.Get(os.Args[2], os.Args[3])
        if err != nil { return err }
        fmt.Fprint(os.Stdout, value)
    case "keychain-write":
        value, err := base64.StdEncoding.DecodeString(os.Args[4])
        if err != nil { return err }
        return keyring.Set(os.Args[2], os.Args[3], string(value))
    case "provider":
        // provider <command> <override> <workDir> <hooksPort> <agentID> <taskID> <prompt>
        // Setup writes into workDir; SetupArgs writes into $TMPDIR.
        var port int
        fmt.Sscanf(os.Args[5], "%d", &port)
        p := provider.Detect(os.Args[2], os.Args[3])
        if err := p.Setup(os.Args[4], port, os.Args[6], os.Args[7]); err != nil { return err }
        prompt := provider.FormatPrompt(p, os.Args[8])
        out := map[string]any{
            "name": p.Name(), "cli_name": p.CLIName(), "uses_hooks": p.UsesHooks(),
            "setup_args": p.SetupArgs(port, os.Args[6], os.Args[7]), "env": p.Env(port),
            "extra_args": p.ExtraArgs(), "formatted_prompt": prompt, "stdin": p.Stdin(prompt),
        }
        if initial, ok := p.(interface{ InitialPromptArgs(string) []string }); ok {
            out["initial_prompt_args"] = initial.InitialPromptArgs(prompt)
        }
        return json.NewEncoder(os.Stdout).Encode(out)
    default:
        return fmt.Errorf("unknown oracle command")
    }
    return nil
}

// lockDaemon takes daemon.lock under root exclusively, as app_darwin.go does.
func lockDaemon(root string) (*os.File, error) {
    if err := os.MkdirAll(root, 0700); err != nil { return nil, err }
    f, err := os.OpenFile(filepath.Join(root, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
    if err != nil { return nil, err }
    if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil { f.Close(); return nil, err }
    return f, nil
}
