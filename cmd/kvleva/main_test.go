package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bexxmodd/kube-kvleva/internal/config"
)

// fakeCluster is a minimal Kubernetes API server: it serves discovery and
// two resource types, ConfigMaps and Secrets, each with one object. It
// records every request so tests can check what the app asked for.
type fakeCluster struct {
	*httptest.Server

	mu       sync.Mutex
	requests []string
}

func newFakeCluster(t *testing.T) *fakeCluster {
	t.Helper()
	cluster := &fakeCluster{}
	cluster.Server = httptest.NewServer(http.HandlerFunc(cluster.serve))
	t.Cleanup(cluster.Close)
	return cluster
}

func (c *fakeCluster) serve(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	c.requests = append(c.requests, r.Method+" "+r.URL.RequestURI())
	c.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/version":
		fmt.Fprint(w, `{"major": "1", "minor": "35", "gitVersion": "v1.35.0"}`)
	case "/api":
		fmt.Fprint(w, `{"kind": "APIVersions", "versions": ["v1"]}`)
	case "/apis":
		fmt.Fprint(w, `{"kind": "APIGroupList", "apiVersion": "v1", "groups": []}`)
	case "/api/v1":
		fmt.Fprint(w, `{"kind": "APIResourceList", "groupVersion": "v1", "resources": [
			{"name": "configmaps", "kind": "ConfigMap", "namespaced": true, "verbs": ["get", "list", "watch"]},
			{"name": "secrets", "kind": "Secret", "namespaced": true, "verbs": ["get", "list", "watch"]}
		]}`)
	case "/api/v1/configmaps":
		c.listOrWatch(w, r, "ConfigMap", "settings")
	case "/api/v1/secrets":
		c.listOrWatch(w, r, "Secret", "db")
	default:
		http.NotFound(w, r)
	}
}

// listOrWatch serves a resource type that has two objects, "<name>" and
// "<name>-2", the way an API server does:
//
//   - A list is paged when the client asks for a page size: the first page
//     holds the first object and a continue token for the second.
//   - A watch that asks for the initial state as events gets both objects
//     followed by the bookmark that ends the initial state.
//   - After that a watch stays open, silent, until the client goes away.
func (c *fakeCluster) listOrWatch(w http.ResponseWriter, r *http.Request, kind, name string) {
	object := func(name string) string {
		return fmt.Sprintf(`{"apiVersion": "v1", "kind": %q, "metadata": {"namespace": "default", "name": %q, "uid": %q, "resourceVersion": "5"}}`,
			kind, name, "uid-"+name)
	}
	first, second := object(name), object(name+"-2")
	query := r.URL.Query()
	if query.Get("watch") == "" {
		items, next := first+", "+second, ""
		switch {
		case query.Get("continue") == "page-2":
			items = second
		case query.Get("limit") != "":
			items, next = first, "page-2"
		}
		fmt.Fprintf(w, `{"apiVersion": "v1", "kind": "%sList", "metadata": {"resourceVersion": "10", "continue": %q}, "items": [%s]}`, kind, next, items)
		return
	}
	if query.Get("sendInitialEvents") == "true" {
		fmt.Fprintf(w, `{"type": "ADDED", "object": %s}`+"\n", first)
		fmt.Fprintf(w, `{"type": "ADDED", "object": %s}`+"\n", second)
		fmt.Fprintf(w, `{"type": "BOOKMARK", "object": {"apiVersion": "v1", "kind": %q, "metadata": {"resourceVersion": "10", "annotations": {"k8s.io/initial-events-end": "true"}}}}`+"\n", kind)
	}
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

func (c *fakeCluster) received() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.requests...)
}

// freePort returns a local TCP port that was free a moment ago.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("finding a free port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// writeFiles writes a kubeconfig for the fake cluster and a kvleva
// configuration that uses it, and returns the path of the latter.
func writeFiles(t *testing.T, clusterURL string, settings string) string {
	t.Helper()
	dir := t.TempDir()
	kubeconfig := filepath.Join(dir, "kubeconfig")
	kubeconfigContent := fmt.Sprintf(`
apiVersion: v1
kind: Config
current-context: decoy
clusters:
- name: kvleva
  cluster: {server: %q}
- name: decoy
  cluster: {server: "http://127.0.0.1:1"}
users:
- name: tester
  user: {token: test-token}
contexts:
- name: kind-kvleva
  context: {cluster: kvleva, user: tester}
- name: decoy
  context: {cluster: decoy, user: tester}
`, clusterURL)
	if err := os.WriteFile(kubeconfig, []byte(kubeconfigContent), 0o600); err != nil {
		t.Fatalf("writing kubeconfig: %v", err)
	}
	configPath := filepath.Join(dir, "kvleva.yaml")
	content := fmt.Sprintf("cluster:\n  kubeconfig: %s\n  context: kind-kvleva\n%s", kubeconfig, settings)
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatalf("writing configuration: %v", err)
	}
	return configPath
}

// get fetches a URL from the running app, returning the status code and
// body, or an error while the app is not answering yet.
func get(ctx context.Context, url string) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), err
}

