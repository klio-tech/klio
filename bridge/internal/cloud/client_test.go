package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestProvisionCallsExpectedEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/users/provision" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("wrong method: %s", r.Method)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["agent_kind"] != "klio-bridge" {
			t.Errorf("wrong agent_kind: %v", body["agent_kind"])
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":          uuid.New().String(),
			"agent_id":         uuid.New().String(),
			"api_key":          "rt_" + strings.Repeat("x", 40),
			"claimed":          false,
			"default_space_id": uuid.New().String(),
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	resp, err := c.Provision(context.Background(), ProvisionRequest{
		AgentKind: "klio-bridge", InstallID: uuid.New(),
	})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if resp.APIKey == "" {
		t.Fatal("APIKey empty")
	}
}

func TestRefreshAccessTokenRetriesOn401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/spaces" && r.Header.Get("Authorization") != "Bearer fresh-access" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/tokens/refresh" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "fresh-access", "refresh_token": "new-refresh", "expires_in": 3600,
			})
			return
		}
		w.WriteHeader(200)
		_ = json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetRefreshToken("old-refresh")
	c.SetAccessToken("expired-access")

	if _, err := c.ListSpaces(context.Background()); err != nil {
		t.Fatalf("ListSpaces should retry on 401: %v", err)
	}
	if c.AccessToken() != "fresh-access" {
		t.Fatalf("access token not refreshed: %s", c.AccessToken())
	}
}

func TestNoRefreshTokenFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("expired")
	_, err := c.ListSpaces(context.Background())
	if err == nil {
		t.Fatal("expected error when no refresh token")
	}
}
