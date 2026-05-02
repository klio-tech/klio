package realtime

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const testRedisURL = "redis://127.0.0.1:6380/0"

func dial(t *testing.T) *redis.Client {
	t.Helper()
	opts, err := redis.ParseURL(testRedisURL)
	if err != nil {
		t.Fatalf("ParseURL: %v", err)
	}
	c := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	if err := c.Ping(ctx).Err(); err != nil {
		t.Skipf("redis not reachable at %s: %v", testRedisURL, err)
	}
	return c
}

func TestSubscribeAndReceiveFrame(t *testing.T) {
	publisher := dial(t)
	defer publisher.Close()

	sub, err := NewSubscriber(testRedisURL)
	if err != nil {
		t.Fatalf("NewSubscriber: %v", err)
	}
	defer sub.Close()

	spaceID := uuid.New()
	got := make(chan Frame, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := sub.Subscribe(ctx, spaceID, func(f Frame) { got <- f }); err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	frame := Frame{
		Type:    "entry.created",
		SpaceID: spaceID.String(),
		FrameID: "f-1",
		Entry:   map[string]any{"content": "hello"},
	}
	body, _ := json.Marshal(frame)
	if err := publisher.Publish(ctx, "space:"+spaceID.String(), body).Err(); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	select {
	case f := <-got:
		if f.Type != "entry.created" {
			t.Fatalf("Type = %s", f.Type)
		}
		if f.FrameID != "f-1" {
			t.Fatalf("FrameID = %s", f.FrameID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive frame within 2s")
	}
}

func TestUnsubscribe(t *testing.T) {
	publisher := dial(t)
	defer publisher.Close()
	sub, _ := NewSubscriber(testRedisURL)
	defer sub.Close()

	spaceID := uuid.New()
	got := make(chan Frame, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = sub.Subscribe(ctx, spaceID, func(f Frame) { got <- f })

	sub.Unsubscribe(spaceID)
	time.Sleep(50 * time.Millisecond)

	body, _ := json.Marshal(Frame{Type: "entry.created", SpaceID: spaceID.String()})
	_ = publisher.Publish(ctx, "space:"+spaceID.String(), body).Err()

	select {
	case <-got:
		t.Fatal("received frame after unsubscribe")
	case <-time.After(300 * time.Millisecond):
		// expected — no frame after unsubscribe
	}
}