// eventually polls cond until it holds or a generous deadline passes.
func eventually(cond func() bool) bool {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

func TestRunServesTheConfiguredClusterOnTheConfiguredPort(t *testing.T) {
	cluster := newFakeCluster(t)
	port := freePort(t)
	configPath := writeFiles(t, cluster.URL, fmt.Sprintf("listen:\n  port: %d\nresources:\n  exclude: [secrets]\n", port))
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() { result <- run(ctx, configPath) }()
	stopped := false
	t.Cleanup(func() {
		cancel()
		if !stopped {
			<-result
		}
	})

	// The cluster's resources become available in the web API.
	var listing string
	loaded := eventually(func() bool {
		status, body, err := get(ctx, base+"/api/resources?namespace=default")
		listing = body
		return err == nil && status == http.StatusOK && strings.Contains(body, `"name":"settings"`) && strings.Contains(body, `"name":"settings-2"`)
	})
	if !loaded {
		t.Fatalf("the cluster's config maps never appeared at %s; last listing: %s", base, listing)
	}
	if strings.Contains(listing, `"kind":"Secret"`) {
		t.Errorf("excluded secrets were loaded: %s", listing)
	}

	// Resource types are fetched page by page, so that a type with very
	// many objects is never held in memory as a whole.
	paged, continued := false, false
	for _, request := range cluster.received() {
		if !strings.HasPrefix(request, "GET /api/v1/configmaps?") || strings.Contains(request, "watch=") {
			continue
		}
		paged = paged || strings.Contains(request, "limit=")
		continued = continued || strings.Contains(request, "continue=page-2")
	}
	if !paged || !continued {
		t.Errorf("config maps were not listed in pages (page size requested: %t, second page requested: %t); requests: %v", paged, continued, cluster.received())
	}

	// The overview names the cluster chosen in the configuration.
	_, overviewBody, err := get(ctx, base+"/api/overview")
	if err != nil {
		t.Fatalf("GET /api/overview failed: %v", err)
	}
	var overview struct {
		Cluster struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"cluster"`
	}
	if err := json.Unmarshal([]byte(overviewBody), &overview); err != nil {
		t.Fatalf("GET /api/overview returned unreadable JSON: %v\n%s", err, overviewBody)
	}
	if overview.Cluster.Name != "kind-kvleva" || overview.Cluster.Version != "v1.35.0" {
		t.Errorf("GET /api/overview cluster = %+v, want kind-kvleva at v1.35.0", overview.Cluster)
	}

	// The web interface itself is served.
	status, page, err := get(ctx, base+"/")
	if err != nil || status != http.StatusOK || !strings.Contains(page, "<html") {
		t.Errorf("GET / = %d (%v), want the web interface; body: %.200s", status, err, page)
	}

	// Nothing but reads reached the cluster, and excluded types were not
	// requested at all.
	for _, request := range cluster.received() {
		if !strings.HasPrefix(request, "GET ") {
			t.Errorf("the cluster received %q, want only GET requests", request)
		}
		if strings.Contains(request, "secrets") {
			t.Errorf("the cluster received %q although secrets are excluded", request)
		}
	}

	// Stopping is clean.
	cancel()
	select {
	case err := <-result:
		stopped = true
		if err != nil {
			t.Errorf("run() returned %v after being stopped, want nil", err)
		}
	case <-time.After(20 * time.Second):
		t.Errorf("run() did not return within 20s of being stopped")
	}
}

func TestRunReportsStartupProblems(t *testing.T) {
	cluster := newFakeCluster(t)
	unreachable := newFakeCluster(t)
	unreachable.Close()
	missing := filepath.Join(t.TempDir(), "missing.yaml")
	tests := []struct {
		name       string
		configPath string
		wantErr    error
		// wantText must appear in the error shown to the operator.
		wantText string
	}{
		{
			name:       "missing_configuration_file",
			configPath: missing,
			wantErr:    fs.ErrNotExist,
			wantText:   missing,
		},
		{
			name:       "public_listen_address",
			configPath: writeFiles(t, cluster.URL, "listen:\n  address: 0.0.0.0\n"),
			wantErr:    config.ErrNotLoopback,
			wantText:   "0.0.0.0",
		},
		{
			name:       "unknown_setting",
			configPath: writeFiles(t, cluster.URL, "listen:\n  prot: 9090\n"),
			wantText:   "prot",
		},
		{
			name:       "unreachable_cluster",
			configPath: writeFiles(t, unreachable.URL, fmt.Sprintf("listen:\n  port: %d\n", freePort(t))),
			wantText:   "kind-kvleva",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := run(t.Context(), tc.configPath)
			if err == nil {
				t.Fatalf("run(%s) succeeded, want a startup error", tc.name)
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Errorf("run(%s) error = %v, want %v", tc.name, err, tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantText) {
				t.Errorf("run(%s) error = %q, want it to mention %q", tc.name, err, tc.wantText)
			}
		})
	}
}

func TestRunFailsWhenThePortIsTaken(t *testing.T) {
	cluster := newFakeCluster(t)
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupying a port: %v", err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port
	configPath := writeFiles(t, cluster.URL, fmt.Sprintf("listen:\n  port: %d\n", port))

	if err := run(t.Context(), configPath); err == nil {
		t.Errorf("run() with port %d already in use succeeded, want an error", port)
	}
}
