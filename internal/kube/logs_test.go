package kube

import (
	"context"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"github.com/bexxmodd/kube-kvleva/internal/config"
	"github.com/bexxmodd/kube-kvleva/internal/podlogs"
)

// logServer stands in for the API server of a cluster whose pod logs are
// read. It records the requests for logs and answers them with respond.
type logServer struct {
	*httptest.Server

	mu       sync.Mutex
	requests []*http.Request
	respond  func(w http.ResponseWriter, r *http.Request)
}

func newLogServer(t *testing.T, respond func(w http.ResponseWriter, r *http.Request)) *logServer {
	t.Helper()
	api := &logServer{respond: respond}
	// TLS, like a real cluster: credentials are only ever sent over a
	// protected connection.
	api.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/version" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"major": "1", "minor": "35", "gitVersion": "v1.35.0"}`)
			return
		}
		api.mu.Lock()
		api.requests = append(api.requests, r.Clone(context.Background()))
		api.mu.Unlock()
		api.respond(w, r)
	}))
	t.Cleanup(api.Close)
	return api
}

func (a *logServer) received() []*http.Request {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]*http.Request(nil), a.requests...)
}

// connect opens a client for the cluster served by api, trusting its
// certificate and authenticating with a token.
func connect(t *testing.T, api *logServer) *Client {
	t.Helper()
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: api.Certificate().Raw})
	content := fmt.Sprintf(`
apiVersion: v1
kind: Config
current-context: test-cluster
clusters:
- name: test-cluster
  cluster: {server: %q, certificate-authority-data: %q}
users:
- name: tester
  user: {token: test-token}
contexts:
- name: test-cluster
  context: {cluster: test-cluster, user: tester}
`, api.URL, base64.StdEncoding.EncodeToString(certificate))
	path := filepath.Join(t.TempDir(), "kubeconfig")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing kubeconfig: %v", err)
	}
	client, err := Connect(t.Context(), config.Cluster{Kubeconfig: path})
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	return client
}

func TestLogsReadsTheLogOfAContainer(t *testing.T) {
	const written = "2026-11-15T18:00:01Z starting\n2026-11-15T18:00:02Z listening on :80\n"
	tests := []struct {
		name      string
		req       podlogs.Request
		wantPath  string
		wantQuery url.Values
	}{
		{
			name: "most_recent_lines_then_follow",
			req: podlogs.Request{
				Source:    podlogs.Source{Namespace: "default", Pod: "web-1", Container: "app"},
				TailLines: 50,
			},
			wantPath: "/api/v1/namespaces/default/pods/web-1/log",
			wantQuery: url.Values{
				"container": {"app"}, "follow": {"true"}, "timestamps": {"true"}, "tailLines": {"50"},
			},
		},
		{
			name: "from_a_point_in_time_on",
			req: podlogs.Request{
				Source: podlogs.Source{Namespace: "shop", Pod: "cart-0", Container: "sidecar"},
				// The cluster takes whole seconds; the earlier second keeps
				// every line the caller has not seen.
				Since: time.Date(2026, 11, 15, 18, 0, 2, 750000000, time.UTC),
			},
			wantPath: "/api/v1/namespaces/shop/pods/cart-0/log",
			wantQuery: url.Values{
				"container": {"sidecar"}, "follow": {"true"}, "timestamps": {"true"},
				"sinceTime": {"2026-11-15T18:00:02Z"},
			},
		},
		{
			name: "names_cannot_reach_another_path",
			req: podlogs.Request{
				Source:    podlogs.Source{Namespace: "default", Pod: "../../secrets", Container: "app"},
				TailLines: 10,
			},
			wantPath: "/api/v1/namespaces/default/pods/..%2F..%2Fsecrets/log",
			wantQuery: url.Values{
				"container": {"app"}, "follow": {"true"}, "timestamps": {"true"}, "tailLines": {"10"},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			api := newLogServer(t, func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, written)
			})
			client := connect(t, api)

			stream, err := client.Logs(t.Context(), tc.req)
			if err != nil {
				t.Fatalf("Logs(%+v) failed: %v", tc.req, err)
			}
			defer stream.Close()
			got, err := io.ReadAll(stream)
			if err != nil {
				t.Fatalf("reading the stream of Logs(%+v) failed: %v", tc.req, err)
			}
			if string(got) != written {
				t.Errorf("Logs(%+v) delivered %q, want %q", tc.req, got, written)
			}

			requests := api.received()
			if len(requests) != 1 {
				t.Fatalf("Logs(%+v) sent %d requests to the cluster, want 1", tc.req, len(requests))
			}
			sent := requests[0]
			if sent.Method != http.MethodGet {
				t.Errorf("Logs(%+v) sent a %s request, want GET: reading logs must stay a read", tc.req, sent.Method)
			}
			if got := sent.URL.EscapedPath(); got != tc.wantPath {
				t.Errorf("Logs(%+v) requested path %q, want %q", tc.req, got, tc.wantPath)
			}
			if diff := cmp.Diff(tc.wantQuery, sent.URL.Query()); diff != "" {
				t.Errorf("Logs(%+v) query diff (-want +got):\n%s", tc.req, diff)
			}
			if got := sent.Header.Get("Authorization"); got != "Bearer test-token" {
				t.Errorf("Logs(%+v) sent Authorization %q, want the credentials of the kubeconfig", tc.req, got)
			}
			if sent.Header.Get("Upgrade") != "" {
				t.Errorf("Logs(%+v) asked for a connection upgrade, want a plain request", tc.req)
			}
		})
	}
}

