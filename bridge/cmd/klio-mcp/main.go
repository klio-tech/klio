// Command klio-mcp is the stdio MCP shim spawned by Claude Code, Cursor,
// and other MCP-capable agents. Forwards line-delimited JSON-RPC traffic
// from stdin to the local klio daemon over a unix socket, returning the
// daemon's response on stdout.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

func main() {
	socketPath := defaultSocket()
	if v := os.Getenv("KLIO_SOCKET_PATH"); v != "" {
		socketPath = v
	}
	if err := forward(socketPath, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "klio-mcp:", err)
		os.Exit(1)
	}
}

func defaultSocket() string {
	if runtime.GOOS == "windows" {
		return "127.0.0.1:7878"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".klio", "bridge.sock")
}

func dial(path string) (net.Conn, error) {
	if runtime.GOOS == "windows" {
		return net.Dial("tcp", path)
	}
	return net.Dial("unix", path)
}

func forward(socketPath string, in io.Reader, out io.Writer) error {
	conn, err := dial(socketPath)
	if err != nil {
		return fmt.Errorf("daemon not reachable: %w", err)
	}
	defer func() { _ = conn.Close() }()

	var wg sync.WaitGroup
	wg.Add(1)

	// Stdin -> socket
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
		for scanner.Scan() {
			line := scanner.Bytes()
			payload := append([]byte{}, line...)
			payload = append(payload, '\n')
			if _, werr := conn.Write(payload); werr != nil {
				return
			}
		}
		// stdin closed: half-close write to signal the daemon
		if uc, ok := conn.(*net.UnixConn); ok {
			_ = uc.CloseWrite()
		}
	}()

	// Socket -> stdout
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			if _, werr := out.Write(line); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			wg.Wait()
			return nil
		}
		if err != nil {
			return err
		}
	}
}
