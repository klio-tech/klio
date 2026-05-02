package version

import "testing"

func TestVersionIsSet(t *testing.T) {
	if Get() == "" {
		t.Fatal("version must not be empty")
	}
}

func TestSemverShape(t *testing.T) {
	v := Get()
	if len(v) < 5 {
		t.Fatalf("version %q too short", v)
	}
}
