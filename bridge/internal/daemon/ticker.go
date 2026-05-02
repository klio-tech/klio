package daemon

import "time"

// minTicker wraps time.Ticker behind a tiny interface so tests can stub.
type minTicker interface {
	tick() <-chan time.Time
	stop()
}

type realTicker struct{ t *time.Ticker }

func (r *realTicker) tick() <-chan time.Time { return r.t.C }
func (r *realTicker) stop()                  { r.t.Stop() }

// newTicker returns a real ticker that fires every `seconds` seconds.
func newTicker(seconds int) minTicker {
	return &realTicker{t: time.NewTicker(time.Duration(seconds) * time.Second)}
}
