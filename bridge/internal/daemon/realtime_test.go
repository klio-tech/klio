package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/realtime"
)

const testRedisURL = "redis://127.0.0.1:6380/0"

// TestDaemonReceivesRealtimeFrame:
//   - Brings up a fake cloud that returns one space.
//   - Constructs a Daemon configured with a Redis URL.
//   - Starts d.Run; expects subscribeAccessibleSpaces to enroll for the space.
//   - Publishes an entry.created frame on that space's channel via Redis.
//   - Asserts the daemon's frame handler fires with the expected payload.
func TestDaemonReceivesRealtimeFrame(t *testing.T) {
	if !redisReachable(t) {
		t.Skip("Redis at 127.0.0.1:6380 not reachable")
	}

	spaceID := uuid.New()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/spaces" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{
					"id":         spaceID.String(),
					"name":       "Default",
					"slug":       "default",
					"created_at": "2026-05-02T00:00:00Z",
				},
			})
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg := &config.Config{
		SocketPath:  filepath.Join(dir, "bridge.sock"),
		CloudURL:    srv.URL,
		RedisURL:    testRedisURL,
		LocalOnly:   false,
		CacheDBPath: filepath.Join(dir, "cache.db"),
	}

	d, err := New(cfg, makeKeys(t))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	var seen atomic.Int64
	gotFrame := make(chan realtime.Frame, 4)
	d.SetFrameHandler(func(f realtime.Frame) {
		seen.Add(1)
		select {
		case gotFrame <- f:
		default:
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer func() {
		if d.subscriber != nil {
			_ = d.subscriber.Close()
		}
	}()

	// Drive the subscription directly so the test isn't racing the
	// 5-minute periodic refresher that `Run` schedules.
	d.refreshSubscriptions(ctx)
	if got := d.SubscribedSpaces(); len(got) != 1 {
		t.Fatalf("expected daemon to subscribe to 1 space, got %d", len(got))
	}

	// Let Redis SUBACK settle on the daemon's go-redis pubsub channel.
	time.Sleep(300 * time.Millisecond)

	// Publish a frame on Redis.
	rdb := redis.NewClient(mustParseURL(t, testRedisURL))
	defer rdb.Close()
	frame := map[string]any{
		"type":     "entry.created",
		"space_id": spaceID.String(),
		"frame_id": "e2e-1",
		"entry": map[string]any{
			"id":       uuid.NewString(),
			"space_id": spaceID.String(),
			"agent_id": uuid.NewString(),
			"kind":     "memory",
			"content":  "Live realtime payload",
		},
	}
	body, _ := json.Marshal(frame)
	if err := rdb.Publish(ctx, "space:"+spaceID.String(), body).Err(); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	select {
	case f := <-gotFrame:
		if f.Type != "entry.created" {
			t.Fatalf("got type %s", f.Type)
		}
		if got, _ := f.Entry["content"].(string); got != "Live realtime payload" {
			t.Fatalf("payload: %s", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("no frame received (handler called %d times)", seen.Load())
	}
}

func redisReachable(t *testing.T) bool {
	t.Helper()
	rdb := redis.NewClient(mustParseURL(t, testRedisURL))
	defer rdb.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	return rdb.Ping(ctx).Err() == nil
}

func mustParseURL(t *testing.T, u string) *redis.Options {
	t.Helper()
	opts, err := redis.ParseURL(u)
	if err != nil {
		t.Fatalf("ParseURL: %v", err)
	}
	return opts
}
