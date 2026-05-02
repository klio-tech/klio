// Command realtime_e2e is a developer-only smoke test: subscribes to a
// space's Redis channel, prints the first frame that arrives, exits.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/realtime"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: realtime_e2e <space_uuid>")
		os.Exit(2)
	}
	spaceID := uuid.MustParse(os.Args[1])
	sub, err := realtime.NewSubscriber("redis://127.0.0.1:6380/0")
	if err != nil {
		fmt.Println("ERR:", err)
		os.Exit(1)
	}
	defer sub.Close()

	got := make(chan realtime.Frame, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = sub.Subscribe(ctx, spaceID, func(f realtime.Frame) { got <- f })

	fmt.Println("READY")
	select {
	case f := <-got:
		body, _ := json.Marshal(f)
		fmt.Println("FRAME:", string(body))
	case <-time.After(10 * time.Second):
		fmt.Println("TIMEOUT")
		os.Exit(1)
	}
}
