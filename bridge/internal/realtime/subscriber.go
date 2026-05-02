// Package realtime is the daemon's pub/sub subscriber.
//
// In v0 we connect directly to Redis (acceptable for self-hosted and local
// dev). The cloud production path will route through klio-realtime over
// WebSocket — but the frame schema is identical, so the handler signature
// stays the same.
package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// Frame matches the engine's Redis publisher frame format.
type Frame struct {
	Type    string         `json:"type"`
	SpaceID string         `json:"space_id"`
	FrameID string         `json:"frame_id"`
	EntryID string         `json:"entry_id,omitempty"`
	Entry   map[string]any `json:"entry,omitempty"`
}

// FrameHandler is invoked for every received frame.
type FrameHandler func(frame Frame)

// Subscriber holds a Redis connection and a set of subscribed space ids.
type Subscriber struct {
	rdb       *redis.Client
	mu        sync.Mutex
	cancelMap map[uuid.UUID]context.CancelFunc
}

// NewSubscriber returns a Subscriber bound to the Redis URL (e.g.
// redis://localhost:6380/0).
func NewSubscriber(url string) (*Subscriber, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &Subscriber{
		rdb:       redis.NewClient(opts),
		cancelMap: map[uuid.UUID]context.CancelFunc{},
	}, nil
}

// Close stops all subscriptions and closes the underlying Redis client.
func (s *Subscriber) Close() error {
	s.mu.Lock()
	for _, cancel := range s.cancelMap {
		cancel()
	}
	s.cancelMap = map[uuid.UUID]context.CancelFunc{}
	s.mu.Unlock()
	return s.rdb.Close()
}

// Subscribe begins receiving frames for spaceID until ctx is canceled.
// Calls onFrame in a separate goroutine for each frame.
func (s *Subscriber) Subscribe(
	ctx context.Context, spaceID uuid.UUID, onFrame FrameHandler,
) error {
	subCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if existing, ok := s.cancelMap[spaceID]; ok {
		existing()
	}
	s.cancelMap[spaceID] = cancel
	s.mu.Unlock()

	channel := channelForSpace(spaceID)
	pubsub := s.rdb.Subscribe(subCtx, channel)

	go func() {
		defer func() { _ = pubsub.Close() }()
		ch := pubsub.Channel()
		for {
			select {
			case <-subCtx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var f Frame
				if err := json.Unmarshal([]byte(msg.Payload), &f); err != nil {
					continue
				}
				onFrame(f)
			}
		}
	}()
	// Give the subscription a moment to settle.
	time.Sleep(20 * time.Millisecond)
	return nil
}

// Unsubscribe stops the subscription for spaceID (if any).
func (s *Subscriber) Unsubscribe(spaceID uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel, ok := s.cancelMap[spaceID]; ok {
		cancel()
		delete(s.cancelMap, spaceID)
	}
}

func channelForSpace(id uuid.UUID) string {
	return fmt.Sprintf("space:%s", id)
}
