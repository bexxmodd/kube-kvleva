package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/google/go-cmp/cmp"
	"sigs.k8s.io/yaml"

	"github.com/bexxmodd/kube-kvleva/internal/graph"
	"github.com/bexxmodd/kube-kvleva/internal/kube"
)

const (
	podManifest = `
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: web, uid: pod-web, resourceVersion: "1"}
spec:
  initContainers:
  - {name: setup, image: "busybox:1.36"}
  containers:
  - {name: app, image: "nginx:1.27"}
status:
  phase: Running
  conditions:
  - {type: Ready, status: "True"}
  initContainerStatuses:
  - {name: setup, ready: true, state: {terminated: {exitCode: 0, reason: Completed}}}
  containerStatuses:
  - {name: app, ready: true, state: {running: {}}}
`
	failedPodManifest = `
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: broken, uid: pod-broken, resourceVersion: "1"}
status: {phase: Failed}
`
	configMapManifest = `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: settings, uid: configmap-settings, resourceVersion: "1"}
`
	nodeManifest = `
apiVersion: v1
kind: Node
metadata: {name: worker-1, uid: node-worker-1, resourceVersion: "1"}
status: {conditions: [{type: Ready, status: "True"}]}
`
	storageClassManifest = `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: fast, uid: storageclass-fast, resourceVersion: "1"}
`
)

// newStore returns a store holding the given manifests.
func newStore(t *testing.T, manifests ...string) *graph.Store {
	t.Helper()
	store := graph.New()
	for _, manifest := range manifests {
		var obj map[string]any
		if err := yaml.Unmarshal([]byte(manifest), &obj); err != nil {
			t.Fatalf("parsing test manifest: %v\n%s", err, manifest)
		}
		apiVersion, _ := obj["apiVersion"].(string)
		group, version, found := strings.Cut(apiVersion, "/")
		if !found {
			group, version = "", apiVersion
		}
		kindName, _ := obj["kind"].(string)
		_, namespaced := obj["metadata"].(map[string]any)["namespace"]
		kind := graph.Kind{Group: group, Version: version, Kind: kindName, Namespaced: namespaced}
		if err := store.Upsert(kind, obj); err != nil {
			t.Fatalf("storing test manifest: %v\n%s", err, manifest)
		}
	}
	return store
}

// fakeEvents stands in for the cluster's event log.
type fakeEvents struct {
	events []kube.Event
	err    error
	// namespace and uid record what was asked for last.
	namespace, uid string
}

func (f *fakeEvents) Events(_ context.Context, namespace, uid string) ([]kube.Event, error) {
	f.namespace, f.uid = namespace, uid
	return f.events, f.err
}

var testAssets = fstest.MapFS{
	"index.html": {Data: []byte("<!doctype html><title>kvleva</title>")},
	"js/main.js": {Data: []byte("console.log('kvleva');")},
}

func newHandler(store *graph.Store, events EventLister) http.Handler {
	return New(Options{
		Cluster: kube.Info{Name: "kind-kvleva", Server: "https://127.0.0.1:6443", Version: "v1.35.0"},
		Store:   store,
		Events:  events,
		Assets:  testAssets,
	})
}

// localRequest builds a request the way a browser on the same machine sends
// it.
func localRequest(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.RemoteAddr = "127.0.0.1:54321"
	req.Host = "localhost:8080"
	return req
}

// serve runs one request through handler.
func serve(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestServesLocalBrowser(t *testing.T) {
	handler := newHandler(graph.New(), nil)
	tests := []struct {
		name            string
		target          string
		wantBody        string
		wantContentType string
	}{
		{name: "page", target: "/", wantBody: "<!doctype html><title>kvleva</title>", wantContentType: "text/html"},
		{name: "script", target: "/js/main.js", wantBody: "console.log('kvleva');", wantContentType: "text/javascript"},
		{name: "liveness", target: "/healthz", wantBody: "ok\n", wantContentType: "text/plain"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(handler, localRequest(http.MethodGet, tc.target))
			if rec.Code != http.StatusOK || rec.Body.String() != tc.wantBody {
				t.Errorf("GET %s = %d %q, want 200 %q", tc.target, rec.Code, rec.Body.String(), tc.wantBody)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, tc.wantContentType) {
				t.Errorf("GET %s Content-Type = %q, want %q", tc.target, got, tc.wantContentType)
			}
		})
	}
}

