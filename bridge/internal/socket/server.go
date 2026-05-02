// Package socket implements the unix-domain-socket server that MCP shims
// connect to. Each connection is line-delimited JSON-RPC.
package socket

import (
	"bufio"
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
)

// Handler processes one line of input (a JSON-RPC request) and returns one
// line of output (a JSON-RPC response). Returning nil indicates a notification
// with no response (per JSON-RPC 2.0).
type Handler func(line []byte) []byte

// Server listens on a unix domain socket and dispatches each connection's
// line-delimited input to Handler.
type Server struct {
	path    string
	handler Handler
	wg      sync.WaitGroup
}

// New returns a Server bound to path with handler.
func New(path string, h Handler) *Server {
	return &Server{path: path, handler: h}
}

// Run starts the server and blocks until ctx is canceled.
func (s *Server) Run(ctx context.Context) error {
	if err := os.RemoveAll(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	l, err := net.Listen("unix", s.path)
	if err != nil {
		return err
	}
	defer func() { _ = l.Close() }()
	defer func() { _ = os.RemoveAll(s.path) }()

	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()

	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				s.wg.Wait()
				return nil
			}
			slog.Warn("accept failed", "err", err)
			continue
		}
		s.wg.Add(1)
		go func(c net.Conn) {
			defer s.wg.Done()
			s.handle(c)
		}(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			// Trim trailing newline before passing to handler.
			payload := line
			if payload[len(payload)-1] == '\n' {
				payload = payload[:len(payload)-1]
			}
			resp := s.handler(payload)
			if resp != nil {
				resp = append(resp, '\n')
				if _, werr := conn.Write(resp); werr != nil {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}
