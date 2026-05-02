package backfill

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/google/uuid"
)

// Client is the small HTTP surface we need to do backfill: ensure a space
// exists for each project, and ingest a transcript into a space.
type Client interface {
	EnsureSpace(ctx context.Context, slug, name string) (uuid.UUID, error)
	IngestTranscript(
		ctx context.Context,
		spaceID uuid.UUID,
		sessionID string,
		messages []map[string]any,
	) (map[string]any, error)
}

// Options configures Run.
type Options struct {
	Root           string
	Client         Client
	Checkpoint     *Checkpoint
	MaxConcurrency int
}

// Report describes what Run did.
type Report struct {
	ProcessedSessions int
	SkippedSessions   int
	FailedSessions    int
	Errors            []string
}

// Run processes every uncheckpointed session JSONL under opts.Root.
func Run(ctx context.Context, opts Options) (Report, error) {
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = 4
	}
	if opts.Checkpoint == nil {
		opts.Checkpoint = NewCheckpoint("")
	}

	projects, err := Walk(opts.Root)
	if err != nil {
		return Report{}, fmt.Errorf("walk: %w", err)
	}

	var report Report
	var reportMu sync.Mutex
	sem := make(chan struct{}, opts.MaxConcurrency)
	var wg sync.WaitGroup

	for _, proj := range projects {
		spaceID, err := opts.Client.EnsureSpace(ctx, proj.Slug, proj.DisplayName)
		if err != nil {
			reportMu.Lock()
			report.Errors = append(report.Errors, fmt.Sprintf("%s: ensure space: %s", proj.Slug, err))
			report.FailedSessions += len(proj.Sessions)
			reportMu.Unlock()
			continue
		}
		for _, s := range proj.Sessions {
			s := s
			if opts.Checkpoint.IsDone(s.SessionID) {
				reportMu.Lock()
				report.SkippedSessions++
				reportMu.Unlock()
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				if ctx.Err() != nil {
					return
				}
				messages, err := parseTranscript(s.Path)
				if err != nil {
					reportMu.Lock()
					report.Errors = append(report.Errors, fmt.Sprintf("parse %s: %s", s.Path, err))
					report.FailedSessions++
					reportMu.Unlock()
					return
				}
				if len(messages) == 0 {
					reportMu.Lock()
					report.SkippedSessions++
					reportMu.Unlock()
					return
				}
				if _, err := opts.Client.IngestTranscript(ctx, spaceID, s.SessionID, messages); err != nil {
					reportMu.Lock()
					report.Errors = append(report.Errors, fmt.Sprintf("ingest %s: %s", s.SessionID, err))
					report.FailedSessions++
					reportMu.Unlock()
					return
				}
				_ = opts.Checkpoint.MarkDone(s.SessionID)
				reportMu.Lock()
				report.ProcessedSessions++
				reportMu.Unlock()
			}()
		}
	}

	wg.Wait()
	if report.FailedSessions > 0 {
		return report, errors.New("backfill completed with errors")
	}
	return report, nil
}

// parseTranscript reads a Claude Code JSONL session into the
// {role, content} message shape the engine's ingest endpoint expects.
func parseTranscript(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	var out []map[string]any
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}
		role, _ := raw["role"].(string)
		if role == "" {
			role, _ = raw["type"].(string)
		}
		if role == "" {
			continue
		}
		content := extractContent(raw)
		if content == "" {
			continue
		}
		out = append(out, map[string]any{"role": role, "content": content})
	}
	return out, nil
}

func extractContent(raw map[string]any) string {
	if c, ok := raw["content"].(string); ok {
		return c
	}
	if c, ok := raw["text"].(string); ok {
		return c
	}
	if arr, ok := raw["content"].([]any); ok {
		var parts []string
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := m["text"].(string); ok {
				parts = append(parts, t)
			}
		}
		out := ""
		for _, p := range parts {
			if p == "" {
				continue
			}
			if out != "" {
				out += "\n"
			}
			out += p
		}
		return out
	}
	return ""
}

// HTTPClient implements Client by calling the cloud HTTP API directly.
// Used by the `klio backfill` CLI.
type HTTPClient struct {
	baseURL     string
	accessToken string
	http        *http.Client
}

// NewHTTPClient returns an HTTP-backed Client.
func NewHTTPClient(baseURL, accessToken string) *HTTPClient {
	return &HTTPClient{
		baseURL:     strings.TrimRight(baseURL, "/"),
		accessToken: accessToken,
		http:        &http.Client{},
	}
}

// EnsureSpace finds an existing space by slug, or creates one.
func (c *HTTPClient) EnsureSpace(ctx context.Context, slug, name string) (uuid.UUID, error) {
	// List + match by slug.
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/v1/spaces", nil)
	if err != nil {
		return uuid.Nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	resp, err := c.http.Do(req)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return uuid.Nil, fmt.Errorf("list spaces: %d", resp.StatusCode)
	}
	var spaces []struct {
		ID   uuid.UUID `json:"id"`
		Slug string    `json:"slug"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&spaces); err != nil {
		return uuid.Nil, err
	}
	for _, s := range spaces {
		if s.Slug == slug {
			return s.ID, nil
		}
	}
	// Create.
	body, _ := json.Marshal(map[string]string{"name": name, "slug": slug})
	req, err = http.NewRequestWithContext(
		ctx, "POST", c.baseURL+"/v1/spaces", strings.NewReader(string(body)),
	)
	if err != nil {
		return uuid.Nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	resp, err = c.http.Do(req)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		return uuid.Nil, fmt.Errorf("create space: %d", resp.StatusCode)
	}
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		return uuid.Nil, err
	}
	return created.ID, nil
}

// IngestTranscript posts to /v1/spaces/{id}/ingest/transcript.
func (c *HTTPClient) IngestTranscript(
	ctx context.Context,
	spaceID uuid.UUID,
	sessionID string,
	messages []map[string]any,
) (map[string]any, error) {
	body, _ := json.Marshal(map[string]any{
		"session_id":  uuid.NewSHA1(uuid.NameSpaceURL, []byte(sessionID)).String(),
		"source_type": "claude-code-session-backfill",
		"messages":    messages,
	})
	req, err := http.NewRequestWithContext(
		ctx, "POST",
		c.baseURL+"/v1/spaces/"+spaceID.String()+"/ingest/transcript",
		strings.NewReader(string(body)),
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		bodyText := readAll(resp)
		return nil, fmt.Errorf("ingest: %d %s", resp.StatusCode, bodyText)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func readAll(resp *http.Response) string {
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

var _ = url.PathEscape
