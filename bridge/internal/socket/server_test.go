package socket

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestEchoServer(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv := New(socketPath, func(line []byte) []byte {
		var msg map[string]any
		_ = json.Unmarshal(line, &msg)
		msg["echoed"] = true
		out, _ := json.Marshal(msg)
		return out
	})
	go func() { _ = srv.Run(ctx) }()
	time.Sleep(150 * time.Millisecond)

	conn, err := net.DialTimeout("unix", socketPath, 1*time.Second)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(`{"hello":"world"}` + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		t.Fatalf("ReadString: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["echoed"] != true {
		t.Fatalf("expected echoed=true, got %v", resp)
	}
}

func TestNotificationGetsNoResponse(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv := New(socketPath, func(line []byte) []byte {
		// Return nil to indicate "no response".
		return nil
	})
	go func() { _ = srv.Run(ctx) }()
	time.Sleep(150 * time.Millisecond)

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(`{"jsonrpc":"2.0","method":"notif"}` + "\n"))

	conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	buf := make([]byte, 64)
	n, err := conn.Read(buf)
	// Either timeout or EOF — not data.
	if err == nil && n > 0 {
		t.Fatalf("expected no response, got %s", buf[:n])
	}
}