func TestRefusesRequestsThatAreNotLocal(t *testing.T) {
	handler := newHandler(graph.New(), nil)
	tests := []struct {
		name       string
		remoteAddr string
		host       string
		header     http.Header
		wantStatus int
	}{
		{name: "local_browser", remoteAddr: "127.0.0.1:54321", host: "localhost:8080", wantStatus: http.StatusOK},
		{name: "local_browser_by_ipv4", remoteAddr: "127.0.0.1:54321", host: "127.0.0.1:8080", wantStatus: http.StatusOK},
		{name: "local_browser_by_ipv6", remoteAddr: "[::1]:54321", host: "[::1]:8080", wantStatus: http.StatusOK},
		{name: "local_browser_without_port", remoteAddr: "127.0.0.1:54321", host: "localhost", wantStatus: http.StatusOK},
		{name: "another_machine", remoteAddr: "192.168.1.20:54321", host: "localhost:8080", wantStatus: http.StatusForbidden},
		{name: "another_machine_by_ipv6", remoteAddr: "[2001:db8::1]:54321", host: "localhost:8080", wantStatus: http.StatusForbidden},
		{name: "unparsable_remote_address", remoteAddr: "somewhere", host: "localhost:8080", wantStatus: http.StatusForbidden},
		{name: "non_local_host_name", remoteAddr: "127.0.0.1:54321", host: "kvleva.example.com", wantStatus: http.StatusForbidden},
		{name: "host_name_that_only_starts_local", remoteAddr: "127.0.0.1:54321", host: "localhost.example.com:8080", wantStatus: http.StatusForbidden},
		{name: "machine_host_name", remoteAddr: "127.0.0.1:54321", host: "workstation.corp.example:8080", wantStatus: http.StatusForbidden},
		{name: "lan_address_as_host", remoteAddr: "127.0.0.1:54321", host: "192.168.1.5:8080", wantStatus: http.StatusForbidden},
		{name: "empty_host", remoteAddr: "127.0.0.1:54321", host: "", wantStatus: http.StatusForbidden},
		{
			name:       "same_origin_script",
			remoteAddr: "127.0.0.1:54321",
			host:       "localhost:8080",
			header:     http.Header{"Origin": {"http://localhost:8080"}, "Sec-Fetch-Site": {"same-origin"}},
			wantStatus: http.StatusOK,
		},
		{
			name:       "another_website",
			remoteAddr: "127.0.0.1:54321",
			host:       "localhost:8080",
			header:     http.Header{"Origin": {"https://evil.example"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "another_local_application",
			remoteAddr: "127.0.0.1:54321",
			host:       "localhost:8080",
			header:     http.Header{"Origin": {"http://localhost:3000"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "opaque_origin",
			remoteAddr: "127.0.0.1:54321",
			host:       "localhost:8080",
			header:     http.Header{"Origin": {"null"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "cross_site_request_without_origin",
			remoteAddr: "127.0.0.1:54321",
			host:       "localhost:8080",
			header:     http.Header{"Sec-Fetch-Site": {"cross-site"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "typed_into_the_address_bar",
			remoteAddr: "127.0.0.1:54321",
			host:       "localhost:8080",
			header:     http.Header{"Sec-Fetch-Site": {"none"}},
			wantStatus: http.StatusOK,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/overview", nil)
			req.RemoteAddr = tc.remoteAddr
			req.Host = tc.host
			for key, values := range tc.header {
				req.Header[key] = values
			}
			rec := serve(handler, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("GET /api/overview from %s as host %q with %v = %d, want %d", tc.remoteAddr, tc.host, tc.header, rec.Code, tc.wantStatus)
			}
		})
	}
}

func TestRejectsModifyingRequests(t *testing.T) {
	handler := newHandler(newStore(t, podManifest), nil)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		for _, target := range []string{"/", "/api/overview", "/api/resources/pod-web"} {
			t.Run(method+"_"+strings.ReplaceAll(strings.Trim(target, "/"), "/", "_"), func(t *testing.T) {
				rec := serve(handler, localRequest(method, target))
				if rec.Code != http.StatusMethodNotAllowed {
					t.Errorf("%s %s = %d, want %d", method, target, rec.Code, http.StatusMethodNotAllowed)
				}
			})
		}
	}
}

func TestSendsSecurityHeaders(t *testing.T) {
	rec := serve(newHandler(graph.New(), nil), localRequest(http.MethodGet, "/"))
	want := map[string]string{
		"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Referrer-Policy":         "no-referrer",
	}
	for header, wantValue := range want {
		if got := rec.Header().Get(header); got != wantValue {
			t.Errorf("GET / header %s = %q, want %q", header, got, wantValue)
		}
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("GET / header Access-Control-Allow-Origin = %q, want it absent", got)
	}
}

func TestOverview(t *testing.T) {
	store := newStore(t, podManifest, failedPodManifest, nodeManifest)
	rec := serve(newHandler(store, nil), localRequest(http.MethodGet, "/api/overview"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/overview = %d %s, want 200", rec.Code, rec.Body)
	}
	var got struct {
		Cluster    kube.Info    `json:"cluster"`
		Health     graph.Rollup `json:"health"`
		Namespaces []struct {
			Name string `json:"name"`
		} `json:"namespaces"`
		Nodes graph.Area `json:"nodes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET /api/overview returned unreadable JSON: %v\n%s", err, rec.Body)
	}
	if want := (kube.Info{Name: "kind-kvleva", Server: "https://127.0.0.1:6443", Version: "v1.35.0"}); got.Cluster != want {
		t.Errorf("GET /api/overview cluster = %+v, want %+v", got.Cluster, want)
	}
	if want := (graph.Rollup{Green: 2, Red: 1}); got.Health != want {
		t.Errorf("GET /api/overview health = %+v, want %+v", got.Health, want)
	}
	if len(got.Namespaces) != 1 || got.Namespaces[0].Name != "default" {
		t.Errorf("GET /api/overview namespaces = %+v, want only default", got.Namespaces)
	}
	if want := (graph.Area{Count: 1, Rollup: graph.Rollup{Green: 1}}); got.Nodes != want {
		t.Errorf("GET /api/overview nodes = %+v, want %+v", got.Nodes, want)
	}
}

func TestListResources(t *testing.T) {
	store := newStore(t, podManifest, failedPodManifest, configMapManifest, nodeManifest, storageClassManifest, `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: owned
  uid: pod-owned
  resourceVersion: "1"
  ownerReferences:
  - {apiVersion: v1, kind: Pod, name: web, uid: pod-web, controller: true}
spec: {nodeName: worker-1}
status: {phase: Running, conditions: [{type: Ready, status: "True"}]}
`)
	handler := newHandler(store, nil)
	tests := []struct {
		name      string
		target    string
		want      []string
		wantTotal int
	}{
		{
			name:      "namespace",
			target:    "/api/resources?namespace=default",
			want:      []string{"Pod/broken", "Pod/web", "ConfigMap/settings"},
			wantTotal: 3,
		},
		{name: "cluster_wide", target: "/api/resources?cluster=true", want: []string{"StorageClass/fast"}, wantTotal: 1},
		{name: "nodes", target: "/api/resources?nodes=true", want: []string{"Node/worker-1"}, wantTotal: 1},
		{name: "children", target: "/api/resources?parent=pod-web", want: []string{"Pod/owned"}, wantTotal: 1},
		{name: "pods_on_node", target: "/api/resources?node=worker-1", want: []string{"Pod/owned"}, wantTotal: 1},
		{
			name:      "everything",
			target:    "/api/resources",
			want:      []string{"Node/worker-1", "Pod/broken", "Pod/owned", "Pod/web", "ConfigMap/settings", "StorageClass/fast"},
			wantTotal: 6,
		},
		{
			name:      "hidden_kinds",
			target:    "/api/resources?namespace=default&hideKinds=core/ConfigMap,core/Secret",
			want:      []string{"Pod/broken", "Pod/web"},
			wantTotal: 2,
		},
		{name: "health", target: "/api/resources?namespace=default&health=red,yellow", want: []string{"Pod/broken"}, wantTotal: 1},
		{name: "search", target: "/api/resources?namespace=default&q=SETT", want: []string{"ConfigMap/settings"}, wantTotal: 1},
		{name: "page", target: "/api/resources?namespace=default&limit=1&offset=1", want: []string{"Pod/web"}, wantTotal: 3},
		{name: "no_match_is_an_empty_list", target: "/api/resources?namespace=nowhere", want: []string{}, wantTotal: 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(handler, localRequest(http.MethodGet, tc.target))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d %s, want 200", tc.target, rec.Code, rec.Body)
			}
			var page struct {
				// Items must be a JSON array even when empty, so it is
				// decoded as raw JSON first.
				Items json.RawMessage `json:"items"`
				Total int             `json:"total"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
				t.Fatalf("GET %s returned unreadable JSON: %v\n%s", tc.target, err, rec.Body)
			}
			var items []graph.Summary
			if err := json.Unmarshal(page.Items, &items); err != nil || !strings.HasPrefix(string(page.Items), "[") {
				t.Fatalf("GET %s items = %s, want a JSON array (%v)", tc.target, page.Items, err)
			}
			got := []string{}
			for _, item := range items {
				got = append(got, item.Kind+"/"+item.Name)
			}
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("GET %s items diff (-want +got):\n%s", tc.target, diff)
			}
			if page.Total != tc.wantTotal {
				t.Errorf("GET %s total = %d, want %d", tc.target, page.Total, tc.wantTotal)
			}
		})
	}
}

func TestListResourcesRejectsBadParameters(t *testing.T) {
	handler := newHandler(newStore(t, podManifest), nil)
	targets := []string{
		"/api/resources?namespace=default&cluster=true",
		"/api/resources?parent=pod-web&node=worker-1",
		"/api/resources?limit=many",
		"/api/resources?limit=-1",
		"/api/resources?offset=-5",
		"/api/resources?health=purple",
		"/api/resources?cluster=maybe",
	}
	for _, target := range targets {
		t.Run(strings.TrimPrefix(target, "/api/resources?"), func(t *testing.T) {
			rec := serve(handler, localRequest(http.MethodGet, target))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("GET %s = %d %s, want %d", target, rec.Code, rec.Body, http.StatusBadRequest)
			}
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error == "" {
				t.Errorf("GET %s body = %s, want a JSON error message", target, rec.Body)
			}
		})
	}
}

func TestResourceDetailIncludesEvents(t *testing.T) {
	events := &fakeEvents{events: []kube.Event{
		{Type: "Warning", Reason: "BackOff", Message: "Back-off restarting failed container", Count: 7, LastSeen: "2026-11-14T17:05:00Z", Source: "kubelet"},
	}}
	handler := newHandler(newStore(t, podManifest), events)

	rec := serve(handler, localRequest(http.MethodGet, "/api/resources/pod-web"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/resources/pod-web = %d %s, want 200", rec.Code, rec.Body)
	}
	var got struct {
		Summary     graph.Summary `json:"summary"`
		YAML        string        `json:"yaml"`
		StatusYAML  string        `json:"statusYaml"`
		Events      []kube.Event  `json:"events"`
		EventsError string        `json:"eventsError"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET /api/resources/pod-web returned unreadable JSON: %v\n%s", err, rec.Body)
	}
	if got.Summary.UID != "pod-web" || !strings.Contains(got.YAML, "kind: Pod") || !strings.Contains(got.StatusYAML, "phase: Running") {
		t.Errorf("GET /api/resources/pod-web = uid %q, yaml %q, status %q; want the pod with its manifest and status", got.Summary.UID, got.YAML, got.StatusYAML)
	}
	if diff := cmp.Diff(events.events, got.Events); diff != "" || got.EventsError != "" {
		t.Errorf("GET /api/resources/pod-web events diff (-want +got):\n%s\neventsError = %q, want none", diff, got.EventsError)
	}
	if events.namespace != "default" || events.uid != "pod-web" {
		t.Errorf("events were looked up for %s/%s, want default/pod-web", events.namespace, events.uid)
	}
}

func TestResourceDetailSurvivesUnavailableEvents(t *testing.T) {
	events := &fakeEvents{err: errors.New("events is forbidden")}
	handler := newHandler(newStore(t, podManifest), events)

	rec := serve(handler, localRequest(http.MethodGet, "/api/resources/pod-web"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/resources/pod-web = %d %s, want 200", rec.Code, rec.Body)
	}
	var got struct {
		YAML        string          `json:"yaml"`
		Events      json.RawMessage `json:"events"`
		EventsError string          `json:"eventsError"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET /api/resources/pod-web returned unreadable JSON: %v\n%s", err, rec.Body)
	}
	if !strings.Contains(got.YAML, "kind: Pod") {
		t.Errorf("GET /api/resources/pod-web yaml = %q, want the manifest despite the events failure", got.YAML)
	}
	if string(got.Events) != "[]" || !strings.Contains(got.EventsError, "events is forbidden") {
		t.Errorf("GET /api/resources/pod-web events = %s, eventsError = %q; want [] and the failure", got.Events, got.EventsError)
	}
}

func TestResourceDetailOfDeletedResource(t *testing.T) {
	handler := newHandler(newStore(t, podManifest), &fakeEvents{})
	for _, target := range []string{"/api/resources/no-such-uid", "/api/resources/no-such-uid/containers/app", "/api/resources/pod-web/containers/no-such-container"} {
		rec := serve(handler, localRequest(http.MethodGet, target))
		var body struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); rec.Code != http.StatusNotFound || err != nil || body.Error == "" {
			t.Errorf("GET %s = %d %s, want 404 with a JSON error message", target, rec.Code, rec.Body)
		}
	}
}

func TestContainerDetailShowsOnlyThatContainersEvents(t *testing.T) {
	events := &fakeEvents{events: []kube.Event{
		{Reason: "Started", FieldPath: "spec.containers{app}"},
		{Reason: "Pulled", FieldPath: "spec.initContainers{setup}"},
		{Reason: "Scheduled"},
	}}
	handler := newHandler(newStore(t, podManifest), events)
	tests := []struct {
		container  string
		wantReason string
		wantInit   bool
	}{
		{container: "app", wantReason: "Started"},
		{container: "setup", wantReason: "Pulled", wantInit: true},
	}
	for _, tc := range tests {
		t.Run(tc.container, func(t *testing.T) {
			target := "/api/resources/pod-web/containers/" + tc.container
			rec := serve(handler, localRequest(http.MethodGet, target))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d %s, want 200", target, rec.Code, rec.Body)
			}
			var got struct {
				Pod       graph.Summary   `json:"pod"`
				Container graph.Container `json:"container"`
				YAML      string          `json:"yaml"`
				Events    []kube.Event    `json:"events"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("GET %s returned unreadable JSON: %v\n%s", target, err, rec.Body)
			}
			if got.Pod.UID != "pod-web" || got.Container.Name != tc.container || got.Container.Init != tc.wantInit {
				t.Errorf("GET %s = pod %q, container %+v; want pod-web and container %q (init %t)", target, got.Pod.UID, got.Container, tc.container, tc.wantInit)
			}
			if !strings.Contains(got.YAML, "name: "+tc.container) {
				t.Errorf("GET %s yaml = %q, want the container's configuration", target, got.YAML)
			}
			if len(got.Events) != 1 || got.Events[0].Reason != tc.wantReason {
				t.Errorf("GET %s events = %+v, want only the %q event", target, got.Events, tc.wantReason)
			}
		})
	}
}

// streamEvent is one server-sent event.
type streamEvent struct {
	name string
	data string
}

// readEvent reads server-sent events from r until one carries data.
func readEvent(r *bufio.Reader) (streamEvent, error) {
	var event streamEvent
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return streamEvent{}, err
		}
		line = strings.TrimRight(line, "\n")
		switch {
		case strings.HasPrefix(line, "event: "):
			event.name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			event.data = strings.TrimPrefix(line, "data: ")
		case line == "" && event.data != "":
			return event, nil
		}
	}
}

// openStream connects to the change stream of a server over real HTTP.
func openStream(t *testing.T, store *graph.Store, opts Options) *bufio.Reader {
	t.Helper()
	opts.Store = store
	opts.Assets = testAssets
	srv := httptest.NewServer(New(opts))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/stream", nil)
	if err != nil {
		t.Fatalf("building stream request: %v", err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("opening stream: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if got := resp.Header.Get("Content-Type"); resp.StatusCode != http.StatusOK || got != "text/event-stream" {
		t.Fatalf("GET /api/stream = %d with Content-Type %q, want 200 text/event-stream", resp.StatusCode, got)
	}
	return bufio.NewReader(resp.Body)
}

func TestStreamAnnouncesChanges(t *testing.T) {
	store := newStore(t, configMapManifest)
	stream := openStream(t, store, Options{StreamInterval: time.Millisecond})

	first, err := readEvent(stream)
	if err != nil {
		t.Fatalf("reading the initial stream event: %v", err)
	}
	wantFirst := fmt.Sprintf(`{"revision":%d,"changed":[],"deleted":[],"overflow":false}`, store.Revision())
	if first.name != "change" || first.data != wantFirst {
		t.Errorf("initial stream event = %s %s, want change %s", first.name, first.data, wantFirst)
	}

	var pod map[string]any
	if err := yaml.Unmarshal([]byte(podManifest), &pod); err != nil {
		t.Fatalf("parsing test manifest: %v", err)
	}
	if err := store.Upsert(graph.Kind{Version: "v1", Kind: "Pod", Namespaced: true}, pod); err != nil {
		t.Fatalf("storing pod: %v", err)
	}
	store.Delete("configmap-settings")

	var got graph.Change
	// The two changes may arrive in one event or two; collect until both
	// are seen.
	for len(got.Changed) == 0 || len(got.Deleted) == 0 {
		event, err := readEvent(stream)
		if err != nil {
			t.Fatalf("reading stream event (so far %+v): %v", got, err)
		}
		var change graph.Change
		if err := json.Unmarshal([]byte(event.data), &change); err != nil {
			t.Fatalf("stream event %q is not JSON: %v", event.data, err)
		}
		got.Changed = append(got.Changed, change.Changed...)
		got.Deleted = append(got.Deleted, change.Deleted...)
		got.Revision = change.Revision
	}
	want := graph.Change{Revision: store.Revision(), Changed: []string{"pod-web"}, Deleted: []string{"configmap-settings"}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("stream changes diff (-want +got):\n%s", diff)
	}
}

func TestStreamCoalescesBursts(t *testing.T) {
	store := graph.New()
	configMaps := graph.Kind{Version: "v1", Kind: "ConfigMap", Namespaced: true}
	store.AddKind(configMaps)
	for i := range 600 {
		manifest := map[string]any{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata":   map[string]any{"namespace": "default", "name": fmt.Sprintf("cm-%d", i), "uid": fmt.Sprintf("uid-%d", i)},
		}
		if err := store.Upsert(configMaps, manifest); err != nil {
			t.Fatalf("storing config map: %v", err)
		}
	}
	stream := openStream(t, store, Options{StreamInterval: time.Millisecond})
	if _, err := readEvent(stream); err != nil {
		t.Fatalf("reading the initial stream event: %v", err)
	}

	// Dropping the resource type removes all 600 resources in one step, so
	// the stream sees the whole burst at once however the test is scheduled.
	store.RemoveKind(configMaps.ID())

	event, err := readEvent(stream)
	if err != nil {
		t.Fatalf("reading stream event: %v", err)
	}
	var change graph.Change
	if err := json.Unmarshal([]byte(event.data), &change); err != nil {
		t.Fatalf("stream event %q is not JSON: %v", event.data, err)
	}
	if !change.Overflow || len(change.Changed) != 0 || len(change.Deleted) != 0 {
		t.Errorf("stream event after 600 changes = %s, want one overflow event without uids", event.data)
	}
}

func TestStreamSendsHeartbeats(t *testing.T) {
	stream := openStream(t, graph.New(), Options{Heartbeat: 10 * time.Millisecond})
	for {
		line, err := stream.ReadString('\n')
		if err != nil {
			t.Fatalf("stream ended before a heartbeat arrived: %v", err)
		}
		if strings.HasPrefix(line, ":") {
			return
		}
	}
}

func TestCheckLoopback(t *testing.T) {
	tests := []struct {
		name    string
		addr    net.Addr
		wantErr bool
	}{
		{name: "ipv4_loopback", addr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8080}},
		{name: "ipv6_loopback", addr: &net.TCPAddr{IP: net.IPv6loopback, Port: 8080}},
		{name: "all_interfaces", addr: &net.TCPAddr{IP: net.IPv4zero, Port: 8080}, wantErr: true},
		{name: "lan_address", addr: &net.TCPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 8080}, wantErr: true},
		{name: "unix_socket", addr: &net.UnixAddr{Name: "/tmp/kvleva.sock", Net: "unix"}, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckLoopback(tc.addr)
			if (err != nil) != tc.wantErr {
				t.Errorf("CheckLoopback(%v) = %v, want error: %t", tc.addr, err, tc.wantErr)
			}
		})
	}
}