func TestLogsReportsWhyTheClusterRefused(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		contentType string
		body        string
		wantErr     string
	}{
		{
			name:        "status_object_carries_the_reason",
			status:      http.StatusBadRequest,
			contentType: "application/json",
			body:        `{"kind": "Status", "status": "Failure", "message": "container \"app\" in pod \"web-1\" is waiting to start: ContainerCreating", "code": 400}`,
			wantErr:     `container "app" in pod "web-1" is waiting to start: ContainerCreating`,
		},
		{
			name:        "forbidden",
			status:      http.StatusForbidden,
			contentType: "application/json",
			body:        `{"kind": "Status", "message": "pods \"web-1\" is forbidden: User \"viewer\" cannot get resource \"pods/log\"", "code": 403}`,
			wantErr:     `pods "web-1" is forbidden: User "viewer" cannot get resource "pods/log"`,
		},
		{
			name:        "answer_without_a_reason",
			status:      http.StatusBadGateway,
			contentType: "text/html",
			body:        "<html>upstream down</html>",
			wantErr:     "the cluster answered 502 Bad Gateway",
		},
	}
	req := podlogs.Request{Source: podlogs.Source{Namespace: "default", Pod: "web-1", Container: "app"}, TailLines: 10}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			api := newLogServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			})
			client := connect(t, api)

			stream, err := client.Logs(t.Context(), req)
			if err == nil {
				stream.Close()
				t.Fatalf("Logs(%+v) succeeded although the cluster answered %d, want an error", req, tc.status)
			}
			if err.Error() != tc.wantErr {
				t.Errorf("Logs(%+v) error = %q, want %q", req, err, tc.wantErr)
			}
		})
	}
}

func TestLogsStreamEndsWithItsContext(t *testing.T) {
	api := newLogServer(t, func(w http.ResponseWriter, r *http.Request) {
		// A followed log stays open until the reader goes away.
		fmt.Fprintln(w, "2026-11-15T18:00:01Z first line")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	client := connect(t, api)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req := podlogs.Request{Source: podlogs.Source{Namespace: "default", Pod: "web-1", Container: "app"}, TailLines: 10}

	stream, err := client.Logs(ctx, req)
	if err != nil {
		t.Fatalf("Logs(%+v) failed: %v", req, err)
	}
	defer stream.Close()
	first := make([]byte, len("2026-11-15T18:00:01Z first line\n"))
	if _, err := io.ReadFull(stream, first); err != nil {
		t.Fatalf("reading the first line of Logs(%+v) failed: %v", req, err)
	}
	if !strings.HasSuffix(string(first), "first line\n") {
		t.Fatalf("Logs(%+v) delivered %q first, want the first line", req, first)
	}

	cancel()

	// The read returns instead of waiting for a line that never comes.
	if _, err := io.ReadAll(stream); err == nil {
		t.Errorf("reading Logs(%+v) after its context ended succeeded, want an error", req)
	}
}
