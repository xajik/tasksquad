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

    "github.com/tasksquad/daemon/api"
    "github.com/tasksquad/daemon/config"
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
        root := os.Args[2]
        if err := os.MkdirAll(root, 0700); err != nil { return err }
        f, err := os.OpenFile(filepath.Join(root, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
        if err != nil { return err }
        defer f.Close()
        if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil { return err }
        fmt.Println("locked")
        io.Copy(io.Discard, os.Stdin)
    case "keychain-read":
        value, err := keyring.Get(os.Args[2], os.Args[3])
        if err != nil { return err }
        fmt.Fprint(os.Stdout, value)
    case "keychain-write":
        value, err := base64.StdEncoding.DecodeString(os.Args[4])
        if err != nil { return err }
        return keyring.Set(os.Args[2], os.Args[3], string(value))
    default:
        return fmt.Errorf("unknown oracle command")
    }
    return nil
}
